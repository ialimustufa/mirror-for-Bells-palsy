import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { APP_SIDE_CONVENTION_VERSION, mergeMovementProfileRetake, needsAppDataMigration, needsSideConventionMigration, normalizeAppData, resetMovementProfileBaselines } from "../src/domain/appData.js";
import { compareMovementProfiles, LEGACY_MOVEMENT_SIDE_CONVENTION, MOVEMENT_SIDE_CONVENTION } from "../src/ml/faceMetrics.js";

const EXERCISE_ID = "closed-smile";

function withTimeZone(timeZone, fn) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    fn();
  } finally {
    if (previous == null) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function makeLegacyExercise() {
  return {
    exerciseId: EXERCISE_ID,
    limitedSide: "left",
    leftMeanMovement: 0.22,
    rightMeanMovement: 1.02,
    leftBaselineMovement: 0.25,
    rightBaselineMovement: 1.1,
    leftPeakMovement: 0.4,
    rightPeakMovement: 1.3,
    initialSymmetry: 0.31,
  };
}

function makeLegacyProfile() {
  return {
    affectedSide: "right",
    exercises: {
      [EXERCISE_ID]: makeLegacyExercise(),
    },
  };
}

test("normalizes legacy image-side profile metrics to user-anatomical sides", () => {
  const legacyData = {
    movementProfile: makeLegacyProfile(),
    initialMovementProfile: makeLegacyProfile(),
    movementProfileHistory: [makeLegacyProfile()],
    prefs: { onboarded: true },
  };

  const normalized = normalizeAppData(legacyData);
  const exercise = normalized.movementProfile.exercises[EXERCISE_ID];

  assert.equal(normalized.sideConventionVersion, APP_SIDE_CONVENTION_VERSION);
  assert.equal(normalized.movementProfile.sideConvention, MOVEMENT_SIDE_CONVENTION);
  assert.equal(normalized.movementProfile.migratedFromSideConvention, LEGACY_MOVEMENT_SIDE_CONVENTION);
  assert.equal(normalized.movementProfile.affectedSide, "right");
  assert.equal(exercise.limitedSide, "right");
  assert.equal(exercise.leftMeanMovement, 1.02);
  assert.equal(exercise.rightMeanMovement, 0.22);
  assert.equal(exercise.leftBaselineMovement, 1.1);
  assert.equal(exercise.rightBaselineMovement, 0.25);
  assert.equal(exercise.leftPeakMovement, 1.3);
  assert.equal(exercise.rightPeakMovement, 0.4);
});

test("marks historical session progress as legacy instead of pretending it was recomputed", () => {
  const legacyData = {
    sessions: [{
      date: "2026-01-01",
      ts: 1,
      baselineProgress: { side: "left", ratio: 1.1 },
      movementProgress: { side: "right", referenceSide: "left", affectedProgressRatio: 1.2 },
      scores: [{
        exerciseId: EXERCISE_ID,
        initialMovementProgress: { side: "right", referenceSide: "left", affectedProgressRatio: 1.4 },
      }],
    }],
  };

  const normalized = normalizeAppData(legacyData);
  const session = normalized.sessions[0];

  assert.equal(session.baselineProgress.sideConvention, LEGACY_MOVEMENT_SIDE_CONVENTION);
  assert.equal(session.movementProgress.sideConvention, LEGACY_MOVEMENT_SIDE_CONVENTION);
  assert.equal(session.movementProgress.side, "right");
  assert.equal(session.scores[0].initialMovementProgress.sideConvention, LEGACY_MOVEMENT_SIDE_CONVENTION);
});

test("normalizes record dates from local timestamps", () => {
  withTimeZone("Asia/Kolkata", () => {
    const ts = new Date(2026, 5, 27, 4, 20).getTime();
    const raw = {
      sessions: [{ date: "2026-06-26", ts, scores: [] }],
      journal: [{ date: "2026-06-26", ts, symmetry: 5 }],
      assessments: [{ date: "2026-06-26", ts, zones: [] }],
    };

    assert.equal(needsAppDataMigration(raw), true);

    const normalized = normalizeAppData(raw);

    assert.equal(normalized.sessions[0].date, "2026-06-27");
    assert.equal(normalized.journal[0].date, "2026-06-27");
    assert.equal(normalized.assessments[0].date, "2026-06-27");
    assert.equal(needsAppDataMigration(normalized), false);
  });
});

test("side-convention migration is idempotent once data is normalized", () => {
  const once = normalizeAppData({
    movementProfile: makeLegacyProfile(),
    sessions: [{ movementProgress: { side: "right", affectedProgressRatio: 1.2 } }],
  });
  const twice = normalizeAppData(once);

  assert.deepEqual(twice.movementProfile, once.movementProfile);
  assert.deepEqual(twice.sessions, once.sessions);
  assert.equal(needsSideConventionMigration(once), false);
});

test("resets selected movement profile baselines and recalculates average symmetry", () => {
  const profile = {
    affectedSide: "right",
    exercises: {
      "closed-smile": { exerciseId: "closed-smile", initialSymmetry: 0.4 },
      "open-smile": { exerciseId: "open-smile", initialSymmetry: 0.8 },
      "eye-close": { exerciseId: "eye-close", initialSymmetry: null },
    },
    initialAvgSymmetry: 0.6,
  };

  const reset = resetMovementProfileBaselines(profile, ["closed-smile", "unknown"], 1234);

  assert.equal(reset.exercises["closed-smile"], undefined);
  assert.ok(reset.exercises["open-smile"]);
  assert.ok(reset.exercises["eye-close"]);
  assert.equal(reset.initialAvgSymmetry, 0.8);
  assert.equal(reset.updatedAt, 1234);
  assert.equal(reset.lastBaselineResetAt, 1234);
  assert.deepEqual(reset.lastBaselineResetExerciseIds, ["closed-smile"]);
});

test("returns the original profile when reset has no matching baselines", () => {
  const profile = {
    exercises: {
      "open-smile": { exerciseId: "open-smile", initialSymmetry: 0.8 },
    },
  };

  assert.equal(resetMovementProfileBaselines(profile, ["closed-smile"], 1234), profile);
});

test("partial retakes record setup quality without replacing the profile setup summary", () => {
  const merged = mergeMovementProfileRetake(
    {
      setupQuality: { key: "strong", sampleCount: 24 },
      calibrationQuality: { avgNoise: 0.01 },
      exercises: {
        "closed-smile": { exerciseId: "closed-smile", initialSymmetry: 0.6 },
      },
    },
    {
      setupQuality: { key: "weak", sampleCount: 24 },
      calibrationQuality: { avgNoise: 0.04 },
      exercises: {
        "open-smile": { exerciseId: "open-smile", initialSymmetry: 0.8 },
      },
    },
  );

  assert.deepEqual(merged.setupQuality, { key: "strong", sampleCount: 24 });
  assert.deepEqual(merged.lastPartialSetupQuality, { key: "weak", sampleCount: 24 });
  assert.deepEqual(merged.lastPartialCalibrationQuality, { avgNoise: 0.04 });
  assert.deepEqual(merged.lastPartialRetakeExerciseIds, ["open-smile"]);
  assert.equal(merged.initialAvgSymmetry, 0.7);
});

test("partial retake freezes the baseline reference but refreshes live-scoring fields", () => {
  const original = {
    exercises: {
      "closed-smile": {
        exerciseId: "closed-smile",
        initialSymmetry: 0.6,
        leftBaselineMovement: 0.02,
        rightBaselineMovement: 0.01,
        activationThreshold: 0.007,
        thresholdBands: { minimumVisible: 0.004, reliableMovement: 0.007, baselineTarget: 0.02 },
      },
    },
  };
  // The user has improved; the retake measures larger movement and a higher threshold.
  const retake = {
    exercises: {
      "closed-smile": {
        exerciseId: "closed-smile",
        initialSymmetry: 0.95,
        leftBaselineMovement: 0.05,
        rightBaselineMovement: 0.045,
        activationThreshold: 0.018,
        thresholdBands: { minimumVisible: 0.01, reliableMovement: 0.018, baselineTarget: 0.05 },
      },
    },
  };

  const merged = mergeMovementProfileRetake(original, retake);
  const ex = merged.exercises["closed-smile"];

  // Frozen reference — must stay at the first calibration so progress isn't erased.
  assert.equal(ex.leftBaselineMovement, 0.02);
  assert.equal(ex.rightBaselineMovement, 0.01);
  assert.equal(ex.initialSymmetry, 0.6);
  assert.equal(ex.thresholdBands.baselineTarget, 0.02);
  assert.equal(merged.initialAvgSymmetry, 0.6);

  // Refreshed live-scoring calibration — tracks the new retake.
  assert.equal(ex.activationThreshold, 0.018);
  assert.equal(ex.thresholdBands.minimumVisible, 0.01);
  assert.equal(ex.thresholdBands.reliableMovement, 0.018);
});

test("first-time retake of a new exercise adopts it as the baseline reference", () => {
  const original = {
    exercises: {
      "closed-smile": { exerciseId: "closed-smile", initialSymmetry: 0.6, leftBaselineMovement: 0.02 },
    },
  };
  const retake = {
    exercises: {
      "open-smile": { exerciseId: "open-smile", initialSymmetry: 0.8, leftBaselineMovement: 0.03 },
    },
  };

  const merged = mergeMovementProfileRetake(original, retake);

  assert.equal(merged.exercises["open-smile"].leftBaselineMovement, 0.03);
  assert.equal(merged.exercises["closed-smile"].leftBaselineMovement, 0.02);
});

test("movement profile comparison uses strict core calibration noise when available", () => {
  const comparison = compareMovementProfiles(
    {
      createdAt: Date.UTC(2026, 0, 2),
      initialAvgSymmetry: 0.8,
      calibrationQuality: { avgNoise: 0.04, coreAvgNoise: 0.008 },
      exercises: { "closed-smile": { exerciseId: "closed-smile", initialSymmetry: 0.8 } },
    },
    {
      createdAt: Date.UTC(2026, 0, 1),
      initialAvgSymmetry: 0.7,
      calibrationQuality: { avgNoise: 0.01, coreAvgNoise: 0.006 },
      exercises: { "closed-smile": { exerciseId: "closed-smile", initialSymmetry: 0.7 } },
    },
  );

  assert.equal(comparison.noiseMetric, "coreAvgNoise");
  assert.equal(comparison.noiseLabel, "Core calibration noise");
  assert.equal(comparison.noiseDelta, 0.002);
});

test("movement profile comparison falls back to legacy average calibration noise", () => {
  const comparison = compareMovementProfiles(
    { calibrationQuality: { avgNoise: 0.02 }, exercises: {} },
    { calibrationQuality: { avgNoise: 0.03 }, exercises: {} },
  );

  assert.equal(comparison.noiseMetric, "avgNoise");
  assert.ok(Math.abs(comparison.noiseDelta + 0.01) < 1e-10);
});

test("normalizes scoring noise prefs with safe defaults", () => {
  const defaults = normalizeAppData({});
  assert.equal(defaults.prefs.scoringNoiseMode, "normal");
  assert.equal(defaults.prefs.scoringDiagnosticsEnabled, false);
  assert.equal(defaults.prefs.clinicalScaleEstimatesEnabled, true);

  const raw = normalizeAppData({ prefs: { scoringNoiseMode: "raw", scoringDiagnosticsEnabled: true, clinicalScaleEstimatesEnabled: false } });
  assert.equal(raw.prefs.scoringNoiseMode, "raw");
  assert.equal(raw.prefs.scoringDiagnosticsEnabled, true);
  assert.equal(raw.prefs.clinicalScaleEstimatesEnabled, false);

  const invalid = normalizeAppData({ prefs: { scoringNoiseMode: "loud", scoringDiagnosticsEnabled: "true", clinicalScaleEstimatesEnabled: "false" } });
  assert.equal(invalid.prefs.scoringNoiseMode, "normal");
  assert.equal(invalid.prefs.scoringDiagnosticsEnabled, false);
  assert.equal(invalid.prefs.clinicalScaleEstimatesEnabled, true);
});

test("normalizes assessments as separate dated records", () => {
  const normalized = normalizeAppData({
    assessments: [
      { ts: 30, zones: [{ zone: "mouth" }] },
      { sourceSessionTs: 10 },
      null,
    ],
  });

  assert.equal(normalized.assessments.length, 2);
  assert.deepEqual(normalized.assessments.map((item) => item.ts), [10, 30]);
  assert.deepEqual(normalized.assessments[0].zones, []);
});
