import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, X, ChevronRight, Volume2, VolumeX, Camera, CameraOff } from "lucide-react";
import { CALIBRATION_FRAMES, CALIBRATION_RESET_EPS, INTERSTITIAL_SEC } from "../domain/config";
import { summarizeCaptureQualityFromFeatures, summarizeSessionCaptureQuality } from "../domain/captureQuality";
import { SETUP_SAMPLE_TARGET, summarizeCaptureSetupQuality } from "../domain/captureSetupQuality";
import { exerciseHoldSec, exercisePlannedSec, exerciseRestSec, todayISO } from "../domain/session";
import { flushSpeech, primeSpeech, speak } from "../lib/speech";
import { useCameraStream } from "../hooks/useCameraStream";
import { useFaceLandmarker } from "../hooks/useFaceLandmarker";
import { CameraSetupStatusPanel, InterstitialView, PreviewView, RealtimeFeedback, SessionSummary, TrackerStatusPill } from "../components/appViews";
import { BROW_EXERCISES, EXERCISE_BLENDSHAPES, NOSE_EXERCISES, SCORE_DROP_REASONS, SCORING_MODEL_VERSION, averageBlendshapes, averageFacialTransformationMatrix, averageLandmarks, bsActivation, calibrationPrompt, captureSnapshot, computeBaselineProgress, computeBaselineProgressFromDisplacements, computeExerciseSymmetryDiagnostic, computeMovementProgressFromDisplacements, computeNoiseFloor, computeQuietRegionCoactivation, createLiveScoreStabilizer, drawOverlay, effectiveProfileThreshold, profileLiveScoringThreshold, faceAlignmentFeedback, firstFacialTransformationMatrix, getProfileExercise, normalizeScoringNoiseMode, normalizedFrameDelta, smoothFacialTransformationMatrix, smoothLandmarks, summarizeBaselineProgress, summarizeMovementProgress, summarizeRestingAsymmetry, summarizeSessionBaselineProgress, summarizeSessionMovementProgress } from "../ml/faceMetrics";

const TRACKING_ISSUES = {
  faceMissing: "Find your face in the camera.",
  alignment: "Center your face so Mirror can read this movement.",
};

function createHoldTracking(exerciseId = null, threshold = null) {
  return {
    exerciseId,
    faceFrames: 0,
    alignedFrames: 0,
    signalFrames: 0,
    activatedFrames: 0,
    maxPeak: 0,
    threshold,
  };
}

function profileActivationThreshold(profile, exerciseId) {
  return profileLiveScoringThreshold(exerciseId, getProfileExercise(profile, exerciseId)) ?? null;
}

function profileThresholdBands(profile, exerciseId) {
  const bands = getProfileExercise(profile, exerciseId)?.thresholdBands;
  if (!bands || typeof bands !== "object") return null;
  return {
    minimumVisible: compactNumber(bands.minimumVisible),
    reliableMovement: compactNumber(effectiveProfileThreshold(exerciseId, bands.reliableMovement)),
    baselineTarget: compactNumber(bands.baselineTarget),
  };
}

function hasRetakeGate(tracking, exerciseId) {
  return tracking.exerciseId === exerciseId && tracking.threshold != null;
}

function lowSignalIssue(exercise) {
  return `Keep going — move as much as you can for ${exercise?.name ?? "this exercise"}.`;
}

const SCORING_SESSION_DEBUG_LOG_INTERVAL_MS = 700;
let lastScoringSessionDebugLogAt = 0;

function scoringSessionDebugEnabled(scoringOptions = {}) {
  if (scoringOptions.scoringDiagnosticsEnabled) return true;
  const win = typeof window !== "undefined" ? window : null;
  if (!win) return false;
  if (win.__MIRROR_DEBUG_SCORING__ === true || win.__MIRROR_DEBUG_NOSE__ === true) return true;
  try {
    return win.localStorage?.getItem("mirror-debug-scoring") === "1"
      || win.localStorage?.getItem("mirror-debug-nose") === "1";
  } catch {
    return false;
  }
}

function debugSessionMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value ?? null;
}

function logScoringSessionDebug(reason, payload = {}, scoringOptions = {}) {
  if (!scoringSessionDebugEnabled(scoringOptions)) return;
  const win = typeof window !== "undefined" ? window : null;
  const now = win?.performance?.now?.() ?? Date.now();
  if (now - lastScoringSessionDebugLogAt < SCORING_SESSION_DEBUG_LOG_INTERVAL_MS) return;
  lastScoringSessionDebugLogAt = now;
  console.log("[Mirror scoring session]", reason, {
    scoringNoiseMode: scoringOptions.scoringNoiseMode,
    ...payload,
  });
}

function compactNumber(value, digits = 5) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

// Minimum spacing between persisted capture frames (~5fps).
const FRAME_SAMPLE_INTERVAL_MS = 200;

function addReasonCount(counts = {}, reason) {
  if (!reason) return counts;
  return { ...counts, [reason]: (counts[reason] ?? 0) + 1 };
}

function mergeReasonCounts(items = []) {
  const merged = {};
  for (const item of items) {
    for (const [reason, count] of Object.entries(item ?? {})) {
      if (!Number.isFinite(count) || count <= 0) continue;
      merged[reason] = (merged[reason] ?? 0) + count;
    }
  }
  return Object.keys(merged).length ? merged : null;
}

function percentile(values, pct) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const idx = (valid.length - 1) * pct;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return valid[lower];
  return valid[lower] + (valid[upper] - valid[lower]) * (idx - lower);
}

function scoreDistribution(values = []) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  const sum = valid.reduce((a, b) => a + b, 0);
  const p25 = percentile(valid, 0.25);
  const median = percentile(valid, 0.5);
  const p75 = percentile(valid, 0.75);
  return {
    count: valid.length,
    mean: compactNumber(sum / valid.length, 5),
    min: compactNumber(Math.min(...valid), 5),
    p25: compactNumber(p25, 5),
    median: compactNumber(median, 5),
    p75: compactNumber(p75, 5),
    max: compactNumber(Math.max(...valid), 5),
    iqr: p25 != null && p75 != null ? compactNumber(p75 - p25, 5) : null,
  };
}

function summarizeScoreDistributions(features = []) {
  const distributions = features.map((item) => item?.scoreDistribution).filter(Boolean);
  if (!distributions.length) return null;
  const totalCount = distributions.reduce((sum, item) => sum + (item.count ?? 0), 0);
  if (!totalCount) return null;
  const weighted = (key) => {
    const valid = distributions.filter((item) => Number.isFinite(item[key]) && Number.isFinite(item.count) && item.count > 0);
    const weight = valid.reduce((sum, item) => sum + item.count, 0);
    return weight ? compactNumber(valid.reduce((sum, item) => sum + item[key] * item.count, 0) / weight, 5) : null;
  };
  const p25 = weighted("p25");
  const p75 = weighted("p75");
  return {
    count: totalCount,
    mean: weighted("mean"),
    min: compactNumber(Math.min(...distributions.map((item) => item.min).filter(Number.isFinite)), 5),
    p25,
    median: weighted("median"),
    p75,
    max: compactNumber(Math.max(...distributions.map((item) => item.max).filter(Number.isFinite)), 5),
    iqr: p25 != null && p75 != null ? compactNumber(p75 - p25, 5) : null,
  };
}

function summarizeCoactivation(samples = []) {
  const valid = samples.filter((item) => Number.isFinite(item?.score));
  if (!valid.length) return null;
  const mean = valid.reduce((sum, item) => sum + item.score, 0) / valid.length;
  const max = Math.max(...valid.map((item) => item.score));
  const riskRank = { low: 0, medium: 1, high: 2 };
  const risk = valid.reduce((current, item) => (riskRank[item.risk] > riskRank[current] ? item.risk : current), "low");
  const regionScores = {};
  for (const sample of valid) {
    for (const region of sample.regions ?? []) {
      regionScores[region.region] = Math.max(regionScores[region.region] ?? 0, region.movement ?? 0);
    }
  }
  return {
    score: compactNumber(mean, 4),
    maxScore: compactNumber(max, 4),
    risk,
    sampleCount: valid.length,
    regions: Object.entries(regionScores).map(([region, movement]) => ({ region, movement: compactNumber(movement, 5) })),
  };
}

function compactLandmarksForCapture(landmarks) {
  if (!Array.isArray(landmarks)) return null;
  // 4 decimals ≈ 0.0001 of the normalized frame — well below landmark noise, and
  // ~20% smaller than 5 decimals before gzip.
  return landmarks.map((point) => point ? {
    x: compactNumber(point.x, 4),
    y: compactNumber(point.y, 4),
    z: compactNumber(point.z ?? 0, 4),
  } : null);
}

function compactBlendshapesForCapture(blendshapes) {
  if (!blendshapes || typeof blendshapes !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(blendshapes)) {
    const compact = compactNumber(value, 5);
    if (compact != null) out[key] = compact;
  }
  return out;
}

function compactMatrixForCapture(matrix) {
  if (!matrix?.data) return null;
  return {
    rows: matrix.rows,
    columns: matrix.columns,
    data: Array.from(matrix.data, (value) => compactNumber(value, 5)),
  };
}

function sampleVideoLighting(video, canvas) {
  if (!video || !canvas || !video.videoWidth || !video.videoHeight) return null;
  const width = 24;
  const height = 16;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(video, 0, 0, width, height);
    const data = ctx.getImageData(0, 0, width, height).data;
    let sum = 0;
    const values = [];
    for (let i = 0; i < data.length; i += 4) {
      const value = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722) / 255;
      values.push(value);
      sum += value;
    }
    const brightness = sum / values.length;
    const variance = values.reduce((acc, value) => acc + (value - brightness) ** 2, 0) / values.length;
    return { brightness: compactNumber(brightness, 4), contrast: compactNumber(Math.sqrt(variance), 4) };
  } catch {
    return null;
  }
}

function eyeDistance(lm) {
  if (!lm?.[33] || !lm?.[263]) return null;
  return Math.hypot(lm[263].x - lm[33].x, lm[263].y - lm[33].y);
}

function setupQualityColor(key) {
  if (key === "strong") return "#A8C39F";
  if (key === "usable") return "#D4A574";
  if (key === "weak") return "#FFB48F";
  return "#A8A29E";
}

function SetupQualityPanel({ summary }) {
  if (!summary) return null;
  const color = setupQualityColor(summary.key);
  const pct = summary.score != null ? Math.round(summary.score * 100) : null;
  const progress = Math.min(1, (summary.sampleCount ?? 0) / SETUP_SAMPLE_TARGET);
  const items = summary.actionItems?.length
    ? summary.actionItems
    : summary.ready
      ? ["Setup looks ready for calibration."]
      : ["Hold still while Mirror checks camera quality."];
  return (
    <div className="absolute left-4 right-4 bottom-4 rounded-2xl p-3" style={{ background: "rgba(31, 27, 22, 0.78)", border: `1px solid ${color}88`, color: "#F4EFE6" }}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="text-xs uppercase tracking-wider opacity-55">Setup quality</div>
          <div className="text-sm font-semibold" style={{ color }}>{summary.label}</div>
        </div>
        <div className="text-2xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color }}>{pct == null ? "--" : `${pct}`}</div>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden mb-2" style={{ background: "rgba(244,239,230,0.14)" }}>
        <div className="h-full rounded-full" style={{ width: `${progress * 100}%`, background: color }} />
      </div>
      <div className="grid grid-cols-3 gap-2 mb-2">
        <div className="text-[10px] opacity-65">Face {summary.facePresenceRatio == null ? "--" : `${Math.round(summary.facePresenceRatio * 100)}%`}</div>
        <div className="text-[10px] opacity-65">Centered {summary.alignmentRatio == null ? "--" : `${Math.round(summary.alignmentRatio * 100)}%`}</div>
        <div className="text-[10px] opacity-65">FPS {summary.fps == null ? "--" : Math.round(summary.fps)}</div>
      </div>
      <div className="space-y-1">
        {items.map((item) => <div key={item} className="text-xs leading-relaxed opacity-80">{item}</div>)}
      </div>
    </div>
  );
}

function movementFeaturesFromHold({
  current,
  leftAvg,
  rightAvg,
  movementProgress,
  initialMovementProgress,
  holdScoreCount,
  holdFaceFrames,
  holdAlignedFrames,
  holdObservedFrames,
  activationPeak,
  profileThreshold,
  thresholdBands,
  scoringNoiseMode,
  scoreValues,
  dropReasonCounts,
  coactivationSamples,
}) {
  const progress = initialMovementProgress ?? movementProgress;
  const alignedFrameRatio = holdFaceFrames > 0 ? holdAlignedFrames / holdFaceFrames : null;
  const rejectedFrameCount = Math.max(0, (holdObservedFrames ?? holdFaceFrames ?? 0) - (holdScoreCount ?? 0));
  return {
    scoringModelVersion: SCORING_MODEL_VERSION,
    exerciseId: current.id,
    affectedMovement: compactNumber(progress?.affectedMovement),
    properMovement: compactNumber(progress?.properMovement),
    affectedToProperRatio: compactNumber(progress?.affectedToProperRatio),
    affectedProgressRatio: compactNumber(progress?.affectedProgressRatio),
    leftMovement: compactNumber(leftAvg),
    rightMovement: compactNumber(rightAvg),
    activationPeak: compactNumber(activationPeak),
    validScoredFrameCount: holdScoreCount,
    holdFrameCount: holdFaceFrames,
    observedFrameCount: holdObservedFrames,
    rejectedFrameCount,
    dropReasonCounts: Object.keys(dropReasonCounts ?? {}).length ? dropReasonCounts : null,
    scoreDistribution: scoreDistribution(scoreValues),
    coactivation: summarizeCoactivation(coactivationSamples),
    alignedFrameRatio: compactNumber(alignedFrameRatio, 4),
    profileThreshold: compactNumber(profileThreshold),
    thresholdBands,
    scoringNoiseMode,
  };
}

function summarizeMovementFeatures(features = []) {
  const valid = features.filter(Boolean);
  if (!valid.length) return null;
  const weightedAverage = (key) => {
    let sum = 0, weight = 0;
    for (const item of valid) {
      const value = item[key];
      if (!Number.isFinite(value)) continue;
      const w = Math.max(1, item.validScoredFrameCount ?? 1);
      sum += value * w;
      weight += w;
    }
    return weight ? compactNumber(sum / weight) : null;
  };
  const totalValidFrames = valid.reduce((sum, item) => sum + (item.validScoredFrameCount ?? 0), 0);
  const totalHoldFrames = valid.reduce((sum, item) => sum + (item.holdFrameCount ?? 0), 0);
  const totalObservedFrames = valid.reduce((sum, item) => sum + (item.observedFrameCount ?? item.holdFrameCount ?? 0), 0);
  const totalRejectedFrames = valid.reduce((sum, item) => sum + (item.rejectedFrameCount ?? 0), 0);
  const alignedFrames = valid.reduce((sum, item) => sum + ((item.alignedFrameRatio ?? 0) * (item.holdFrameCount ?? 0)), 0);
  return {
    scoringModelVersion: SCORING_MODEL_VERSION,
    exerciseId: valid[0].exerciseId,
    affectedMovement: weightedAverage("affectedMovement"),
    properMovement: weightedAverage("properMovement"),
    affectedToProperRatio: weightedAverage("affectedToProperRatio"),
    affectedProgressRatio: weightedAverage("affectedProgressRatio"),
    leftMovement: weightedAverage("leftMovement"),
    rightMovement: weightedAverage("rightMovement"),
    activationPeak: compactNumber(Math.max(...valid.map((item) => item.activationPeak ?? 0))),
    validScoredFrameCount: totalValidFrames,
    holdFrameCount: totalHoldFrames,
    observedFrameCount: totalObservedFrames,
    rejectedFrameCount: totalRejectedFrames,
    dropReasonCounts: mergeReasonCounts(valid.map((item) => item.dropReasonCounts)),
    scoreDistribution: summarizeScoreDistributions(valid),
    coactivation: summarizeCoactivation(valid.map((item) => item.coactivation).filter(Boolean)),
    alignedFrameRatio: totalHoldFrames > 0 ? compactNumber(alignedFrames / totalHoldFrames, 4) : null,
    profileThreshold: weightedAverage("profileThreshold"),
    thresholdBands: valid.find((item) => item.thresholdBands)?.thresholdBands ?? null,
    scoringNoiseMode: valid[0].scoringNoiseMode,
    reps: valid.length,
  };
}

function formatRemainingTime(seconds) {
  const safe = Math.max(0, Math.ceil(seconds ?? 0));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return minutes > 0 ? `${minutes}:${String(secs).padStart(2, "0")}` : `${secs}s`;
}

// Vertical "ascent rail": session time flows bottom (launchpad) → top (orbit). The rocket's
// altitude tracks elapsed session time; each exercise is a station along the way, and the
// exhaust flame at its base reacts to the live hold/rest countdown.
function AscentRail({ exercises, exIdx, phase, phaseColor, elapsedFraction }) {
  const total = exercises?.length ?? 0;
  if (total === 0) return null;
  const accent = "#D4A574";
  const clamp01 = (n) => Math.max(0, Math.min(1, n));
  const altitude = clamp01(elapsedFraction);

  // Milestones spaced by each exercise's planned duration, not evenly.
  const planned = exercises.map(exercisePlannedSec);
  const totalSec = planned.reduce((a, b) => a + b, 0) + Math.max(0, total - 1) * INTERSTITIAL_SEC;
  const markers = exercises.map((ex, i) => {
    // Start time of this exercise = all earlier exercises + the interstitials before it.
    const startSec = planned.slice(0, i).reduce((a, b) => a + b, 0) + i * INTERSTITIAL_SEC;
    const frac = totalSec > 0 ? clamp01(startSec / totalSec) : i / Math.max(1, total - 1);
    return { id: ex.id ? `${ex.id}-${i}` : i, frac, done: i < exIdx, current: i === exIdx };
  });

  // Exhaust follows the phase: a long bright burn on hold, idle flicker on rest, faint hover otherwise.
  const flameScale = phase === "hold" ? 1 : phase === "rest" ? 0.5 : 0.28;
  const flameOp = phase === "hold" ? 1 : phase === "rest" ? 0.7 : 0.5;
  const glowOp = phase === "hold" ? 0.55 : phase === "rest" ? 0.24 : 0.12;
  const bobClass = phase === "hold" ? "bp-rail-thrust" : "bp-rail-hover";
  // Stage separation: the strap-on boosters detach and tumble away once past mid-ascent.
  const boostersGone = altitude >= 0.5;

  return (
    <div className="absolute top-0 bottom-0 right-0 w-12 pointer-events-none select-none z-10" aria-hidden>
      <style>{`
        @keyframes bpRailFlame { 0%,100% { transform: scaleY(1) scaleX(1); opacity: var(--flame-op,0.9); } 50% { transform: scaleY(1.26) scaleX(0.82); opacity: calc(var(--flame-op,0.9) * 0.62); } }
        @keyframes bpRailFlame2 { 0%,100% { transform: scaleY(1.12) scaleX(0.92); opacity: calc(var(--flame-op,0.9) * 0.8); } 50% { transform: scaleY(0.9) scaleX(1.08); opacity: var(--flame-op,0.9); } }
        @keyframes bpRailSway { 0%,100% { transform: translateX(-0.5px) rotate(-1.4deg); } 50% { transform: translateX(0.5px) rotate(1.4deg); } }
        @keyframes bpRailThroat { 0%,100% { transform: scale(1); opacity: 0.95; } 50% { transform: scale(1.18); opacity: 0.7; } }
        @keyframes bpRailThrust { 0%,100% { transform: translateY(0) scaleX(1); } 50% { transform: translateY(0.4px) scaleX(0.992); } }
        @keyframes bpRailHover { 0%,100% { transform: translateY(0.6px); } 50% { transform: translateY(-0.6px); } }
        .bp-rail-flame { animation: bpRailFlame 0.4s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 0%; }
        .bp-rail-flame2 { animation: bpRailFlame2 0.27s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 0%; }
        .bp-rail-sway { animation: bpRailSway 0.6s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 0%; }
        .bp-rail-throat { animation: bpRailThroat 0.2s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
        .bp-rail-thrust { animation: bpRailThrust 0.11s linear infinite; transform-box: fill-box; transform-origin: 50% 50%; }
        .bp-rail-hover { animation: bpRailHover 2.6s ease-in-out infinite; transform-box: fill-box; transform-origin: 50% 50%; }
        @media (prefers-reduced-motion: reduce) { .bp-rail-flame, .bp-rail-flame2, .bp-rail-sway, .bp-rail-throat, .bp-rail-thrust, .bp-rail-hover { animation: none !important; } }
      `}</style>

      <div className="absolute left-0 right-0" style={{ top: 56, bottom: 12 }}>
        {/* trajectory line + traveled fill */}
        <div className="absolute left-1/2 -translate-x-1/2 bottom-0 top-0 w-[2px] rounded-full" style={{ background: "rgba(244,239,230,0.28)", boxShadow: "0 0 3px rgba(0,0,0,0.6)" }} />
        <div
          className="absolute left-1/2 -translate-x-1/2 bottom-0 w-[2px] rounded-full"
          style={{ height: `${altitude * 100}%`, background: accent, boxShadow: `0 0 4px ${accent}`, transition: "height 600ms cubic-bezier(0.4,0,0.2,1)" }}
        />

        {/* exercise stations along the ascent */}
        {markers.map((m) => {
          const w = m.current ? 20 : m.done ? 14 : 11;
          const h = m.current ? 4 : 3;
          const color = m.done ? accent : m.current ? phaseColor : "rgba(244,239,230,0.45)";
          return (
            <div key={m.id} className="absolute left-1/2 -translate-x-1/2 translate-y-1/2 flex items-center justify-center" style={{ bottom: `${m.frac * 100}%` }}>
              {m.current && <div className="absolute rounded-full motion-safe:animate-ping" style={{ width: 24, height: 6, background: phaseColor, opacity: 0.4 }} />}
              <div
                className="relative rounded-full"
                style={{ width: w, height: h, background: color, boxShadow: m.current ? `0 0 6px ${phaseColor}` : "0 0 2px rgba(0,0,0,0.55)", transition: "width 300ms ease, height 300ms ease, background 400ms ease" }}
              />
            </div>
          );
        })}

        {/* LVM3-style rocket + layered exhaust at current altitude */}
        <div className="absolute left-1/2" style={{ bottom: `${altitude * 100}%`, width: 34, transform: "translate(-50%, 50%)", transition: "bottom 600ms cubic-bezier(0.4,0,0.2,1)" }}>
          <svg width="34" height="80" viewBox="0 0 34 80" fill="none" style={{ display: "block", overflow: "visible", filter: "drop-shadow(0 1px 3px rgba(0,0,0,0.5))" }}>
            <defs>
              <linearGradient id="bpFlameOuter" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={phaseColor} stopOpacity="0.95" />
                <stop offset="100%" stopColor={phaseColor} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="bpFlameMid" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FFC56B" stopOpacity="0.95" />
                <stop offset="55%" stopColor={phaseColor} stopOpacity="0.85" />
                <stop offset="100%" stopColor={phaseColor} stopOpacity="0" />
              </linearGradient>
              <linearGradient id="bpFlameInner" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FFFDF6" stopOpacity="1" />
                <stop offset="45%" stopColor="#FFE39C" stopOpacity="0.95" />
                <stop offset="100%" stopColor={phaseColor} stopOpacity="0" />
              </linearGradient>
              <radialGradient id="bpFlameCore" cx="50%" cy="35%" r="65%">
                <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1" />
                <stop offset="45%" stopColor="#FFEEBE" stopOpacity="0.95" />
                <stop offset="100%" stopColor={phaseColor} stopOpacity="0" />
              </radialGradient>
              <filter id="bpFlameBlur" x="-80%" y="-20%" width="260%" height="170%">
                <feGaussianBlur stdDeviation="1.3" />
              </filter>
              <radialGradient id="bpFlameGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor={phaseColor} stopOpacity="0.8" />
                <stop offset="100%" stopColor={phaseColor} stopOpacity="0" />
              </radialGradient>
              <linearGradient id="bpCore" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#CFC9BD" />
                <stop offset="32%" stopColor="#F6F2EA" />
                <stop offset="100%" stopColor="#D2CCC0" />
              </linearGradient>
              <linearGradient id="bpBooster" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#D8D2C7" />
                <stop offset="38%" stopColor="#F4F0E8" />
                <stop offset="100%" stopColor="#C9C3B7" />
              </linearGradient>
            </defs>

            <g className={bobClass}>
              {/* exhaust glow pool */}
              <ellipse cx="17" cy="52" rx={boostersGone ? 9 : 15} ry="7" fill="url(#bpFlameGlow)" opacity={glowOp} />

              {/* exhaust: phase sets length, layered plumes flicker out of sync for a live burn */}
              <g style={{ transformBox: "fill-box", transformOrigin: "50% 0%", transform: `scaleY(${flameScale})` }}>
                {/* core engine: soft blurred halo (gently swaying tip) */}
                <g className="bp-rail-sway">
                  <g className="bp-rail-flame" style={{ "--flame-op": flameOp }}>
                    <path d="M11.2 49Q17 62 22.8 49Q23.6 72 17 83Q10.4 72 11.2 49Z" fill="url(#bpFlameOuter)" filter="url(#bpFlameBlur)" />
                    <path d="M12.8 50Q17 59 21.2 50Q21.8 68 17 78Q12.2 68 12.8 50Z" fill="url(#bpFlameMid)" />
                  </g>
                </g>
                {/* core engine: shimmering bright cone + Mach diamonds */}
                <g className="bp-rail-flame2" style={{ "--flame-op": flameOp }}>
                  <path d="M14.4 50Q17 56 19.6 50Q20 64 17 72Q14 64 14.4 50Z" fill="url(#bpFlameInner)" />
                  <ellipse cx="17" cy="55.5" rx="1.5" ry="1.1" fill="#FFFDF6" opacity="0.85" />
                  <ellipse cx="17" cy="60" rx="1.2" ry="0.95" fill="#FFFDF6" opacity="0.6" />
                  <ellipse cx="17" cy="64" rx="0.9" ry="0.8" fill="#FFFDF6" opacity="0.4" />
                </g>
                {/* white-hot throat at the nozzle */}
                <ellipse className="bp-rail-throat" cx="17" cy="51.5" rx="3.1" ry="2.4" fill="url(#bpFlameCore)" />
                {/* booster plumes — vanish after separation */}
                {!boostersGone && (
                  <g className="bp-rail-flame2" style={{ "--flame-op": flameOp }}>
                    <path d="M3 46Q6 54 9 46Q9.4 60 6 71Q2.6 60 3 46Z" fill="url(#bpFlameOuter)" filter="url(#bpFlameBlur)" />
                    <path d="M25 46Q28 54 31 46Q31.4 60 28 71Q24.6 60 25 46Z" fill="url(#bpFlameOuter)" filter="url(#bpFlameBlur)" />
                    <path d="M4.2 46Q6 51 7.8 46Q8 56 6 63Q4 56 4.2 46Z" fill="url(#bpFlameMid)" />
                    <path d="M26.2 46Q28 51 29.8 46Q30 56 28 63Q26 56 26.2 46Z" fill="url(#bpFlameMid)" />
                  </g>
                )}
              </g>

              {/* strap-on boosters — detach and tumble outward past mid-ascent */}
              <g style={{ transition: "transform 1200ms cubic-bezier(0.22,1,0.36,1), opacity 900ms ease", transformBox: "fill-box", transformOrigin: "50% 35%", transform: boostersGone ? "translate(-10px,20px) rotate(-26deg)" : "none", opacity: boostersGone ? 0 : 1 }}>
                <path d="M6 17c2.7 2 3.8 5 3.8 8.4V46H2.2V25.4C2.2 22 3.3 19 6 17Z" fill="url(#bpBooster)" />
                <rect x="5.4" y="26" width="1.2" height="20" fill="#B9B3A6" opacity="0.7" />
                <path d="M2.6 46h6.8l-1.5 5.4H4.1Z" fill="#B8543A" />
              </g>
              <g style={{ transition: "transform 1200ms cubic-bezier(0.22,1,0.36,1), opacity 900ms ease", transformBox: "fill-box", transformOrigin: "50% 35%", transform: boostersGone ? "translate(10px,20px) rotate(26deg)" : "none", opacity: boostersGone ? 0 : 1 }}>
                <path d="M28 17c2.7 2 3.8 5 3.8 8.4V46h-7.6V25.4C24.2 22 25.3 19 28 17Z" fill="url(#bpBooster)" />
                <rect x="27.4" y="26" width="1.2" height="20" fill="#B9B3A6" opacity="0.7" />
                <path d="M24.6 46h6.8l-1.5 5.4H26.1Z" fill="#B8543A" />
              </g>

              {/* core nose cone (payload fairing) */}
              <path d="M17 1.2c3.2 2.9 4.8 7.1 4.8 11.8H12.2C12.2 8.3 13.8 4.1 17 1.2Z" fill="#F6F2EA" />
              {/* tricolour band */}
              <rect x="12.4" y="9.6" width="9.2" height="1.5" fill="#D4A574" />
              <rect x="12.4" y="11.1" width="9.2" height="1.5" fill="#7A8F73" />
              {/* core body */}
              <rect x="12.2" y="13" width="9.6" height="33" rx="0.8" fill="url(#bpCore)" />
              {/* interstage bands */}
              <rect x="12.2" y="23" width="9.6" height="2" fill="#C2BCB0" />
              <rect x="12.2" y="38.5" width="9.6" height="1.6" fill="#C2BCB0" />
              {/* accent stripe + logo window */}
              <rect x="12.2" y="16.2" width="9.6" height="1.8" fill={phaseColor} />
              <rect x="15.3" y="29.4" width="3.4" height="3.4" rx="1" fill={phaseColor} />
              {/* core nozzle */}
              <path d="M13.4 46h7.2l-1.9 6.2h-3.4Z" fill="#B8543A" />
            </g>
          </svg>
        </div>
      </div>
    </div>
  );
}

function SessionMode({ session, prefs, movementProfile, initialMovementProfile, sessionsToday, onComplete, onCancel, onTogglePref, onRequestProfileRetake }) {
  // Phases: optional setup → calibrate → rest (entry) → hold → rest → hold → ... → interstitial → next exercise → ... → summary
  // The single `rest` phase plays double-duty as exercise-entry settle AND between-rep recovery.
  const [phase, setPhase] = useState(() => (prefs.symmetryEnabled && prefs.mirrorEnabled ? "setup" : "preview"));
  const [exIdx, setExIdx] = useState(0);
  const [repIdx, setRepIdx] = useState(0);
  // Initialized to the first phase's duration because the session opens directly into preview — if this
  // were 0, the advance effect would short-circuit out before phase-mount could update it.
  const [secondsLeft, setSecondsLeft] = useState(null);
  const [paused, setPaused] = useState(false);
  const [cameraRetryKey, setCameraRetryKey] = useState(0);
  // Distinguishes the entry rest (no preceding hold) from the post-hold rest. Reset to true
  // on each exercise change.
  const restIsEntryRef = useRef(true);

  const { stream, cameraError } = useCameraStream(prefs.mirrorEnabled, cameraRetryKey);
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const snapshotCanvasRef = useRef(null);
  const baselineSnapshotRef = useRef(null);

  const symEnabled = prefs.symmetryEnabled && prefs.mirrorEnabled;
  const scoringNoiseMode = normalizeScoringNoiseMode(prefs.scoringNoiseMode);
  const scoringDiagnosticsEnabled = prefs.scoringDiagnosticsEnabled === true;
  const { faceLandmarker, latestRef, status: trackerStatus, trackerError } = useFaceLandmarker(symEnabled, cameraRetryKey);
  const cameraSetupReady = Boolean(symEnabled && stream && !cameraError && trackerStatus === "ready" && faceLandmarker);

  const calibBufferRef = useRef([]);
  const calibBsBufferRef = useRef([]);
  const calibMatrixBufferRef = useRef([]);
  const lastCalibLmRef = useRef(null);
  const lastCalibMatrixRef = useRef(null);
  const setupSamplesRef = useRef([]);
  const lastSetupLmRef = useRef(null);
  const lastSetupMatrixRef = useRef(null);
  const lastSetupSampleAtRef = useRef(0);
  const [setupQuality, setSetupQuality] = useState(null);
  const neutralRef = useRef(null);
  const noiseRef = useRef(null);
  const neutralBsRef = useRef(null);
  const neutralMatrixRef = useRef(null);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [calibrationStatus, setCalibrationStatus] = useState("Preparing tracker");
  const peakRepScoreRef = useRef(null);
  const [liveScore, setLiveScore] = useState(null);
  const [liveBalance, setLiveBalance] = useState(null);
  const [liveBaselineProgress, setLiveBaselineProgress] = useState(null);
  const [postureAligned, setPostureAligned] = useState(false);
  const [exerciseScores, setExerciseScores] = useState([]);
  const repScoresRef = useRef([]);
  const repBaselineProgressRef = useRef([]);
  const repInitialBaselineProgressRef = useRef([]);
  const repMovementProgressRef = useRef([]);
  const repInitialMovementProgressRef = useRef([]);
  const repSnapshotsRef = useRef([]);
  const peakSnapshotRef = useRef(null);
  const peakDispRef = useRef(0);
  // Hold-window score accumulator: rep score = mean(symmetry across all valid frames during hold).
  // Honors sustained effort better than instantaneous peak, esp. on the affected side.
  const holdScoreSumRef = useRef(0);
  const holdScoreCountRef = useRef(0);
  const holdLeftSumRef = useRef(0);
  const holdRightSumRef = useRef(0);
  const holdScoreValuesRef = useRef([]);
  const holdCoactivationRef = useRef([]);
  const holdFaceFramesRef = useRef(0);
  const holdAlignedFramesRef = useRef(0);
  const holdObservedFrameCountRef = useRef(0);
  const holdDropReasonCountsRef = useRef({});
  const holdActivationPeakRef = useRef(0);
  const liveScoreStabilizerRef = useRef(createLiveScoreStabilizer());
  const repMovementFeaturesRef = useRef([]);
  const frameSamplesRef = useRef([]);
  const lastFrameSampleAtRef = useRef(0);
  const holdTrackingRef = useRef(createHoldTracking());
  const [trackingIssue, setTrackingIssue] = useState(null);
  const [retakePrompt, setRetakePrompt] = useState(null);
  const [endSessionConfirmStep, setEndSessionConfirmStep] = useState(0);

  const startTimeRef = useRef(session.startedAt);
  const current = session.exercises[exIdx];
  const nextExercise = session.exercises[exIdx + 1] ?? null;
  const totalExercises = session.exercises.length;
  const currentReps = current.reps;
  const currentRestSec = exerciseRestSec(current);
  const currentHoldSec = exerciseHoldSec(current);
  const autoPaused = symEnabled && trackerStatus === "ready" && (phase === "rest" || phase === "hold") && !postureAligned;
  const timerPaused = paused || autoPaused || Boolean(retakePrompt) || endSessionConfirmStep > 0;
  const dataCaptureEnabled = prefs.dataCaptureEnabled === true;

  const recordSetupSample = useCallback((sample) => {
    const now = sample?.ts ?? Date.now();
    if (now - lastSetupSampleAtRef.current < 120) return;
    lastSetupSampleAtRef.current = now;
    setupSamplesRef.current = [...setupSamplesRef.current.slice(-80), { ...sample, ts: now }];
    setSetupQuality(summarizeCaptureSetupQuality(setupSamplesRef.current));
  }, []);

  const recordHoldDropReason = useCallback((reason) => {
    holdDropReasonCountsRef.current = addReasonCount(holdDropReasonCountsRef.current, reason);
  }, []);

  const captureFrameSample = useCallback((sample) => {
    if (!dataCaptureEnabled) return;
    const now = Date.now();
    // ~5fps: enough temporal resolution for symmetry/movement labeling while
    // halving the stored sample count versus the previous 10fps.
    if (now - lastFrameSampleAtRef.current < FRAME_SAMPLE_INTERVAL_MS) return;
    lastFrameSampleAtRef.current = now;
    frameSamplesRef.current.push({
      exerciseId: current.id,
      exerciseIndex: exIdx,
      repIndex: repIdx,
      phase,
      ts: now,
      elapsedMs: Math.max(0, now - startTimeRef.current),
      scoringNoiseMode,
      ...sample,
    });
    if (frameSamplesRef.current.length > 5000) frameSamplesRef.current.shift();
  }, [current.id, dataCaptureEnabled, exIdx, phase, repIdx, scoringNoiseMode]);

  useEffect(() => { if (videoRef.current && stream) videoRef.current.srcObject = stream; }, [stream, exIdx, phase]);

  useEffect(() => {
    return () => {
      flushSpeech();
    };
  }, []);

  useEffect(() => {
    if (phase !== "setup") return;
    setupSamplesRef.current = [];
    lastSetupLmRef.current = null;
    lastSetupMatrixRef.current = null;
    lastSetupSampleAtRef.current = 0;
    setSetupQuality(summarizeCaptureSetupQuality([]));
    speak(prefs.voiceEnabled, "Camera setup. Center your face and hold still.");
  }, [phase, prefs.voiceEnabled]);

  useEffect(() => {
    if (phase !== "calibrate") return;
    calibBufferRef.current = [];
    calibBsBufferRef.current = [];
    calibMatrixBufferRef.current = [];
    lastCalibLmRef.current = null;
    lastCalibMatrixRef.current = null;
    neutralRef.current = null;
    noiseRef.current = null;
    neutralBsRef.current = null;
    neutralMatrixRef.current = null;
    baselineSnapshotRef.current = null;
    setCalibrationProgress(0);
    setCalibrationStatus("Preparing tracker");
    speak(prefs.voiceEnabled, "Calibration. Center your face and stay relaxed.");
  }, [phase, prefs.voiceEnabled]);

  useEffect(() => {
    if (phase !== "calibrate" && phase !== "setup") return;
    if (!symEnabled) {
      setPhase("preview");
      setSecondsLeft(null);
    }
  }, [phase, symEnabled]);

  // Phase entry: set the timer and announce the phase.
  useEffect(() => {
    if (paused) return;
    if (phase === "hold") {
      peakRepScoreRef.current = null;
      peakSnapshotRef.current = null;
      peakDispRef.current = 0;
      holdScoreSumRef.current = 0;
      holdScoreCountRef.current = 0;
      holdLeftSumRef.current = 0;
      holdRightSumRef.current = 0;
      holdScoreValuesRef.current = [];
      holdCoactivationRef.current = [];
      holdFaceFramesRef.current = 0;
      holdAlignedFramesRef.current = 0;
      holdObservedFrameCountRef.current = 0;
      holdDropReasonCountsRef.current = {};
      holdActivationPeakRef.current = 0;
      liveScoreStabilizerRef.current.reset();
      holdTrackingRef.current = createHoldTracking(current.id, profileActivationThreshold(movementProfile, current.id));
      setTrackingIssue(null);
      setLiveScore(null);
      setLiveBalance(null);
      setLiveBaselineProgress(null);
      speak(prefs.voiceEnabled, "Hold");
    } else if (phase === "rest") {
      setTrackingIssue(null);
      if (restIsEntryRef.current) {
        // Entry rest: settle into the exercise before the first hold.
        speak(prefs.voiceEnabled, repIdx === 0 && exIdx === 0
          ? current.name + ". Resting pose. Stay relaxed."
          : current.name + ". Resting pose.");
      } else {
        // Post-hold rest: record this rep using the TIME-AVERAGED hold score; snapshot at peak movement.
        const avgScore = holdScoreCountRef.current > 0 ? holdScoreSumRef.current / holdScoreCountRef.current : null;
        if (avgScore != null) repScoresRef.current = [...repScoresRef.current, avgScore];
        let leftAvg = null;
        let rightAvg = null;
        let movementProgress = null;
        let initialMovementProgress = null;
        if (holdScoreCountRef.current > 0) {
          leftAvg = holdLeftSumRef.current / holdScoreCountRef.current;
          rightAvg = holdRightSumRef.current / holdScoreCountRef.current;
          const progress = computeBaselineProgressFromDisplacements(current.id, leftAvg, rightAvg, movementProfile);
          const initialProgress = computeBaselineProgressFromDisplacements(current.id, leftAvg, rightAvg, initialMovementProfile);
          movementProgress = computeMovementProgressFromDisplacements(current.id, leftAvg, rightAvg, movementProfile);
          initialMovementProgress = computeMovementProgressFromDisplacements(current.id, leftAvg, rightAvg, initialMovementProfile);
          if (progress) repBaselineProgressRef.current = [...repBaselineProgressRef.current, progress];
          if (initialProgress) repInitialBaselineProgressRef.current = [...repInitialBaselineProgressRef.current, initialProgress];
          if (movementProgress) repMovementProgressRef.current = [...repMovementProgressRef.current, movementProgress];
          if (initialMovementProgress) repInitialMovementProgressRef.current = [...repInitialMovementProgressRef.current, initialMovementProgress];
        }
        repMovementFeaturesRef.current = [...repMovementFeaturesRef.current, movementFeaturesFromHold({
          current,
          leftAvg,
          rightAvg,
          movementProgress,
          initialMovementProgress,
          holdScoreCount: holdScoreCountRef.current,
          holdFaceFrames: holdFaceFramesRef.current,
          holdAlignedFrames: holdAlignedFramesRef.current,
          holdObservedFrames: holdObservedFrameCountRef.current,
          activationPeak: holdActivationPeakRef.current,
          profileThreshold: profileActivationThreshold(movementProfile, current.id),
          thresholdBands: profileThresholdBands(movementProfile, current.id),
          scoringNoiseMode,
          scoreValues: holdScoreValuesRef.current,
          dropReasonCounts: holdDropReasonCountsRef.current,
          coactivationSamples: holdCoactivationRef.current,
        })];
        const snap = peakSnapshotRef.current ?? captureSnapshot(videoRef.current, snapshotCanvasRef.current);
        if (snap) repSnapshotsRef.current = [...repSnapshotsRef.current, { ts: Date.now(), score: avgScore, dataUrl: snap }];
        speak(prefs.voiceEnabled, "Resting pose");
      }
    } else if (phase === "interstitial") {
      setTrackingIssue(null);
      speak(prefs.voiceEnabled, "Nice work. Take a breath.");
    } else if (phase === "setup") {
      setTrackingIssue(null);
    } else if (phase === "preview") {
      setTrackingIssue(null);
      speak(prefs.voiceEnabled, `Up next: ${current.name}. ${current.instruction}`);
    }
  }, [phase, exIdx, repIdx, current, initialMovementProfile, movementProfile, paused, prefs.voiceEnabled, scoringNoiseMode]);

  useEffect(() => {
    if (timerPaused || phase === "summary" || phase === "setup" || phase === "calibrate" || phase === "preview") return;
    if (secondsLeft <= 0) {
      // Each branch sets BOTH the new phase and the new timer in one batch — otherwise the advance
      // effect would re-fire with stale secondsLeft = 0 and skip past the just-entered phase.
      if (phase === "hold") {
        // The baseline is a fixed reference — you can't move better than your own
        // face — so a low-signal hold is recorded as low progress, not treated as a
        // calibration error. We no longer interrupt the session to force a re-baseline;
        // the rep simply scores low and we continue. (Manual recalibration stays
        // available from settings.)
        setPhase("rest");
        setSecondsLeft(currentRestSec);
      } else if (phase === "rest") {
        if (restIsEntryRef.current) {
          restIsEntryRef.current = false;
          setPhase("hold");
          setSecondsLeft(currentHoldSec);
        } else if (repIdx + 1 < currentReps) {
          setRepIdx(repIdx + 1);
          setPhase("hold");
          setSecondsLeft(currentHoldSec);
        } else {
          // End of exercise — finalize per-exercise scores
          const scores = repScoresRef.current;
          const baselineProgress = summarizeBaselineProgress(repBaselineProgressRef.current);
          const initialBaselineProgress = summarizeBaselineProgress(repInitialBaselineProgressRef.current);
          const movementProgress = summarizeMovementProgress(repMovementProgressRef.current);
          const initialMovementProgress = summarizeMovementProgress(repInitialMovementProgressRef.current);
          const snapshots = repSnapshotsRef.current;
          const repDiagnostics = repMovementFeaturesRef.current;
          const movementFeatures = summarizeMovementFeatures(repMovementFeaturesRef.current);
          const captureQuality = summarizeCaptureQualityFromFeatures(repDiagnostics);
          const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
          setExerciseScores((prev) => [...prev, { scoringModelVersion: SCORING_MODEL_VERSION, exerciseId: current.id, name: current.name, region: current.region, repsTarget: current.reps, holdSec: current.holdSec, restSec: current.restSec, comfortLevel: current.comfortLevel, baselineSnapshot: baselineSnapshotRef.current, scores, avg, snapshots, baselineProgress, initialBaselineProgress, movementProgress, initialMovementProgress, movementFeatures, repDiagnostics, captureQuality }]);
          repScoresRef.current = [];
          repBaselineProgressRef.current = [];
          repInitialBaselineProgressRef.current = [];
          repMovementProgressRef.current = [];
          repInitialMovementProgressRef.current = [];
          repMovementFeaturesRef.current = [];
          repSnapshotsRef.current = [];
          if (exIdx + 1 < totalExercises) {
            setPhase("interstitial");
            setSecondsLeft(INTERSTITIAL_SEC);
          } else {
            speak(prefs.voiceEnabled, "Session complete. Well done.");
            setPhase("summary");
          }
        }
      } else if (phase === "interstitial") {
        setExIdx(exIdx + 1);
        setRepIdx(0);
        restIsEntryRef.current = true; // next exercise starts with an entry rest
        setPhase("preview");
        setSecondsLeft(null);
      }
      return;
    }
    const t = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [current, currentHoldSec, currentReps, currentRestSec, exIdx, phase, prefs.voiceEnabled, repIdx, secondsLeft, timerPaused, totalExercises]);

  // FaceLandmarker detection + overlay loop. The hook workerizes MediaPipe when supported
  // and falls back to the same async facade on the main thread when needed.
  useEffect(() => {
    if (!faceLandmarker || !videoRef.current) return;
    const bsMapping = EXERCISE_BLENDSHAPES[current.id] ?? null;
    const isBrow = BROW_EXERCISES.has(current.id);
    const isNose = NOSE_EXERCISES.has(current.id);

    let raf, alive = true, lastTs = 0;
    const tick = async () => {
      if (!alive) return;
      const v = videoRef.current;
      if (!v || v.readyState < 2 || v.paused) { raf = requestAnimationFrame(tick); return; }
      try {
        const ts = Math.max(lastTs + 1, performance.now());
        lastTs = ts;
        const taskResult = await faceLandmarker.detectForVideo(v, ts);
        if (!alive) return;
        const rawLm = taskResult.faceLandmarks?.[0];
        const bsArr = taskResult.faceBlendshapes?.[0]?.categories;
        const rawMatrix = firstFacialTransformationMatrix(taskResult);
        if (phase === "hold") holdObservedFrameCountRef.current++;

        if (rawLm) {
          if (phase === "hold" && hasRetakeGate(holdTrackingRef.current, current.id)) {
            holdTrackingRef.current.faceFrames++;
          }
          const prevLm = latestRef.current?.landmarks;
          const prevMatrix = latestRef.current?.facialTransformationMatrix;
          const lm = smoothLandmarks(prevLm, rawLm);
          const facialTransformationMatrix = smoothFacialTransformationMatrix(prevMatrix, rawMatrix);
          const bsMap = {};
          if (bsArr) for (const c of bsArr) bsMap[c.categoryName] = c.score;
          latestRef.current = { landmarks: lm, blendshapes: bsMap, facialTransformationMatrix };
          const alignment = faceAlignmentFeedback(lm);
          const aligned = alignment.aligned;
          setPostureAligned((prev) => (prev === aligned ? prev : aligned));
          let captureScoring = null;

          if (phase === "setup") {
            const lighting = sampleVideoLighting(v, snapshotCanvasRef.current);
            const stabilityDelta = prevLm ? normalizedFrameDelta(lm, prevLm, facialTransformationMatrix, prevMatrix) : null;
            recordSetupSample({
              facePresent: true,
              aligned,
              centerOff: compactNumber(alignment.centerOff),
              tiltRad: compactNumber(alignment.tiltRad),
              stabilityDelta: compactNumber(stabilityDelta),
              eyeDistance: compactNumber(eyeDistance(lm), 4),
              brightness: lighting?.brightness ?? null,
              contrast: lighting?.contrast ?? null,
            });
          } else if (phase === "calibrate") {
            if (!neutralRef.current) {
              if (!aligned) {
                calibBufferRef.current = [];
                calibBsBufferRef.current = [];
                calibMatrixBufferRef.current = [];
                lastCalibLmRef.current = null;
                lastCalibMatrixRef.current = null;
                setCalibrationProgress(0);
                setCalibrationStatus(alignment.label);
              } else {
                const delta = lastCalibLmRef.current ? normalizedFrameDelta(lm, lastCalibLmRef.current, facialTransformationMatrix, lastCalibMatrixRef.current) : 0;
                lastCalibLmRef.current = lm;
                lastCalibMatrixRef.current = facialTransformationMatrix;
                if (delta > CALIBRATION_RESET_EPS) {
                  calibBufferRef.current = [lm];
                  calibBsBufferRef.current = [bsMap];
                  calibMatrixBufferRef.current = [facialTransformationMatrix];
                  setCalibrationProgress(1);
                  setCalibrationStatus(calibrationPrompt(1, delta));
                } else {
                  if (calibBufferRef.current.length < CALIBRATION_FRAMES) {
                    calibBufferRef.current.push(lm);
                    calibBsBufferRef.current.push(bsMap);
                    calibMatrixBufferRef.current.push(facialTransformationMatrix);
                  }
                  const progress = calibBufferRef.current.length;
                  setCalibrationProgress((prev) => (prev === progress ? prev : progress));
                  setCalibrationStatus(calibrationPrompt(progress, delta));
                  if (progress >= CALIBRATION_FRAMES) {
                    const neutral = averageLandmarks(calibBufferRef.current);
                    const neutralMatrix = averageFacialTransformationMatrix(calibMatrixBufferRef.current);
                    neutralRef.current = neutral;
                    neutralMatrixRef.current = neutralMatrix;
                    noiseRef.current = computeNoiseFloor(calibBufferRef.current, neutral, calibMatrixBufferRef.current, neutralMatrix);
                    neutralBsRef.current = averageBlendshapes(calibBsBufferRef.current);
                    baselineSnapshotRef.current = captureSnapshot(v, snapshotCanvasRef.current);
                    restIsEntryRef.current = true;
                    setPhase("preview");
                    setSecondsLeft(null);
                  }
                }
              }
            }
          } else if (phase === "hold") {
            holdFaceFramesRef.current++;
            if (!aligned) {
              liveScoreStabilizerRef.current.reset();
              setLiveScore(null);
              setLiveBalance(null);
              setLiveBaselineProgress(null);
              recordHoldDropReason(SCORE_DROP_REASONS.alignment);
              captureScoring = {
                scoringModelVersion: SCORING_MODEL_VERSION,
                activated: false,
                reason: SCORE_DROP_REASONS.alignment,
                dropReason: SCORE_DROP_REASONS.alignment,
              };
              if (hasRetakeGate(holdTrackingRef.current, current.id)) {
                setTrackingIssue((prev) => (prev === TRACKING_ISSUES.alignment ? prev : TRACKING_ISSUES.alignment));
              }
            } else {
              holdAlignedFramesRef.current++;
              if (hasRetakeGate(holdTrackingRef.current, current.id)) {
                holdTrackingRef.current.alignedFrames++;
              }
              let symResult = null;
              // Brow exercises: pitch-invariant brow-to-eye gap delta.
              // Nose exercises: direction-specific nostril flare or nose scrunch.
              // Other exercises: face-local landmark-pair displacement with per-landmark noise
              // subtracted out. Fallback: generic 9-pair.
              const scoringOptions = { scoringNoiseMode, scoringDiagnosticsEnabled };
              const scoringDiagnostic = computeExerciseSymmetryDiagnostic(current.id, lm, neutralRef.current, noiseRef.current, bsMap, neutralBsRef.current, facialTransformationMatrix, neutralMatrixRef.current, scoringOptions);
              symResult = scoringDiagnostic.result;
              if (symResult != null) {
                const profileExercise = getProfileExercise(movementProfile, current.id);
                const profileThreshold = profileLiveScoringThreshold(current.id, profileExercise);
                const thresholdBands = profileThresholdBands(movementProfile, current.id);
                const activated = !profileThreshold || symResult.peak >= profileThreshold;
                const coactivation = computeQuietRegionCoactivation(current.id, lm, neutralRef.current, noiseRef.current, facialTransformationMatrix, neutralMatrixRef.current, symResult.peak, scoringOptions);
                if (coactivation) holdCoactivationRef.current = [...holdCoactivationRef.current, coactivation];
                captureScoring = {
                  scoringModelVersion: SCORING_MODEL_VERSION,
                  rawSymmetry: compactNumber(symResult.symmetry, 5),
                  leftDisp: compactNumber(symResult.leftDisp),
                  rightDisp: compactNumber(symResult.rightDisp),
                  peak: compactNumber(symResult.peak),
                  profileThreshold: compactNumber(profileThreshold),
                  thresholdBands,
                  activated,
                  dropReason: activated ? null : SCORE_DROP_REASONS.belowActivationThreshold,
                  normalizationMethod: scoringDiagnostic.normalizationMethod,
                  coactivation,
                };
                logScoringSessionDebug("hold frame", {
                  exerciseId: current.id,
                  symmetry: debugSessionMetric(symResult.symmetry),
                  peak: debugSessionMetric(symResult.peak),
                  userLeftDisp: debugSessionMetric(symResult.leftDisp),
                  userRightDisp: debugSessionMetric(symResult.rightDisp),
                  rawProfileThreshold: debugSessionMetric(profileExercise?.activationThreshold),
                  effectiveProfileThreshold: debugSessionMetric(profileThreshold),
                  activationState: {
                    activated,
                    holdScoreCount: holdScoreCountRef.current,
                  },
                  blendshapes: {
                    noseSneerLeft: debugSessionMetric(bsMap.noseSneerLeft),
                    noseSneerRight: debugSessionMetric(bsMap.noseSneerRight),
                    neutralNoseSneerLeft: debugSessionMetric(neutralBsRef.current?.noseSneerLeft),
                    neutralNoseSneerRight: debugSessionMetric(neutralBsRef.current?.noseSneerRight),
                  },
                }, scoringOptions);
                if (hasRetakeGate(holdTrackingRef.current, current.id)) {
                  const tracker = holdTrackingRef.current;
                  tracker.signalFrames++;
                  tracker.maxPeak = Math.max(tracker.maxPeak, symResult.peak ?? 0);
                  tracker.threshold = profileThreshold ?? tracker.threshold;
                  if (activated) tracker.activatedFrames++;
                }
                if (activated) {
                  holdActivationPeakRef.current = Math.max(holdActivationPeakRef.current, symResult.peak ?? 0);
                  const liveResult = liveScoreStabilizerRef.current.update(symResult);
                  captureScoring.displaySymmetry = compactNumber(liveResult?.symmetry, 5);
                  captureScoring.displayLeftDisp = compactNumber(liveResult?.leftDisp);
                  captureScoring.displayRightDisp = compactNumber(liveResult?.rightDisp);
                  setLiveScore(liveResult?.symmetry ?? null);
                  setLiveBalance(liveResult ? { left: liveResult.leftDisp, right: liveResult.rightDisp } : null);
                  // Time-average accumulator — every valid frame contributes equally to the rep score.
                  // A saved movement profile raises this from generic movement to user-scaled movement.
                  holdScoreSumRef.current += symResult.symmetry;
                  holdScoreCountRef.current++;
                  holdScoreValuesRef.current = [...holdScoreValuesRef.current, symResult.symmetry];
                  holdLeftSumRef.current += symResult.leftDisp;
                  holdRightSumRef.current += symResult.rightDisp;
                  setLiveBaselineProgress(computeBaselineProgress(current.id, liveResult ?? symResult, movementProfile));
                  if (peakRepScoreRef.current == null || symResult.symmetry > peakRepScoreRef.current) {
                    peakRepScoreRef.current = symResult.symmetry;
                  }
                  if (hasRetakeGate(holdTrackingRef.current, current.id)) {
                    setTrackingIssue((prev) => (prev == null ? prev : null));
                  }
                } else {
                  recordHoldDropReason(SCORE_DROP_REASONS.belowActivationThreshold);
                  const liveResult = liveScoreStabilizerRef.current.update(null);
                  captureScoring.displaySymmetry = compactNumber(liveResult?.symmetry, 5);
                  captureScoring.displayLeftDisp = compactNumber(liveResult?.leftDisp);
                  captureScoring.displayRightDisp = compactNumber(liveResult?.rightDisp);
                  setLiveScore(liveResult?.symmetry ?? null);
                  setLiveBalance(liveResult ? { left: liveResult.leftDisp, right: liveResult.rightDisp } : null);
                  setLiveBaselineProgress(liveResult ? computeBaselineProgress(current.id, liveResult, movementProfile) : null);
                  if (hasRetakeGate(holdTrackingRef.current, current.id) && profileThreshold != null) {
                    const issue = lowSignalIssue(current);
                    setTrackingIssue((prev) => (prev === issue ? prev : issue));
                  }
                }
              } else {
                const profileExercise = getProfileExercise(movementProfile, current.id);
                const profileThreshold = profileLiveScoringThreshold(current.id, profileExercise);
                const thresholdBands = profileThresholdBands(movementProfile, current.id);
                captureScoring = {
                  scoringModelVersion: SCORING_MODEL_VERSION,
                  activated: false,
                  profileThreshold: compactNumber(profileThreshold),
                  thresholdBands,
                  reason: scoringDiagnostic.dropReason ?? SCORE_DROP_REASONS.noSymmetryResult,
                  dropReason: scoringDiagnostic.dropReason ?? SCORE_DROP_REASONS.noSymmetryResult,
                  normalizationMethod: scoringDiagnostic.normalizationMethod,
                };
                recordHoldDropReason(captureScoring.dropReason);
                logScoringSessionDebug("no symmetry result", {
                  exerciseId: current.id,
                  rawProfileThreshold: debugSessionMetric(profileExercise?.activationThreshold),
                  effectiveProfileThreshold: debugSessionMetric(profileThreshold),
                  blendshapes: {
                    noseSneerLeft: debugSessionMetric(bsMap.noseSneerLeft),
                    noseSneerRight: debugSessionMetric(bsMap.noseSneerRight),
                    neutralNoseSneerLeft: debugSessionMetric(neutralBsRef.current?.noseSneerLeft),
                    neutralNoseSneerRight: debugSessionMetric(neutralBsRef.current?.noseSneerRight),
                  },
                  activationState: { activated: false },
                }, scoringOptions);
                if (hasRetakeGate(holdTrackingRef.current, current.id) && holdTrackingRef.current.threshold != null) {
                  const issue = lowSignalIssue(current);
                  setTrackingIssue((prev) => (prev === issue ? prev : issue));
                } else if (hasRetakeGate(holdTrackingRef.current, current.id)) {
                  setTrackingIssue((prev) => (prev == null ? prev : null));
                }
                const liveResult = liveScoreStabilizerRef.current.update(null);
                captureScoring.displaySymmetry = compactNumber(liveResult?.symmetry, 5);
                captureScoring.displayLeftDisp = compactNumber(liveResult?.leftDisp);
                captureScoring.displayRightDisp = compactNumber(liveResult?.rightDisp);
                setLiveScore(liveResult?.symmetry ?? null);
                setLiveBalance(liveResult ? { left: liveResult.leftDisp, right: liveResult.rightDisp } : null);
                setLiveBaselineProgress(liveResult ? computeBaselineProgress(current.id, liveResult, movementProfile) : null);
              }
              // Auto-advance gate AND snapshot trigger. For brow exercises, the brow-lift magnitude is more
              // precise than the blendshape (subtle lifts saturate browOuterUp poorly).
              let activation;
              if ((isBrow || isNose) && symResult) activation = symResult.peak;
              else if (bsMapping)       activation = bsActivation(bsMap, bsMapping);
              else                      activation = symResult ? symResult.peak : 0;
              if (activation > peakDispRef.current) {
                peakDispRef.current = activation;
                // Capture snapshot at peak movement, not peak score — score can be misleading on asymmetric faces
                peakSnapshotRef.current = captureSnapshot(v, snapshotCanvasRef.current);
              }
            }
            // Hold runs for the full holdSec timer — no auto-advance on detected release.
            // We still track peak for snapshot capture, just don't end the phase early.
          }

          captureFrameSample({
            aligned,
            alignmentIssue: alignment.issue,
            // Raw (pre-normalization) landmarks/matrix are omitted: they roughly
            // double the per-frame payload and downstream consumers fall back to
            // the processed `landmarks`/`facialTransformationMatrix`.
            landmarks: compactLandmarksForCapture(lm),
            blendshapes: compactBlendshapesForCapture(bsMap),
            facialTransformationMatrix: compactMatrixForCapture(facialTransformationMatrix),
            scoring: captureScoring,
          });
          drawOverlay(overlayRef.current, v, lm, { aligned, phase });
        } else {
          latestRef.current = null;
          liveScoreStabilizerRef.current.reset();
          setPostureAligned(false);
          setLiveScore(null);
          setLiveBalance(null);
          setLiveBaselineProgress(null);
          if (phase === "setup") {
            const lighting = sampleVideoLighting(v, snapshotCanvasRef.current);
            recordSetupSample({
              facePresent: false,
              aligned: false,
              brightness: lighting?.brightness ?? null,
              contrast: lighting?.contrast ?? null,
            });
          }
          if (phase === "hold") {
            recordHoldDropReason(SCORE_DROP_REASONS.noFace);
            captureFrameSample({
              aligned: false,
              alignmentIssue: SCORE_DROP_REASONS.noFace,
              landmarks: null,
              blendshapes: null,
              facialTransformationMatrix: null,
              scoring: {
                scoringModelVersion: SCORING_MODEL_VERSION,
                activated: false,
                reason: SCORE_DROP_REASONS.noFace,
                dropReason: SCORE_DROP_REASONS.noFace,
              },
            });
          }
          if (phase === "hold" && hasRetakeGate(holdTrackingRef.current, current.id)) {
            setTrackingIssue((prev) => (prev === TRACKING_ISSUES.faceMissing ? prev : TRACKING_ISSUES.faceMissing));
          }
          if (phase === "calibrate") {
            calibBufferRef.current = [];
            calibBsBufferRef.current = [];
            calibMatrixBufferRef.current = [];
            lastCalibLmRef.current = null;
            lastCalibMatrixRef.current = null;
            baselineSnapshotRef.current = null;
            setCalibrationProgress(0);
            setCalibrationStatus("Find your face in the camera");
          }
          drawOverlay(overlayRef.current, v, null, { aligned: false, phase });
        }
      } catch {
        // Detection is best-effort; transient MediaPipe/video frame errors should not end a session.
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [captureFrameSample, current, dataCaptureEnabled, exIdx, faceLandmarker, latestRef, phase, repIdx, currentRestSec, movementProfile, recordHoldDropReason, recordSetupSample, scoringDiagnosticsEnabled, scoringNoiseMode]);

  const finalizeCurrentExercise = () => {
    const scores = repScoresRef.current;
    const baselineProgress = summarizeBaselineProgress(repBaselineProgressRef.current);
    const initialBaselineProgress = summarizeBaselineProgress(repInitialBaselineProgressRef.current);
    const movementProgress = summarizeMovementProgress(repMovementProgressRef.current);
    const initialMovementProgress = summarizeMovementProgress(repInitialMovementProgressRef.current);
    const snapshots = repSnapshotsRef.current;
    const repDiagnostics = repMovementFeaturesRef.current;
    const movementFeatures = summarizeMovementFeatures(repMovementFeaturesRef.current);
    const captureQuality = summarizeCaptureQualityFromFeatures(repDiagnostics);
    const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    setExerciseScores((prev) => [...prev, { scoringModelVersion: SCORING_MODEL_VERSION, exerciseId: current.id, name: current.name, region: current.region, repsTarget: current.reps, holdSec: current.holdSec, restSec: current.restSec, comfortLevel: current.comfortLevel, baselineSnapshot: baselineSnapshotRef.current, scores, avg, snapshots, baselineProgress, initialBaselineProgress, movementProgress, initialMovementProgress, movementFeatures, repDiagnostics, captureQuality }]);
    repScoresRef.current = [];
    repBaselineProgressRef.current = [];
    repInitialBaselineProgressRef.current = [];
    repMovementProgressRef.current = [];
    repInitialMovementProgressRef.current = [];
    repMovementFeaturesRef.current = [];
    repSnapshotsRef.current = [];
  };

  const handleSkipExercise = () => {
    flushSpeech();
    finalizeCurrentExercise();
    if (exIdx + 1 < totalExercises) { setExIdx(exIdx + 1); setRepIdx(0); restIsEntryRef.current = true; setPhase("preview"); setSecondsLeft(null); }
    else setPhase("summary");
  };

  const beginEndSessionConfirmation = () => {
    flushSpeech();
    setEndSessionConfirmStep(1);
  };

  const closeEndSessionConfirmation = () => {
    setEndSessionConfirmStep(0);
  };

  const confirmEndSession = () => {
    flushSpeech();
    setEndSessionConfirmStep(0);
    setRetakePrompt(null);
    setTrackingIssue(null);
    setPaused(false);
    finalizeCurrentExercise();
    setPhase("summary");
    setSecondsLeft(null);
  };

  const skipCalibration = () => {
    flushSpeech();
    calibBufferRef.current = [];
    calibBsBufferRef.current = [];
    calibMatrixBufferRef.current = [];
    lastCalibLmRef.current = null;
    lastCalibMatrixRef.current = null;
    neutralRef.current = null;
    noiseRef.current = null;
    neutralBsRef.current = null;
    neutralMatrixRef.current = null;
    baselineSnapshotRef.current = captureSnapshot(videoRef.current, snapshotCanvasRef.current);
    restIsEntryRef.current = true;
    setCalibrationProgress(0);
    setCalibrationStatus("Scoring skipped");
    setPhase("preview");
    setSecondsLeft(null);
  };

  const retryCameraSetup = () => {
    flushSpeech();
    setTrackingIssue(null);
    setPostureAligned(false);
    setCameraRetryKey((key) => key + 1);
    if (prefs.symmetryEnabled && prefs.mirrorEnabled) {
      calibBufferRef.current = [];
      calibBsBufferRef.current = [];
      calibMatrixBufferRef.current = [];
      neutralRef.current = null;
      noiseRef.current = null;
      neutralBsRef.current = null;
      neutralMatrixRef.current = null;
      setCalibrationProgress(0);
      setCalibrationStatus("Preparing tracker");
      setPhase("setup");
      setSecondsLeft(null);
    }
  };

  const beginCalibrationFromSetup = () => {
    if (!cameraSetupReady) return;
    flushSpeech();
    setPhase("calibrate");
    setSecondsLeft(null);
  };

  const nextInterstitial = () => { flushSpeech(); setSecondsLeft(0); };

  const handleRetakeBaseline = () => {
    flushSpeech();
    const exerciseId = retakePrompt?.exerciseId;
    if (onRequestProfileRetake && exerciseId) {
      onRequestProfileRetake([exerciseId], { source: "session", reason: retakePrompt?.reason ?? "low-baseline-signal" });
    } else {
      onCancel();
    }
  };

  const handleEndFromRetakePrompt = () => {
    setRetakePrompt(null);
    setTrackingIssue(null);
    beginEndSessionConfirmation();
  };

  const handleSkipFromRetakePrompt = () => {
    setRetakePrompt(null);
    setTrackingIssue(null);
    setPaused(false);
    handleSkipExercise();
  };

  const handleFinish = () => {
    const duration = Math.round((Date.now() - startTimeRef.current) / 1000);
    const validAvgs = exerciseScores.map((e) => e.avg).filter((v) => v != null);
    const sessionAvg = validAvgs.length > 0 ? validAvgs.reduce((a, b) => a + b, 0) / validAvgs.length : null;
    const baselineProgress = summarizeSessionBaselineProgress(exerciseScores);
    const initialBaselineProgress = summarizeSessionBaselineProgress(exerciseScores, "initialBaselineProgress");
    const movementProgress = summarizeSessionMovementProgress(exerciseScores);
    const initialMovementProgress = summarizeSessionMovementProgress(exerciseScores, "initialMovementProgress");
    const captureQuality = summarizeSessionCaptureQuality(exerciseScores);
    const frameSamples = dataCaptureEnabled && frameSamplesRef.current.length ? frameSamplesRef.current : undefined;
    const restingMetrics = summarizeRestingAsymmetry(neutralRef.current, neutralMatrixRef.current);
    onComplete({
      scoringModelVersion: SCORING_MODEL_VERSION,
      date: todayISO(),
      duration,
      exercises: exerciseScores.map((e) => e.exerciseId),
      scores: exerciseScores,
      sessionAvg,
      scoringNoiseMode,
      baselineProgress,
      initialBaselineProgress,
      movementProgress,
      initialMovementProgress,
      setupQuality,
      captureQuality,
      baselineSnapshot: baselineSnapshotRef.current,
      ...(restingMetrics ? { restingMetrics } : {}),
      frameSamples,
      comfortLevel: session.comfortLevel,
      kind: session.kind ?? (exerciseScores.length > 1 ? "session" : "practice"),
      ts: Date.now(),
    });
  };

  if (phase === "summary") return <SessionSummary scores={exerciseScores} sessionsToday={sessionsToday} dailyGoal={prefs.dailyGoal ?? 3} kind={session.kind} startedAt={session.startedAt} comfortLevel={session.comfortLevel} prefs={prefs} baselineProgress={summarizeSessionBaselineProgress(exerciseScores)} initialBaselineProgress={summarizeSessionBaselineProgress(exerciseScores, "initialBaselineProgress")} movementProgress={summarizeSessionMovementProgress(exerciseScores)} initialMovementProgress={summarizeSessionMovementProgress(exerciseScores, "initialMovementProgress")} restingMetrics={summarizeRestingAsymmetry(neutralRef.current, neutralMatrixRef.current)} onFinish={handleFinish} />;
  if (phase === "preview") {
    return (
      <PreviewView
        exercise={current}
        exIdx={exIdx + 1}
        totalExercises={totalExercises}
        onStart={() => { flushSpeech(); setPhase("rest"); setSecondsLeft(currentRestSec); }}
        onCancel={onCancel}
        stream={stream}
        faceLandmarker={faceLandmarker}
        mirrorEnabled={prefs.mirrorEnabled}
        cameraError={cameraError}
        trackerStatus={trackerStatus}
        trackerError={trackerError}
        trackingEnabled={prefs.symmetryEnabled}
        onRetryCameraSetup={retryCameraSetup}
      />
    );
  }
  if (phase === "interstitial") {
    return (
      <InterstitialView
        just={exerciseScores[exerciseScores.length - 1]}
        nextExercise={nextExercise}
        secondsLeft={secondsLeft}
        exIdx={exIdx + 1}
        totalExercises={totalExercises}
        onNext={nextInterstitial}
        onCancel={onCancel}
      />
    );
  }

  const phaseTone = {
    setup: { tag: "CAMERA CHECK", title: "Setup check", prompt: setupQuality?.actionItems?.[0] ?? "Center your face and hold still.", color: setupQualityColor(setupQuality?.key), verb: "setup" },
    calibrate: { tag: "CALIBRATING", title: "Stay relaxed", prompt: calibrationStatus, color: "#D4A574", verb: "calibrate" },
    hold: { tag: "HOLD THE POSE", title: current.name, prompt: current.instruction, color: "#B8543A", verb: "contract" },
    rest: { tag: "RESTING POSE",  title: current.name, prompt: current.instruction, color: "#7A8F73", verb: "rest" },
  }[phase];
  const calibrationPct = Math.round((calibrationProgress / CALIBRATION_FRAMES) * 100);
  const setupPct = setupQuality?.score != null ? Math.round(setupQuality.score * 100) : 0;
  const displayPrompt = autoPaused ? "Paused. Center your face inside the ring to continue." : phaseTone.prompt;
  const plannedSessionSec = session.exercises.reduce((sum, exercise) => sum + exercisePlannedSec(exercise), 0)
    + Math.max(0, totalExercises - 1) * INTERSTITIAL_SEC;
  const remainingInLaterExercises = session.exercises.slice(exIdx + 1).reduce((sum, exercise) => sum + exercisePlannedSec(exercise), 0);
  const remainingInterstitialSec = Math.max(0, totalExercises - exIdx - 1) * INTERSTITIAL_SEC;
  const currentPhaseRemainingSec = typeof secondsLeft === "number" ? Math.max(0, secondsLeft) : 0;
  const currentExerciseRemainingSec = phase === "hold"
    ? currentPhaseRemainingSec + currentRestSec + Math.max(0, currentReps - repIdx - 1) * (currentHoldSec + currentRestSec)
    : phase === "rest"
      ? currentPhaseRemainingSec + (restIsEntryRef.current
        ? currentReps * (currentHoldSec + currentRestSec)
        : Math.max(0, currentReps - repIdx - 1) * (currentHoldSec + currentRestSec))
      : exercisePlannedSec(current);
  const remainingSessionSec = currentExerciseRemainingSec + remainingInLaterExercises + remainingInterstitialSec;
  const elapsedFraction = plannedSessionSec > 0 ? Math.max(0, Math.min(1, 1 - remainingSessionSec / plannedSessionSec)) : 0;
  const clockLabel = formatRemainingTime(remainingSessionSec);
  const remainingExerciseCount = Math.max(0, totalExercises - exIdx - 1);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch lg:items-center lg:justify-center lg:p-6" style={{ background: "rgba(12,10,8,0.92)" }}>
      <div className="flex flex-col w-full h-full lg:w-[440px] lg:h-[860px] lg:max-h-[92vh] lg:rounded-3xl lg:overflow-hidden lg:shadow-2xl" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
      <div className="flex items-center justify-between p-4 shrink-0">
        <button onClick={onCancel} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="End"><X className="w-5 h-5" /></button>
        <div className="text-xs opacity-70">Exercise {exIdx + 1} of {totalExercises}</div>
        <div className="flex gap-2">
          <button onClick={() => { if (!prefs.voiceEnabled) primeSpeech(true, { text: "Voice cues on." }); else flushSpeech(); onTogglePref("voiceEnabled"); }} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Toggle voice">{prefs.voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}</button>
          <button onClick={() => onTogglePref("mirrorEnabled")} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Toggle mirror">{prefs.mirrorEnabled ? <Camera className="w-4 h-4" /> : <CameraOff className="w-4 h-4" />}</button>
        </div>
      </div>

      {symEnabled && (
        <div className="px-4 pb-2 shrink-0">
          <TrackerStatusPill status={trackerStatus} liveScore={liveScore} phase={phase} trackingIssue={trackingIssue} />
        </div>
      )}

      <div className="px-4 pb-3 shrink-0">
        <div className="rounded-2xl p-3" style={{ background: "rgba(244, 239, 230, 0.1)", border: `1px solid ${phaseTone.color}` }}>
          <div className="flex items-end justify-between gap-3 mb-1.5">
            <div className="text-2xl leading-tight" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>
              {phaseTone.title}
            </div>
            <div className="text-4xl tabular-nums leading-none transition-colors duration-300" style={{ fontFamily: "Fraunces", fontWeight: 600, color: phaseTone.color }}>
              {phase === "setup" ? `${setupPct}%` : phase === "calibrate" ? `${calibrationPct}%` : (secondsLeft || "·")}
            </div>
          </div>
          <div className="text-sm leading-relaxed" style={{ color: "#F4EFE6" }}>{displayPrompt}</div>
        </div>
      </div>

      <div className="flex-1 relative overflow-hidden">
        {prefs.mirrorEnabled && !cameraError ? (
          <>
            <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
            <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
            <canvas ref={snapshotCanvasRef} style={{ display: "none" }} />
          </>
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <div className="text-center opacity-60 px-6"><CameraOff className="w-10 h-10 mx-auto mb-3" /><div className="text-sm">{cameraError ?? "Mirror off"}</div></div>
          </div>
        )}

        {(phase === "hold" || phase === "rest" || phase === "calibrate") && (
          <AscentRail
            exercises={session.exercises}
            exIdx={exIdx}
            phase={phase}
            phaseColor={phaseTone.color}
            elapsedFraction={elapsedFraction}
          />
        )}

        {prefs.mirrorEnabled && !cameraError && trackerStatus === "ready" && (
          <div className="absolute top-4 left-4 px-2.5 py-1 rounded-full text-[11px] font-medium" style={{ background: postureAligned ? "rgba(122,143,115,0.85)" : "rgba(212,165,116,0.85)", color: "#1F1B16" }}>
            {postureAligned ? "Posture · centered" : "Center your face in the ring"}
          </div>
        )}

        {phase === "setup" && (cameraSetupReady ? (
          <SetupQualityPanel summary={setupQuality} />
        ) : (
          <div className="absolute left-4 right-4 bottom-4">
            <CameraSetupStatusPanel
              cameraEnabled={prefs.mirrorEnabled}
              trackingEnabled={prefs.symmetryEnabled}
              stream={stream}
              cameraError={cameraError}
              trackerStatus={trackerStatus}
              trackerError={trackerError}
              faceLandmarker={faceLandmarker}
              onRetry={retryCameraSetup}
            />
          </div>
        ))}
        {phase === "calibrate" && !cameraSetupReady && (
          <div className="absolute left-4 right-4 bottom-4">
            <CameraSetupStatusPanel
              cameraEnabled={prefs.mirrorEnabled}
              trackingEnabled={prefs.symmetryEnabled}
              stream={stream}
              cameraError={cameraError}
              trackerStatus={trackerStatus}
              trackerError={trackerError}
              faceLandmarker={faceLandmarker}
              onRetry={retryCameraSetup}
            />
          </div>
        )}

        <div className="absolute top-4 right-[60px] flex flex-col items-end gap-2">
          <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-[11px] font-semibold whitespace-nowrap" style={{ background: "rgba(31, 27, 22, 0.7)", color: "#F4EFE6" }}>
            <span>Rep {repIdx + 1} / {currentReps}</span>
            <span className="h-3 w-px" style={{ background: "rgba(244, 239, 230, 0.28)" }} />
            <span className="tabular-nums">{clockLabel}</span>
          </div>
          {phase === "hold" && liveScore != null && (
            <RealtimeFeedback symmetry={liveScore} balance={liveBalance} baseline={liveBaselineProgress} />
          )}
        </div>

        {autoPaused && (
          <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none">
            <div className="rounded-2xl px-4 py-3 text-center shadow-xl" style={{ background: "rgba(31, 27, 22, 0.88)", border: "1px solid rgba(212, 165, 116, 0.75)", color: "#F4EFE6" }}>
              <div className="text-xs font-bold uppercase tracking-[0.18em] mb-1" style={{ color: "#D4A574" }}>Auto paused</div>
              <div className="text-sm leading-relaxed">Center your face inside the ring to continue.</div>
            </div>
          </div>
        )}

        {(phase === "hold" || phase === "rest" || phase === "calibrate" || phase === "setup") && (
          <div className="absolute inset-x-0 top-0 h-1.5 transition-colors duration-300" style={{ background: phaseTone.color }} />
        )}

        <div className="absolute bottom-4 inset-x-0 flex justify-center pointer-events-none">
          <div className="text-[11px] font-bold uppercase tracking-[0.18em] px-2.5 py-1 rounded-full" style={{ background: phaseTone.color, color: "#1F1B16" }}>
            {phaseTone.tag}
          </div>
        </div>
      </div>

      <div className="p-4 shrink-0" style={{ borderTop: phase === "hold" || phase === "rest" || phase === "calibrate" || phase === "setup" ? `2px solid ${phaseTone.color}` : "2px solid transparent", transition: "border-color 300ms" }}>
        <div className="flex items-start gap-3">
          <button onClick={() => { setPaused((p) => { if (!p) flushSpeech(); return !p; }); }} className="flex-1 rounded-full py-3 flex items-center justify-center gap-2 font-semibold" style={{ background: "rgba(244, 239, 230, 0.15)", color: "#F4EFE6" }}>
            {paused ? <Play className="w-4 h-4 fill-current" /> : <Pause className="w-4 h-4" />}{paused ? "Resume" : "Pause"}
          </button>
          <div className="flex-1 flex flex-col items-stretch gap-1.5">
            <button disabled={phase === "setup" && !cameraSetupReady} onClick={phase === "setup" ? beginCalibrationFromSetup : phase === "calibrate" ? skipCalibration : handleSkipExercise} className="rounded-full py-3 flex items-center justify-center gap-2 font-semibold disabled:opacity-45 disabled:cursor-not-allowed" style={{ background: "#B8543A", color: "#F4EFE6" }}>{phase === "setup" ? "Continue" : phase === "calibrate" ? "Start unscored" : "Skip"}<ChevronRight className="w-4 h-4" /></button>
            {phase === "setup" && (
              <button onClick={skipCalibration} className="self-center text-xs font-semibold underline-offset-4 hover:underline" style={{ color: "rgba(244, 239, 230, 0.74)" }}>
                Start unscored
              </button>
            )}
            {phase !== "calibrate" && phase !== "setup" && (
              <button onClick={beginEndSessionConfirmation} className="self-center text-xs font-semibold underline-offset-4 hover:underline" style={{ color: "rgba(244, 239, 230, 0.74)" }}>
                End session
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
      {endSessionConfirmStep > 0 && (
        <div className="absolute inset-0 z-[75] flex items-center justify-center p-6" style={{ background: "rgba(12,10,8,0.76)" }} role="dialog" aria-modal="true" aria-labelledby="end-session-confirm-title">
          <div className="w-full max-w-sm rounded-2xl p-5 shadow-2xl" style={{ background: "#1F1B16", color: "#F4EFE6", border: "1px solid rgba(212,165,116,0.5)" }}>
            {endSessionConfirmStep === 1 ? (
              <>
                <div id="end-session-confirm-title" className="text-xl mb-2" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>End this session?</div>
                <p className="text-sm leading-relaxed opacity-80 mb-3">
                  This stops the routine now, saves completed reps from {current.name}, and opens the session report.
                </p>
                <p className="text-sm leading-relaxed opacity-80 mb-5">
                  {remainingExerciseCount > 0
                    ? `${remainingExerciseCount} remaining exercise${remainingExerciseCount === 1 ? "" : "s"} will be skipped.`
                    : "No more exercises will run."}
                </p>
                <div className="space-y-2">
                  <button onClick={closeEndSessionConfirmation} className="w-full rounded-full py-3 font-semibold" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6" }}>Keep practicing</button>
                  <button onClick={() => setEndSessionConfirmStep(2)} className="w-full rounded-full py-3 font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>Continue</button>
                </div>
              </>
            ) : (
              <>
                <div id="end-session-confirm-title" className="text-xl mb-2" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>Confirm end session</div>
                <p className="text-sm leading-relaxed opacity-80 mb-5">
                  Final confirmation: Mirror will end this session and show the report. You will not continue to the next exercise.
                </p>
                <div className="space-y-2">
                  <button onClick={() => setEndSessionConfirmStep(1)} className="w-full rounded-full py-3 font-semibold" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6" }}>Back</button>
                  <button onClick={confirmEndSession} className="w-full rounded-full py-3 font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>Yes, end session</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {retakePrompt && (
        <div className="absolute inset-0 z-[70] flex items-center justify-center p-6" style={{ background: "rgba(12,10,8,0.72)" }} role="dialog" aria-modal="true" aria-labelledby="baseline-retake-title">
          <div className="w-full max-w-sm rounded-2xl p-5 shadow-2xl" style={{ background: "#1F1B16", color: "#F4EFE6", border: "1px solid rgba(212,165,116,0.5)" }}>
            <div id="baseline-retake-title" className="text-xl mb-2" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>Retake {retakePrompt.name ?? "exercise"} baseline</div>
            <p className="text-sm leading-relaxed opacity-80 mb-5">Your current movement for {retakePrompt.name ?? "this exercise"} is below the saved baseline, so Mirror is not scoring reps.</p>
            <div className="space-y-2">
              <button onClick={handleRetakeBaseline} className="w-full rounded-full py-3 font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>Retake {retakePrompt.name ?? "baseline"}</button>
              {exIdx + 1 < totalExercises && (
                <button onClick={handleSkipFromRetakePrompt} className="w-full rounded-full py-3 font-semibold" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6" }}>Skip this exercise</button>
              )}
              <button onClick={handleEndFromRetakePrompt} className="w-full rounded-full py-3 font-semibold" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6" }}>End practice</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { SessionMode };
