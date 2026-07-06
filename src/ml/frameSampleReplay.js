import {
  averageBlendshapes,
  averageFacialTransformationMatrix,
  averageLandmarks,
  computeExerciseSymmetryDiagnostic,
  computeNoiseFloor,
  exerciseUsesBlendshapeFusion,
} from "./faceMetrics.js";

function sortSamples(samples = []) {
  return [...samples].filter(Boolean).sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

function sampleLandmarks(sample) {
  return Array.isArray(sample?.landmarks) ? sample.landmarks : Array.isArray(sample?.rawLandmarks) ? sample.rawLandmarks : null;
}

function sampleMatrix(sample) {
  return sample?.facialTransformationMatrix ?? sample?.rawFacialTransformationMatrix ?? null;
}

function finalizeCalibration(buffer) {
  const landmarks = buffer.map((sample) => sampleLandmarks(sample)).filter(Boolean);
  if (!landmarks.length) return null;
  const matrices = buffer.map(sampleMatrix).filter(Boolean);
  const neutral = averageLandmarks(landmarks);
  const neutralMatrix = averageFacialTransformationMatrix(matrices);
  return {
    neutral,
    neutralMatrix,
    noiseFloor: computeNoiseFloor(landmarks, neutral, matrices, neutralMatrix),
    neutralBlendshapes: averageBlendshapes(buffer.map((sample) => sample.blendshapes).filter(Boolean)),
    sampleCount: landmarks.length,
  };
}

function replayFrameSamples(samples = [], options = {}) {
  const minCalibrationSamples = Math.max(1, Math.round(options.minCalibrationSamples ?? 3));
  const sorted = sortSamples(samples);
  const calibrationBuffer = [];
  let calibration = null;
  const frames = [];

  for (const sample of sorted) {
    if (sample.phase === "calibrate") {
      calibrationBuffer.push(sample);
      calibration = null;
      continue;
    }
    if (!calibration && calibrationBuffer.length >= minCalibrationSamples) {
      calibration = finalizeCalibration(calibrationBuffer);
    }
    if (sample.phase !== "hold") continue;

    const diagnostic = computeExerciseSymmetryDiagnostic(
      sample.exerciseId,
      sampleLandmarks(sample),
      calibration?.neutral ?? null,
      calibration?.noiseFloor ?? null,
      sample.blendshapes ?? null,
      calibration?.neutralBlendshapes ?? null,
      sampleMatrix(sample),
      calibration?.neutralMatrix ?? null,
      { scoringNoiseMode: sample.scoringNoiseMode ?? sample.scoring?.scoringNoiseMode },
    );
    const stored = sample.scoring ?? {};
    const storedScored = stored.activated === true;
    const replayScored = diagnostic.scored === true;
    const storedScore = Number.isFinite(stored.rawSymmetry) ? stored.rawSymmetry : null;
    const replayScore = Number.isFinite(diagnostic.result?.symmetry) ? diagnostic.result.symmetry : null;
    const storedPeak = Number.isFinite(stored.peak) ? stored.peak : null;
    const replayPeak = Number.isFinite(diagnostic.result?.peak) ? diagnostic.result.peak : null;
    const bandPeak = replayPeak ?? storedPeak;
    const thresholdBands = stored.thresholdBands ?? sample.thresholdBands ?? null;
    const thresholdMargins = thresholdBands && bandPeak != null ? {
      minimumVisible: Number.isFinite(thresholdBands.minimumVisible) ? Number((bandPeak - thresholdBands.minimumVisible).toFixed(5)) : null,
      reliableMovement: Number.isFinite(thresholdBands.reliableMovement) ? Number((bandPeak - thresholdBands.reliableMovement).toFixed(5)) : null,
      baselineTarget: Number.isFinite(thresholdBands.baselineTarget) ? Number((bandPeak - thresholdBands.baselineTarget).toFixed(5)) : null,
    } : null;
    frames.push({
      id: sample.id ?? null,
      sessionId: sample.sessionId ?? null,
      ts: sample.ts ?? null,
      exerciseId: sample.exerciseId,
      repIndex: sample.repIndex,
      sampleIndex: sample.sampleIndex ?? null,
      storedScored,
      replayScored,
      storedDropReason: stored.dropReason ?? stored.reason ?? null,
      replayDropReason: diagnostic.dropReason,
      storedScore,
      replayScore,
      storedPeak,
      replayPeak,
      bandPeak,
      scoreDelta: storedScore != null && replayScore != null ? replayScore - storedScore : null,
      thresholdBands,
      thresholdMargins,
      calibrationSampleCount: calibration?.sampleCount ?? 0,
    });
  }

  const dropReasonCounts = {};
  let scoredAgreement = 0;
  let scoreDeltaSum = 0;
  let scoreDeltaCount = 0;
  for (const frame of frames) {
    if (frame.storedScored === frame.replayScored) scoredAgreement++;
    if (frame.replayDropReason) dropReasonCounts[frame.replayDropReason] = (dropReasonCounts[frame.replayDropReason] ?? 0) + 1;
    if (Number.isFinite(frame.scoreDelta)) {
      scoreDeltaSum += Math.abs(frame.scoreDelta);
      scoreDeltaCount++;
    }
  }

  return {
    sampleCount: sorted.length,
    holdFrameCount: frames.length,
    scoredFrameCount: frames.filter((frame) => frame.replayScored).length,
    scoredAgreementRatio: frames.length ? Number((scoredAgreement / frames.length).toFixed(4)) : null,
    meanAbsScoreDelta: scoreDeltaCount ? Number((scoreDeltaSum / scoreDeltaCount).toFixed(5)) : null,
    dropReasonCounts,
    frames,
  };
}

function mean(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function round(value, places = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(places)) : null;
}

// Re-derive a single exercise's session score from replayed hold frames, mirroring the
// live loop: a rep score is the time-average of the per-frame symmetry over the frames
// that activated live (`storedScored`), and the exercise score is the mean of its rep
// scores. We reuse the LIVE activation decision (not a re-derived one) so the frame set
// is identical to what produced the stored number — only the per-frame symmetry VALUE
// changes under the fix. Frames the fix now drops (geometry-only, blendshape-rescued)
// contribute no value and fall out of the average, which is the intended correction.
function replayExerciseAverage(framesForExercise) {
  const byRep = new Map();
  for (const frame of framesForExercise) {
    if (frame.storedScored !== true) continue;
    if (!Number.isFinite(frame.replayScore)) continue;
    const repKey = frame.repIndex ?? 0;
    if (!byRep.has(repKey)) byRep.set(repKey, []);
    byRep.get(repKey).push(frame.replayScore);
  }
  const repAverages = [];
  for (const repScores of byRep.values()) {
    const repAvg = mean(repScores);
    if (repAvg != null) repAverages.push(repAvg);
  }
  return mean(repAverages);
}

// Conditional backfill: recompute the session average for sessions that have stored frame
// samples, using the current (fixed) scorer. Only blendshape-fusion exercises can change,
// so every other exercise doubles as a control: if the replay can't reproduce a session's
// non-fusion exercise averages within `scoreTolerance`, the neutral/noise reconstruction is
// untrustworthy and the session is left untouched ("skip-selfcheck"). Pure: takes already
// replayed frames + stored sessions, computes nothing from the wall clock, writes nothing.
function aggregateRescoredSessions(frames = [], sessions = [], options = {}) {
  const scoreTolerance = Number.isFinite(options.scoreTolerance) ? options.scoreTolerance : 0.02;
  const sinceTs = Number.isFinite(options.sinceTs) ? options.sinceTs : null;

  const framesBySession = new Map();
  for (const frame of frames) {
    const sessionId = frame.sessionId ?? null;
    if (sessionId == null) continue;
    if (!framesBySession.has(sessionId)) framesBySession.set(sessionId, []);
    framesBySession.get(sessionId).push(frame);
  }

  const results = [];
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const ts = Number.isFinite(session.ts) ? session.ts : (Number.isFinite(session.createdAt) ? session.createdAt : null);
    if (sinceTs != null && ts != null && ts < sinceTs) continue;

    const storedScores = Array.isArray(session.scores) ? session.scores : [];
    const sessionFrames = framesBySession.get(session.id) ?? [];
    const framesByExercise = new Map();
    for (const frame of sessionFrames) {
      if (!frame.exerciseId) continue;
      if (!framesByExercise.has(frame.exerciseId)) framesByExercise.set(frame.exerciseId, []);
      framesByExercise.get(frame.exerciseId).push(frame);
    }

    const changedExercises = [];
    const controlDeltas = [];
    const newExerciseAvgs = [];
    let recoverable = false;

    for (const score of storedScores) {
      const exerciseId = score?.exerciseId;
      const storedAvg = Number.isFinite(score?.avg) ? score.avg : null;
      const exFrames = exerciseId ? framesByExercise.get(exerciseId) ?? [] : [];
      const replayAvg = exFrames.length ? replayExerciseAverage(exFrames) : null;
      const fusion = exerciseId ? exerciseUsesBlendshapeFusion(exerciseId) : false;

      if (fusion && replayAvg != null) {
        recoverable = true;
        newExerciseAvgs.push(replayAvg);
        changedExercises.push({
          exerciseId,
          storedAvg: round(storedAvg),
          replayAvg: round(replayAvg),
          delta: storedAvg != null ? round(replayAvg - storedAvg) : null,
        });
      } else {
        // Non-fusion (unchanged by the fix) or no usable frames: keep the stored value.
        newExerciseAvgs.push(storedAvg);
        // Non-fusion exercises with replay coverage are the reconstruction control.
        if (!fusion && replayAvg != null && storedAvg != null) {
          controlDeltas.push(Math.abs(replayAvg - storedAvg));
        }
      }
    }

    const storedSessionAvg = Number.isFinite(session.sessionAvg) ? session.sessionAvg : null;
    const maxControlDelta = controlDeltas.length ? Math.max(...controlDeltas) : null;
    const selfCheckPassed = controlDeltas.length ? maxControlDelta <= scoreTolerance : null;

    let verdict;
    if (!recoverable) verdict = "skip-no-frames";
    else if (selfCheckPassed === false) verdict = "skip-selfcheck";
    else if (selfCheckPassed === null) verdict = "rescore-unverified";
    else verdict = "rescore";

    // Only a rescore verdict changes anything; skipped sessions keep their stored average
    // verbatim so the report never shows a phantom delta on a session we won't touch.
    const willRescore = verdict === "rescore" || verdict === "rescore-unverified";
    const newSessionAvg = willRescore ? mean(newExerciseAvgs) : storedSessionAvg;

    results.push({
      sessionId: session.id ?? null,
      ts,
      date: session.date ?? null,
      scoringModelVersion: session.scoringModelVersion ?? null,
      storedSessionAvg: round(storedSessionAvg),
      newSessionAvg: round(newSessionAvg),
      sessionAvgDelta: willRescore && storedSessionAvg != null && newSessionAvg != null ? round(newSessionAvg - storedSessionAvg) : null,
      recoverable,
      controlCount: controlDeltas.length,
      maxControlDelta: round(maxControlDelta, 5),
      selfCheckPassed,
      verdict,
      changedExercises,
    });
  }

  results.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const summary = { rescore: 0, "rescore-unverified": 0, "skip-selfcheck": 0, "skip-no-frames": 0 };
  for (const result of results) summary[result.verdict] = (summary[result.verdict] ?? 0) + 1;

  return { sessionCount: results.length, summary, sessions: results };
}

// Replay each session's frames independently. replayFrameSamples builds one calibration
// (the session neutral) from the leading `calibrate` frames and reuses it for every hold
// frame after it — correct for a single session, but its buffer never resets, so feeding
// many sessions at once pollutes the neutral with cross-session calibrate frames and the
// later sessions' frames all drop. Grouping by sessionId keeps each session's neutral clean.
function rescoreSessionsFromFrameSamples({ frameSamples = [], sessions = [], replayOptions = {}, ...options } = {}) {
  const bySession = new Map();
  for (const sample of frameSamples) {
    const sessionId = sample?.sessionId ?? "(none)";
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push(sample);
  }

  const frames = [];
  let holdFrameCount = 0;
  let scoredFrameCount = 0;
  let agreeCount = 0;
  let deltaSum = 0;
  let deltaCount = 0;
  for (const group of bySession.values()) {
    const replay = replayFrameSamples(group, replayOptions);
    frames.push(...replay.frames);
    holdFrameCount += replay.holdFrameCount;
    scoredFrameCount += replay.scoredFrameCount;
    for (const frame of replay.frames) {
      if (frame.storedScored === frame.replayScored) agreeCount++;
      if (Number.isFinite(frame.scoreDelta)) { deltaSum += Math.abs(frame.scoreDelta); deltaCount++; }
    }
  }

  const report = aggregateRescoredSessions(frames, sessions, options);
  return {
    ...report,
    replayStats: {
      holdFrameCount,
      scoredFrameCount,
      scoredAgreementRatio: holdFrameCount ? Number((agreeCount / holdFrameCount).toFixed(4)) : null,
      meanAbsScoreDelta: deltaCount ? Number((deltaSum / deltaCount).toFixed(5)) : null,
    },
  };
}

function extractFrameSamplesFromExportPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.frameSamples)) return payload.frameSamples;
  if (Array.isArray(payload.sessionFrameSamples)) return payload.sessionFrameSamples;
  if (Array.isArray(payload.stores?.sessionFrameSamples)) return payload.stores.sessionFrameSamples;
  if (Array.isArray(payload.stores?.frameSamples)) return payload.stores.frameSamples;
  if (Array.isArray(payload.sessions)) return payload.sessions.flatMap((session) => session.frameSamples ?? []);
  return [];
}

function extractSessionsFromExportPayload(payload) {
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.stores?.sessions)) return payload.stores.sessions;
  if (Array.isArray(payload.sessions)) return payload.sessions;
  return [];
}

export {
  aggregateRescoredSessions,
  extractFrameSamplesFromExportPayload,
  extractSessionsFromExportPayload,
  replayFrameSamples,
  rescoreSessionsFromFrameSamples,
};
