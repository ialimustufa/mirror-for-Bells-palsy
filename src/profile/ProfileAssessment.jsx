import { useCallback, useEffect, useRef, useState } from "react";
import { X, CameraOff, ChevronRight, Info, Volume2, VolumeX } from "lucide-react";
import { CALIBRATION_FRAMES, CALIBRATION_RESET_EPS, PROFILE_BASELINE_TOP_FRACTION, PROFILE_EXERCISE_NEUTRAL_MIN_FRAMES, PROFILE_HOLD_SEC, PROFILE_REST_RETRY_LIMIT, PROFILE_REST_SEC } from "../domain/config";
import { SETUP_SAMPLE_TARGET, summarizeCaptureSetupQuality } from "../domain/captureSetupQuality";
import { EXERCISE_BY_ID, PROFILE_ASSESSMENT_EXERCISES, PROFILE_STARTER_ASSESSMENT_EXERCISES } from "../domain/exercises";
import { flushSpeech, primeSpeech, speak } from "../lib/speech";
import { useCameraStream } from "../hooks/useCameraStream";
import { useFaceLandmarker } from "../hooks/useFaceLandmarker";
import { CameraSetupStatusPanel, ExerciseAnimation, ExerciseGlyph, LiveExercisePreview, RealtimeFeedback, TrackerStatusPill } from "../components/appViews";
import { displayPct, scoreColor } from "../ui/scoreFormatting";
import { averageBlendshapes, averageFacialTransformationMatrix, averageLandmarks, buildMovementProfile, calibrationPrompt, computeExerciseSymmetry, computeNoiseFloor, createLiveScoreStabilizer, drawOverlay, exerciseBaselineQuality, faceAlignmentFeedback, firstFacialTransformationMatrix, inferLimitedSide, normalizeScoringNoiseMode, normalizedFrameDelta, robustMovementWindow, smoothFacialTransformationMatrix, smoothLandmarks } from "../ml/faceMetrics";

const BASELINE_SETUP_STEPS = [
  { title: "Set up the camera", body: "Use steady light, keep your whole face visible, and sit close enough that the ring can track your brows, eyes, nose, and mouth." },
  { title: "Start fully relaxed", body: "Let your forehead, jaw, lips, and cheeks rest naturally. Mirror records this still pose before it measures movement." },
  { title: "Move gently", body: "During each exercise, make a small clean movement you can hold without strain. Do not chase maximum range." },
  { title: "Return to neutral", body: "After every hold, relax back to your resting face so the next movement gets its own fair baseline." },
];

const BASELINE_PHASE_INSTRUCTIONS = {
  setup: "Center your face while Mirror checks lighting, distance, frame stability, and face visibility before calibration.",
  calibrate: "Relax your face and keep your head still while Mirror records your neutral baseline.",
  rest: "Return to a resting face. This short reset becomes the starting point for the next movement.",
  hold: "Follow the movement cue gently, hold steady, then let the timer guide you back to rest.",
};

function emptyAssessmentFrameStats() {
  return { frames: 0, holdFrames: 0, alignedFrames: 0, leftSum: 0, rightSum: 0, symSum: 0, leftPeak: 0, rightPeak: 0, symPeak: null, samples: [] };
}

function finalizeAssessmentStats(stat, exercise) {
  const frames = stat.frames;
  const robust = robustMovementWindow(stat.samples, PROFILE_BASELINE_TOP_FRACTION);
  const quality = exerciseBaselineQuality(stat);
  return {
    exerciseId: exercise.id,
    name: exercise.name,
    region: exercise.region,
    frames,
    holdFrames: stat.holdFrames ?? frames,
    alignedFrames: stat.alignedFrames ?? 0,
    neutralFrames: stat.neutralFrames ?? 0,
    neutralSource: stat.neutralSource ?? "global",
    quality,
    leftAvg: frames ? stat.leftSum / frames : null,
    rightAvg: frames ? stat.rightSum / frames : null,
    symAvg: frames ? stat.symSum / frames : null,
    leftRobustAvg: robust?.left ?? null,
    rightRobustAvg: robust?.right ?? null,
    symRobustAvg: robust?.symmetry ?? null,
    robustPeakAvg: robust?.peak ?? null,
    baselineFrames: robust?.count ?? 0,
    baselineMethod: robust ? `top-${Math.round(PROFILE_BASELINE_TOP_FRACTION * 100)}-movement-mean` : "mean",
    leftPeak: stat.leftPeak,
    rightPeak: stat.rightPeak,
    symPeak: stat.symPeak,
  };
}

function compactNumber(value, digits = 5) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
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

function BaselineSetupQualityPanel({ summary }) {
  if (!summary) return null;
  const color = setupQualityColor(summary.key);
  const pct = summary.score != null ? Math.round(summary.score * 100) : null;
  const progress = Math.min(1, (summary.sampleCount ?? 0) / SETUP_SAMPLE_TARGET);
  const items = summary.actionItems?.length
    ? summary.actionItems
    : summary.ready
      ? ["Setup looks ready for baseline calibration."]
      : ["Hold still while Mirror checks camera quality."];
  return (
    <div className="absolute left-4 right-4 bottom-4 rounded-2xl p-3" style={{ background: "rgba(31, 27, 22, 0.78)", border: `1px solid ${color}88`, color: "#F4EFE6" }}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <div className="text-xs uppercase tracking-wider opacity-55">Setup quality</div>
          <div className="text-sm font-semibold" style={{ color }}>{summary.label}</div>
        </div>
        <div className="text-2xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color }}>{pct == null ? "--" : pct}</div>
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

function ProfileAssessment({ existingProfile, retakeExerciseIds, prefs, onTogglePref, onComplete, onSkip }) {
  const voiceEnabled = prefs?.voiceEnabled ?? false;
  const scoringNoiseMode = normalizeScoringNoiseMode(prefs?.scoringNoiseMode);
  const scoringDiagnosticsEnabled = prefs?.scoringDiagnosticsEnabled === true;
  const retakeIds = [...new Set((retakeExerciseIds ?? []).filter((id) => EXERCISE_BY_ID.has(id)))];
  const isPartialRetake = retakeIds.length > 0;
  const isCompletionRetake = isPartialRetake && retakeIds.some((id) => !existingProfile?.exercises?.[id]);
  const isFullRetake = !isPartialRetake && Boolean(existingProfile);
  const exerciseIds = isPartialRetake
    ? retakeIds
    : isFullRetake
      ? PROFILE_ASSESSMENT_EXERCISES
      : PROFILE_STARTER_ASSESSMENT_EXERCISES;
  const exercises = exerciseIds.map((id) => EXERCISE_BY_ID.get(id)).filter(Boolean);
  const introTitle = isCompletionRetake
    ? "Add remaining baselines."
    : isPartialRetake
      ? "Retake selected baselines."
      : isFullRetake
        ? "Redo your full baseline."
        : "Let's understand your face first.";
  const introBody = isCompletionRetake
    ? "Mirror will capture the movements that are not in your profile yet and merge them with your starter baseline."
    : isPartialRetake
      ? "Mirror will recalibrate neutral and replace only the selected exercise baselines in your existing profile."
      : isFullRetake
        ? "Mirror will recalibrate neutral and rebuild the full movement profile."
        : "Mirror starts with a shorter set of key movements. You can add the remaining baselines later when you have more time.";
  const setLabel = isCompletionRetake
    ? "Remaining set"
    : isPartialRetake
      ? "Retake set"
      : isFullRetake
        ? "Full assessment set"
        : "Starter assessment set";
  const setExplanation = isCompletionRetake
    ? "Mirror will capture only the missing movement baselines and merge them into your current profile."
    : isPartialRetake
      ? "Mirror will only recapture the selected low-quality movement baselines and merge them into your current profile."
      : isFullRetake
        ? "Mirror captures the full movement catalog to replace your current profile with a fresh baseline."
        : "Mirror captures a shorter starter set now, then prompts for the remaining movement baselines later.";
  const startLabel = isCompletionRetake ? "Start remaining" : isPartialRetake ? "Start retake" : "Start baseline";
  const summaryTitle = isCompletionRetake
    ? "Remaining baselines ready."
    : isPartialRetake
      ? "Selected baselines ready."
      : "Movement profile ready.";
  const summaryBody = isCompletionRetake
    ? "These additional movements will be added to your current profile without replacing the starter baselines."
    : isPartialRetake
      ? "Only these exercise baselines will replace the matching movements in your current profile."
      : "This profile is saved locally and can be used to personalize thresholds and track progress from your starting point.";
  const saveLabel = isCompletionRetake ? "Save additions" : isPartialRetake ? "Save retake" : "Save profile";
  const [phase, setPhase] = useState("intro");
  const [showHelp, setShowHelp] = useState(false);
  const [cameraRetryKey, setCameraRetryKey] = useState(0);
  const [affectedSide, setAffectedSide] = useState("unsure");
  const [comfortLevel, setComfortLevel] = useState("gentle");
  const [exIdx, setExIdx] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(PROFILE_REST_SEC);
  const [postureAligned, setPostureAligned] = useState(false);
  const [calibrationProgress, setCalibrationProgress] = useState(0);
  const [calibrationStatus, setCalibrationStatus] = useState("Preparing tracker");
  const [setupQuality, setSetupQuality] = useState(null);
  const [restStatus, setRestStatus] = useState("Relax your face before the movement.");
  const [liveScore, setLiveScore] = useState(null);
  const [liveBalance, setLiveBalance] = useState(null);
  const [exerciseStats, setExerciseStats] = useState([]);
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const lightingCanvasRef = useRef(null);
  const neutralRef = useRef(null);
  const noiseRef = useRef(null);
  const neutralBsRef = useRef(null);
  const neutralMatrixRef = useRef(null);
  const setupSamplesRef = useRef([]);
  const lastSetupSampleAtRef = useRef(0);
  const calibBufferRef = useRef([]);
  const calibBsBufferRef = useRef([]);
  const calibMatrixBufferRef = useRef([]);
  const lastCalibLmRef = useRef(null);
  const lastCalibMatrixRef = useRef(null);
  const exerciseNeutralRef = useRef(null);
  const exerciseNoiseRef = useRef(null);
  const exerciseNeutralBsRef = useRef(null);
  const exerciseNeutralMatrixRef = useRef(null);
  const restBufferRef = useRef([]);
  const restBsBufferRef = useRef([]);
  const restMatrixBufferRef = useRef([]);
  const restRetryRef = useRef(0);
  const statRef = useRef(emptyAssessmentFrameStats());
  const liveScoreStabilizerRef = useRef(createLiveScoreStabilizer());
  const activeCamera = phase !== "intro" && phase !== "summary";
  const { stream, cameraError } = useCameraStream(activeCamera, cameraRetryKey);
  const { faceLandmarker, latestRef, status: trackerStatus, trackerError } = useFaceLandmarker(activeCamera, cameraRetryKey);
  const current = exercises[exIdx] ?? exercises[0];
  const cameraSetupReady = Boolean(activeCamera && stream && !cameraError && trackerStatus === "ready" && faceLandmarker);
  const scoredStats = exerciseStats.map((s) => s.symAvg).filter((v) => v != null);
  const summaryAvg = scoredStats.length ? scoredStats.reduce((sum, v) => sum + v, 0) / scoredStats.length : null;
  const retakeCount = exerciseStats.filter((s) => s.quality?.key === "retake").length;
  const autoPaused = trackerStatus === "ready" && (phase === "rest" || phase === "hold") && !postureAligned;

  const recordSetupSample = useCallback((sample) => {
    const now = sample?.ts ?? Date.now();
    if (now - lastSetupSampleAtRef.current < 120) return;
    lastSetupSampleAtRef.current = now;
    setupSamplesRef.current = [...setupSamplesRef.current.slice(-80), { ...sample, ts: now }];
    setSetupQuality(summarizeCaptureSetupQuality(setupSamplesRef.current));
  }, []);

  useEffect(() => { if (videoRef.current && stream) videoRef.current.srcObject = stream; }, [stream, exIdx, phase]);

  useEffect(() => () => { flushSpeech(); }, []);

  useEffect(() => {
    if (phase === "setup") {
      speak(voiceEnabled, "Camera setup. Center your face and hold still.");
    } else if (phase === "calibrate") {
      speak(voiceEnabled, "Calibration. Center your face and stay relaxed.");
    } else if (phase === "preview") {
      speak(voiceEnabled, `Up next: ${current.name}. ${current.instruction}`);
    } else if (phase === "rest") {
      speak(voiceEnabled, `${current.name}. Resting pose. Stay relaxed.`);
    } else if (phase === "hold") {
      speak(voiceEnabled, "Hold");
    } else if (phase === "summary") {
      speak(voiceEnabled, "Session complete. Well done.");
    }
  }, [phase, exIdx, voiceEnabled, current?.name, current?.instruction]);

  useEffect(() => {
    if (phase !== "setup") return;
    setupSamplesRef.current = [];
    lastSetupSampleAtRef.current = 0;
    setSetupQuality(summarizeCaptureSetupQuality([]));
  }, [phase]);

  useEffect(() => {
    if (phase !== "calibrate") return;
    neutralRef.current = null;
    noiseRef.current = null;
    neutralBsRef.current = null;
    neutralMatrixRef.current = null;
    calibBufferRef.current = [];
    calibBsBufferRef.current = [];
    calibMatrixBufferRef.current = [];
    lastCalibLmRef.current = null;
    lastCalibMatrixRef.current = null;
    setCalibrationProgress(0);
    setCalibrationStatus("Preparing tracker");
  }, [phase]);

  useEffect(() => {
    if (phase !== "hold") return;
    statRef.current = emptyAssessmentFrameStats();
    statRef.current.neutralFrames = restBufferRef.current.length;
    statRef.current.neutralSource = exerciseNeutralRef.current ? "exercise-rest" : "global";
    liveScoreStabilizerRef.current.reset();
    setLiveScore(null);
    setLiveBalance(null);
  }, [phase, exIdx]);

  useEffect(() => {
    if (phase !== "rest") return;
    restRetryRef.current = 0;
    restBufferRef.current = [];
    restBsBufferRef.current = [];
    restMatrixBufferRef.current = [];
    exerciseNeutralRef.current = null;
    exerciseNoiseRef.current = null;
    exerciseNeutralBsRef.current = null;
    exerciseNeutralMatrixRef.current = null;
    setRestStatus("Relax your face. Capturing a neutral baseline for this exercise.");
  }, [phase, exIdx]);

  useEffect(() => {
    if (phase !== "rest" && phase !== "hold") return;
    if (autoPaused) return;
    if (secondsLeft <= 0) {
      if (phase === "rest") {
        const restFrames = restBufferRef.current;
        if (restFrames.length < PROFILE_EXERCISE_NEUTRAL_MIN_FRAMES && restRetryRef.current < PROFILE_REST_RETRY_LIMIT) {
          restRetryRef.current += 1;
          setRestStatus("Need a steadier neutral pose before this movement. Center your face and stay relaxed.");
          setSecondsLeft(PROFILE_REST_SEC);
          return;
        }
        if (restFrames.length >= PROFILE_EXERCISE_NEUTRAL_MIN_FRAMES) {
          const exerciseNeutral = averageLandmarks(restFrames);
          const exerciseNeutralMatrix = averageFacialTransformationMatrix(restMatrixBufferRef.current);
          exerciseNeutralRef.current = exerciseNeutral;
          exerciseNeutralMatrixRef.current = exerciseNeutralMatrix;
          exerciseNoiseRef.current = computeNoiseFloor(restFrames, exerciseNeutral, restMatrixBufferRef.current, exerciseNeutralMatrix);
          exerciseNeutralBsRef.current = averageBlendshapes(restBsBufferRef.current);
        } else {
          exerciseNeutralRef.current = null;
          exerciseNoiseRef.current = null;
          exerciseNeutralBsRef.current = null;
          exerciseNeutralMatrixRef.current = null;
        }
        setPhase("hold");
        setSecondsLeft(PROFILE_HOLD_SEC);
      } else {
        const stat = finalizeAssessmentStats(statRef.current, current);
        setExerciseStats((prev) => [...prev, stat]);
        if (exIdx + 1 < exercises.length) {
          setExIdx((idx) => idx + 1);
          setPhase("preview");
        } else {
          setPhase("summary");
        }
      }
      return;
    }
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [phase, secondsLeft, exIdx, current, exercises.length, autoPaused]);

  useEffect(() => {
    if (!faceLandmarker || !videoRef.current || !activeCamera) return;
    let raf, alive = true, lastTs = 0;
    const tick = async () => {
      if (!alive) return;
      const v = videoRef.current;
      if (!v || v.readyState < 2 || v.paused) { raf = requestAnimationFrame(tick); return; }
      try {
        const ts = Math.max(lastTs + 1, performance.now());
        lastTs = ts;
        const result = await faceLandmarker.detectForVideo(v, ts);
        if (!alive) return;
        const rawLm = result.faceLandmarks?.[0];
        const bsArr = result.faceBlendshapes?.[0]?.categories;
        const rawMatrix = firstFacialTransformationMatrix(result);
        if (rawLm) {
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

          if (phase === "setup") {
            const lighting = sampleVideoLighting(v, lightingCanvasRef.current);
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
                  setPhase("preview");
                }
              }
            }
          } else if (phase === "rest") {
            if (aligned) {
              restBufferRef.current.push(lm);
              restBsBufferRef.current.push(bsMap);
              restMatrixBufferRef.current.push(facialTransformationMatrix);
              const count = restBufferRef.current.length;
              const remaining = Math.max(0, PROFILE_EXERCISE_NEUTRAL_MIN_FRAMES - count);
              setRestStatus(remaining > 0
                ? `Hold neutral for this exercise. ${remaining} more steady frame${remaining === 1 ? "" : "s"}.`
                : "Exercise neutral captured. Keep relaxed until the movement starts.");
            } else {
              setRestStatus(`${alignment.label} so this exercise gets its own baseline.`);
            }
          } else if (phase === "hold") {
            if (!aligned) {
              liveScoreStabilizerRef.current.reset();
              setLiveScore(null);
              setLiveBalance(null);
            } else {
              const stat = statRef.current;
              stat.holdFrames++;
              stat.alignedFrames++;
              const neutral = exerciseNeutralRef.current ?? neutralRef.current;
              const noise = exerciseNoiseRef.current ?? noiseRef.current;
              const neutralBs = exerciseNeutralBsRef.current ?? neutralBsRef.current;
              const neutralMatrix = exerciseNeutralMatrixRef.current ?? neutralMatrixRef.current;
              const sym = computeExerciseSymmetry(current.id, lm, neutral, noise, bsMap, neutralBs, facialTransformationMatrix, neutralMatrix, { scoringNoiseMode, scoringDiagnosticsEnabled });
              if (sym) {
                stat.frames++;
                stat.leftSum += sym.leftDisp;
                stat.rightSum += sym.rightDisp;
                stat.symSum += sym.symmetry;
                stat.leftPeak = Math.max(stat.leftPeak, sym.leftDisp);
                stat.rightPeak = Math.max(stat.rightPeak, sym.rightDisp);
                stat.symPeak = stat.symPeak == null ? sym.symmetry : Math.max(stat.symPeak, sym.symmetry);
                stat.samples.push({ left: sym.leftDisp, right: sym.rightDisp, symmetry: sym.symmetry, peak: sym.peak });
                const live = liveScoreStabilizerRef.current.update(sym);
                setLiveScore(live?.symmetry ?? null);
                setLiveBalance(live ? { left: live.leftDisp, right: live.rightDisp } : null);
              } else {
                const live = liveScoreStabilizerRef.current.update(null);
                setLiveScore(live?.symmetry ?? null);
                setLiveBalance(live ? { left: live.leftDisp, right: live.rightDisp } : null);
              }
            }
          }
          drawOverlay(overlayRef.current, v, lm, { aligned, phase });
        } else {
          latestRef.current = null;
          liveScoreStabilizerRef.current.reset();
          setPostureAligned(false);
          setLiveScore(null);
          setLiveBalance(null);
          if (phase === "setup") {
            const lighting = sampleVideoLighting(v, lightingCanvasRef.current);
            recordSetupSample({
              facePresent: false,
              aligned: false,
              brightness: lighting?.brightness ?? null,
              contrast: lighting?.contrast ?? null,
            });
          } else if (phase === "calibrate") {
            calibBufferRef.current = [];
            calibBsBufferRef.current = [];
            calibMatrixBufferRef.current = [];
            lastCalibLmRef.current = null;
            lastCalibMatrixRef.current = null;
            setCalibrationProgress(0);
            setCalibrationStatus("Find your face in the camera");
          } else if (phase === "rest") {
            setRestStatus("Find your face in the camera so this exercise gets its own baseline.");
          }
          drawOverlay(overlayRef.current, v, null, { aligned: false, phase });
        }
      } catch {
        // Best-effort assessment; transient frame/model errors should not close the flow.
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [activeCamera, faceLandmarker, latestRef, phase, current.id, recordSetupSample, scoringDiagnosticsEnabled, scoringNoiseMode]);

  const handleBegin = () => {
    setExerciseStats([]);
    setExIdx(0);
    setSecondsLeft(PROFILE_REST_SEC);
    restBufferRef.current = [];
    restBsBufferRef.current = [];
    restMatrixBufferRef.current = [];
    exerciseNeutralRef.current = null;
    exerciseNoiseRef.current = null;
    exerciseNeutralBsRef.current = null;
    exerciseNeutralMatrixRef.current = null;
    primeSpeech(voiceEnabled, { text: "Camera setup. Center your face and hold still.", volume: 1 });
    setPhase("setup");
  };

  const beginCalibrationFromSetup = () => {
    if (!cameraSetupReady) return;
    flushSpeech();
    setPhase("calibrate");
  };

  const retryCameraSetup = () => {
    flushSpeech();
    setPostureAligned(false);
    setLiveScore(null);
    setLiveBalance(null);
    neutralRef.current = null;
    noiseRef.current = null;
    neutralBsRef.current = null;
    neutralMatrixRef.current = null;
    calibBufferRef.current = [];
    calibBsBufferRef.current = [];
    calibMatrixBufferRef.current = [];
    restBufferRef.current = [];
    restBsBufferRef.current = [];
    restMatrixBufferRef.current = [];
    setCalibrationProgress(0);
    setCalibrationStatus("Preparing tracker");
    setCameraRetryKey((key) => key + 1);
    setPhase("setup");
  };

  const handleToggleVoice = () => {
    if (!onTogglePref) return;
    if (!voiceEnabled) primeSpeech(true, { text: "Voice cues on." });
    else flushSpeech();
    onTogglePref("voiceEnabled");
  };

  const handleCancel = () => { flushSpeech(); onSkip(); };

  const handleSave = () => {
    flushSpeech();
    const profile = buildMovementProfile({
      neutral: neutralRef.current,
      noise: noiseRef.current,
      neutralFacialTransformationMatrix: neutralMatrixRef.current,
      exerciseStats,
      affectedSide: isPartialRetake ? existingProfile?.affectedSide ?? affectedSide : affectedSide,
      comfortLevel: isPartialRetake ? existingProfile?.comfortLevel ?? comfortLevel : comfortLevel,
      scoringNoiseMode,
      setupQuality,
    });
    onComplete(profile, { retakeExerciseIds: isPartialRetake ? exerciseIds : null });
  };

  if (phase === "intro") {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-5" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
        <div className="max-w-md w-full max-h-[92vh] overflow-y-auto pr-1">
          <div className="text-xs uppercase tracking-widest opacity-60 mb-3">Personal baseline</div>
          <h2 className="text-4xl mb-3" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>{introTitle}</h2>
          <p className="text-sm leading-relaxed opacity-75 mb-6">{introBody}</p>

          <div className="rounded-2xl p-4 mb-6" style={{ background: "rgba(244,239,230,0.06)", border: "1px solid rgba(244,239,230,0.08)" }}>
            <div className="text-xs uppercase tracking-wider opacity-60 mb-3">How to set a good baseline</div>
            <div className="space-y-3">
              {BASELINE_SETUP_STEPS.map((item, index) => (
                <div key={item.title} className="flex gap-3 text-left">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold" style={{ background: index === 0 ? "#D4A574" : "rgba(244,239,230,0.1)", color: index === 0 ? "#1F1B16" : "#F4EFE6" }}>{index + 1}</div>
                  <div>
                    <div className="text-sm font-semibold">{item.title}</div>
                    <div className="text-xs leading-relaxed opacity-65 mt-0.5">{item.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {!isPartialRetake && <div className="space-y-5 mb-7">
            <div>
              <div className="text-sm font-semibold mb-2">Affected side</div>
              <div className="grid grid-cols-4 gap-2">
                {["left", "right", "both", "unsure"].map((side) => (
                  <button key={side} onClick={() => setAffectedSide(side)} className="rounded-full py-2 text-xs font-semibold capitalize" style={{ background: affectedSide === side ? "#B8543A" : "rgba(244,239,230,0.08)", color: "#F4EFE6", border: affectedSide === side ? "none" : "1px solid rgba(244,239,230,0.14)" }}>{side}</button>
                ))}
              </div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <div className="text-sm font-semibold">Comfort level</div>
                <div className="relative group flex items-center" tabIndex={0} aria-label="Comfort level explanation">
                  <Info className="w-3.5 h-3.5 opacity-60" />
                  <div className="absolute left-0 bottom-full z-10 mb-2 hidden w-64 rounded-2xl px-3 py-2 text-left text-xs leading-relaxed shadow-xl group-hover:block group-focus:block" style={{ background: "#F4EFE6", color: "#1F1B16" }}>
                    Gentle uses shorter holds, fewer reps, and more rest. Normal follows the standard plan. Advanced adds a little more volume when practice feels easy.
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {["gentle", "normal", "advanced"].map((level) => (
                  <button key={level} onClick={() => setComfortLevel(level)} className="rounded-full py-2 text-xs font-semibold capitalize" style={{ background: comfortLevel === level ? "#7A8F73" : "rgba(244,239,230,0.08)", color: "#F4EFE6", border: comfortLevel === level ? "none" : "1px solid rgba(244,239,230,0.14)" }}>{level}</button>
                ))}
              </div>
            </div>
          </div>}

          <div className="rounded-2xl p-4 mb-6" style={{ background: "rgba(244,239,230,0.06)", border: "1px solid rgba(244,239,230,0.08)" }}>
            <div className="flex items-center gap-1.5 mb-3">
              <div className="text-xs uppercase tracking-wider opacity-60">{setLabel}</div>
              <div className="relative group flex items-center" tabIndex={0} aria-label={`${setLabel} explanation`}>
                <Info className="w-3.5 h-3.5 opacity-60" />
                <div className="absolute left-0 bottom-full z-10 mb-2 hidden w-64 rounded-2xl px-3 py-2 text-left text-xs leading-relaxed normal-case tracking-normal shadow-xl group-hover:block group-focus:block" style={{ background: "#F4EFE6", color: "#1F1B16" }}>
                  {setExplanation}
                </div>
              </div>
            </div>
            <div className="grid grid-cols-6 gap-2">
              {exercises.map((ex) => <ExerciseGlyph key={ex.id} exercise={ex} size="xs" tone="dark" className="mx-auto" />)}
            </div>
            <div className="text-xs opacity-55 mt-3">{exercises.length} movements · about {Math.ceil(exercises.length * (PROFILE_REST_SEC + PROFILE_HOLD_SEC) / 60)} minutes</div>
          </div>

          <div className="flex gap-3">
            <button onClick={onSkip} className="flex-1 rounded-full py-3 font-semibold" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6" }}>Skip</button>
            <button onClick={handleBegin} className="flex-1 rounded-full py-3 font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>{startLabel}</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "summary") {
    return (
      <div className="fixed inset-0 z-[60] flex items-center justify-center p-5" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
        <div className="max-w-md w-full max-h-[92vh] overflow-y-auto pr-1">
          <div className="text-xs uppercase tracking-widest opacity-60 mb-3">Baseline complete</div>
          <h2 className="text-4xl mb-3" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>{summaryTitle}</h2>
          <p className="text-sm leading-relaxed opacity-75 mb-6">{summaryBody}</p>
          {summaryAvg != null && (
            <div className="text-center mb-6">
              <div className="text-7xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: scoreColor(summaryAvg), letterSpacing: "-0.03em" }}>{displayPct(summaryAvg)}%</div>
              <div className="text-xs opacity-60 mt-1">initial average symmetry</div>
            </div>
          )}
          {retakeCount > 0 && (
            <div className="rounded-2xl p-3 mb-4 text-xs" style={{ background: "rgba(212,165,116,0.14)", color: "#F6D8B2", border: "1px solid rgba(212,165,116,0.2)" }}>
              {retakeCount} baseline movement{retakeCount === 1 ? "" : "s"} had low-quality capture. You can still save this profile, but those exercises should be retaken later.
            </div>
          )}
          {setupQuality && (
            <div className="rounded-2xl p-3 mb-4 text-xs" style={{ background: `${setupQualityColor(setupQuality.key)}22`, color: setupQualityColor(setupQuality.key), border: `1px solid ${setupQualityColor(setupQuality.key)}44` }}>
              Setup quality saved: {setupQuality.label}. {setupQuality.actionItems?.[0] ?? "Camera setup looked ready for this baseline."}
            </div>
          )}
          <div className="space-y-2 mb-6">
            {exerciseStats.map((stat) => (
              <div key={stat.exerciseId} className="rounded-2xl p-3 flex items-center gap-3" style={{ background: "rgba(244,239,230,0.06)" }}>
                <ExerciseGlyph exerciseId={stat.exerciseId} region={stat.region} size="xs" tone="dark" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{stat.name}</div>
                  <div className="text-xs opacity-55">{stat.frames} scored frame{stat.frames === 1 ? "" : "s"} · baseline: {stat.baselineFrames || 0} robust frame{stat.baselineFrames === 1 ? "" : "s"} · neutral: {stat.neutralSource === "exercise-rest" ? `${stat.neutralFrames} rest frames` : "global"} · limited side: {inferLimitedSide(stat.leftPeak, stat.rightPeak)}</div>
                  {stat.quality && (
                    <div className="text-[11px] mt-0.5" style={{ color: stat.quality.key === "strong" ? "#A8C39F" : stat.quality.key === "usable" ? "#F6D8B2" : "#FFB48F" }}>
                      {stat.quality.label}{stat.quality.issues?.length ? ` · ${stat.quality.issues.join(", ")}` : ""}
                    </div>
                  )}
                </div>
                {stat.symAvg != null ? <div className="text-lg tabular-nums" style={{ fontFamily: "Fraunces", color: scoreColor(stat.symAvg) }}>{displayPct(stat.symAvg)}%</div> : <div className="text-xs opacity-45">—</div>}
              </div>
            ))}
          </div>
          <div className="flex gap-3">
            <button onClick={handleBegin} className="flex-1 rounded-full py-3 font-semibold" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6" }}>Redo</button>
            <button onClick={handleSave} className="flex-1 rounded-full py-3 font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>{saveLabel}</button>
          </div>
        </div>
      </div>
    );
  }

  if (phase === "preview") {
    const useLivePreview = cameraSetupReady;
    return (
      <div className="fixed inset-0 z-[60] flex items-stretch lg:items-center lg:justify-center lg:p-6" style={{ background: "rgba(12,10,8,0.92)" }}>
        <div className="flex flex-col w-full h-full lg:w-[440px] lg:h-[860px] lg:max-h-[92vh] lg:rounded-3xl lg:overflow-hidden lg:shadow-2xl" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
          <div className="flex items-center justify-between p-4 shrink-0">
            <button onClick={handleCancel} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Cancel baseline"><X className="w-5 h-5" /></button>
            <div className="text-xs opacity-70">Exercise {exIdx + 1} of {exercises.length}</div>
            <div className="flex gap-2">
              {onTogglePref && (
                <button onClick={handleToggleVoice} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Toggle voice">{voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}</button>
              )}
              <button onClick={() => setShowHelp(true)} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Show baseline instructions"><Info className="w-5 h-5" /></button>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto px-6 pb-2 flex flex-col items-center text-center">
            <div className="text-xs uppercase tracking-widest opacity-60 mt-2 mb-4">Up next</div>
            {useLivePreview
              ? <LiveExercisePreview exerciseId={current.id} stream={stream} faceLandmarker={faceLandmarker} mirrorEnabled className="mb-5" />
              : <ExerciseAnimation region={current.region} size="lg" className="mb-5" />}
            <div className="text-3xl mb-1" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.01em" }}>{current.name}</div>
            <div className="text-xs opacity-60 mb-5 tracking-wide">{current.region} · {PROFILE_HOLD_SEC}s hold · {PROFILE_REST_SEC}s rest before</div>
            <div className="text-sm leading-relaxed mb-4 max-w-xs" style={{ color: "#F4EFE6" }}>{current.instruction}</div>
            {current.tip && (
              <div className="text-xs leading-relaxed opacity-60 max-w-xs mb-4" style={{ fontStyle: "italic" }}>{current.tip}</div>
            )}
            {!useLivePreview && (
              <CameraSetupStatusPanel
                cameraEnabled={activeCamera}
                trackingEnabled={activeCamera}
                stream={stream}
                cameraError={cameraError}
                trackerStatus={trackerStatus}
                trackerError={trackerError}
                faceLandmarker={faceLandmarker}
                onRetry={retryCameraSetup}
                retryLabel="Retry camera setup"
                className="w-full max-w-xs mb-4"
              />
            )}
          </div>
          <div className="p-4 shrink-0" style={{ borderTop: "1px solid rgba(244,239,230,0.08)" }}>
            <button disabled={!cameraSetupReady} onClick={() => { setPhase("rest"); setSecondsLeft(PROFILE_REST_SEC); }} className="w-full rounded-full px-6 py-4 font-semibold flex items-center justify-center gap-2 text-base disabled:opacity-45 disabled:cursor-not-allowed" style={{ background: "#B8543A", color: "#F4EFE6" }}>
              I'm ready<ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
        {showHelp && (
          <div className="fixed inset-0 z-[70] flex items-end lg:items-center justify-center" style={{ background: "rgba(12,10,8,0.7)" }} onClick={() => setShowHelp(false)}>
            <div className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-t-3xl lg:rounded-3xl p-6" style={{ background: "#1F1B16", color: "#F4EFE6" }} onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs uppercase tracking-widest opacity-60">Baseline guide</div>
                <button onClick={() => setShowHelp(false)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Close"><X className="w-4 h-4" /></button>
              </div>
              <h3 className="text-2xl mb-4" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>How to set a good baseline</h3>
              <div className="space-y-3">
                {BASELINE_SETUP_STEPS.map((item, index) => (
                  <div key={item.title} className="flex gap-3">
                    <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold" style={{ background: "rgba(244,239,230,0.1)", color: "#F4EFE6" }}>{index + 1}</div>
                    <div>
                      <div className="text-sm font-semibold">{item.title}</div>
                      <div className="text-xs leading-relaxed opacity-65 mt-0.5">{item.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const calibrationPct = Math.round((calibrationProgress / CALIBRATION_FRAMES) * 100);
  const phaseTone = phase === "setup"
    ? { tag: "CAMERA CHECK", title: "Setup check", prompt: setupQuality?.actionItems?.[0] ?? "Center your face and hold still.", color: setupQualityColor(setupQuality?.key) }
    : phase === "calibrate"
    ? { tag: "CALIBRATING", title: "Stay relaxed", prompt: calibrationStatus, color: "#D4A574" }
    : phase === "hold"
      ? { tag: "ASSESS", title: current.name, prompt: current.instruction, color: "#B8543A" }
      : { tag: "REST", title: current.name, prompt: restStatus, color: "#7A8F73" };
  const displayPrompt = autoPaused ? "Paused. Center your face inside the ring to continue." : phaseTone.prompt;
  const instruction = autoPaused ? "The timer pauses automatically when your face moves out of alignment." : BASELINE_PHASE_INSTRUCTIONS[phase];

  return (
    <div className="fixed inset-0 z-[60] flex items-stretch lg:items-center lg:justify-center lg:p-6" style={{ background: "rgba(12,10,8,0.92)" }}>
      <div className="flex flex-col w-full h-full lg:w-[440px] lg:h-[860px] lg:max-h-[92vh] lg:rounded-3xl lg:overflow-hidden lg:shadow-2xl" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
        <div className="flex items-center justify-between p-4 shrink-0">
          <button onClick={handleCancel} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Skip baseline"><X className="w-5 h-5" /></button>
          <div className="text-xs opacity-70">{phase === "setup" ? "Camera setup" : phase === "calibrate" ? "Neutral baseline" : `Exercise ${exIdx + 1} of ${exercises.length}`}</div>
          <div className="flex gap-2">
            {onTogglePref && (
              <button onClick={handleToggleVoice} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Toggle voice">{voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}</button>
            )}
            <button onClick={() => setShowHelp(true)} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Show baseline instructions"><Info className="w-5 h-5" /></button>
          </div>
        </div>

        <div className="px-4 pb-2 shrink-0">
          <TrackerStatusPill status={cameraError ? "error" : trackerStatus} liveScore={liveScore} phase={phase} />
        </div>

        <div className="px-4 pb-3 shrink-0">
          <div className="rounded-2xl p-3.5 transition-colors duration-300" style={{ background: "rgba(244,239,230,0.06)", borderLeft: `3px solid ${phaseTone.color}` }}>
            <div className="flex items-center gap-2 mb-1.5">
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] px-2 py-0.5 rounded-full" style={{ background: phaseTone.color, color: "#1F1B16" }}>{phaseTone.tag}</div>
              {phase !== "calibrate" && phase !== "setup" && <div className="text-[11px] opacity-70">{current.region}</div>}
            </div>
            <div className="text-2xl mb-1" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>{phaseTone.title}</div>
            <div className="text-xs leading-relaxed min-h-[2.5em]" style={{ color: phaseTone.color }}>{displayPrompt}</div>
          </div>
        </div>

        <div className="flex-1 relative overflow-hidden">
          {!cameraError ? (
            <>
              <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" style={{ transform: "scaleX(-1)" }} />
              <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />
              <canvas ref={lightingCanvasRef} style={{ display: "none" }} />
            </>
          ) : (
            <div className="w-full h-full flex items-center justify-center">
              <div className="text-center opacity-60 px-6"><CameraOff className="w-10 h-10 mx-auto mb-3" /><div className="text-sm">{cameraError}</div></div>
            </div>
          )}

          {!cameraError && trackerStatus === "ready" && (
            <div className="absolute top-4 left-4 px-2.5 py-1 rounded-full text-[11px] font-medium" style={{ background: postureAligned ? "rgba(122,143,115,0.85)" : "rgba(212,165,116,0.85)", color: "#1F1B16" }}>
              {postureAligned ? "Posture · centered" : "Center your face in the ring"}
            </div>
          )}

          {phase === "hold" && liveScore != null && (
            <div className="absolute top-4 right-4"><RealtimeFeedback symmetry={liveScore} balance={liveBalance} /></div>
          )}

          {phase === "setup" && (cameraSetupReady ? (
            <BaselineSetupQualityPanel summary={setupQuality} />
          ) : (
            <div className="absolute left-4 right-4 bottom-4">
              <CameraSetupStatusPanel
                cameraEnabled={activeCamera}
                trackingEnabled={activeCamera}
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
                cameraEnabled={activeCamera}
                trackingEnabled={activeCamera}
                stream={stream}
                cameraError={cameraError}
                trackerStatus={trackerStatus}
                trackerError={trackerError}
                faceLandmarker={faceLandmarker}
                onRetry={retryCameraSetup}
              />
            </div>
          )}

          {autoPaused && (
            <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none">
              <div className="rounded-2xl px-4 py-3 text-center shadow-xl" style={{ background: "rgba(31, 27, 22, 0.88)", border: "1px solid rgba(212, 165, 116, 0.75)", color: "#F4EFE6" }}>
                <div className="text-xs font-bold uppercase tracking-[0.18em] mb-1" style={{ color: "#D4A574" }}>Auto paused</div>
                <div className="text-sm leading-relaxed">Center your face inside the ring to continue.</div>
              </div>
            </div>
          )}

          <div className="absolute inset-x-0 top-0 h-1 transition-colors duration-300" style={{ background: phaseTone.color }} />
          {phase !== "setup" && (
            <div className="absolute inset-x-0 bottom-0 flex justify-center pointer-events-none">
              <div className="p-6 w-full flex justify-center" style={{ background: "linear-gradient(to top, rgba(31,27,22,0.85) 0%, rgba(31,27,22,0.4) 55%, transparent 100%)" }}>
                <div className="text-7xl tabular-nums transition-colors duration-300" style={{ fontFamily: "Fraunces", fontWeight: 600, color: phaseTone.color, letterSpacing: "-0.03em" }}>
                  {phase === "calibrate" ? `${calibrationPct}%` : (secondsLeft || "·")}
                </div>
              </div>
            </div>
          )}
        </div>

        {phase === "setup" && (
          <div className="p-4 shrink-0" style={{ borderTop: `2px solid ${phaseTone.color}` }}>
            <button disabled={!cameraSetupReady} onClick={beginCalibrationFromSetup} className="w-full rounded-full px-6 py-4 font-semibold flex items-center justify-center gap-2 text-base disabled:opacity-45 disabled:cursor-not-allowed" style={{ background: "#B8543A", color: "#F4EFE6" }}>
              Continue<ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {showHelp && (
        <div className="fixed inset-0 z-[70] flex items-end lg:items-center justify-center" style={{ background: "rgba(12,10,8,0.7)" }} onClick={() => setShowHelp(false)}>
          <div className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-t-3xl lg:rounded-3xl p-6" style={{ background: "#1F1B16", color: "#F4EFE6" }} onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs uppercase tracking-widest opacity-60">Baseline guide</div>
              <button onClick={() => setShowHelp(false)} className="w-8 h-8 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Close"><X className="w-4 h-4" /></button>
            </div>
            <h3 className="text-2xl mb-4" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>How to set a good baseline</h3>
            <div className="space-y-3 mb-5">
              {BASELINE_SETUP_STEPS.map((item, index) => (
                <div key={item.title} className="flex gap-3">
                  <div className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold" style={{ background: "rgba(244,239,230,0.1)", color: "#F4EFE6" }}>{index + 1}</div>
                  <div>
                    <div className="text-sm font-semibold">{item.title}</div>
                    <div className="text-xs leading-relaxed opacity-65 mt-0.5">{item.body}</div>
                  </div>
                </div>
              ))}
            </div>
            <div className="rounded-2xl p-3.5" style={{ background: "rgba(244,239,230,0.06)", borderLeft: `3px solid ${phaseTone.color}` }}>
              <div className="text-[10px] font-bold uppercase tracking-[0.18em] mb-1.5" style={{ color: phaseTone.color }}>{phaseTone.tag} phase</div>
              <div className="text-sm leading-relaxed opacity-85">{instruction}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export { ProfileAssessment };
