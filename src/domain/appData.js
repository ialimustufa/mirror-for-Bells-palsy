import { compactAppDataForStorage } from "../storage";
import { LEGACY_MOVEMENT_SIDE_CONVENTION, MOVEMENT_SIDE_CONVENTION, flipLeftRightSide, normalizeScoringNoiseMode, roundMetric } from "../ml/faceMetrics";
import { EXERCISE_BY_ID } from "./exercises";
import { normalizePersonalRecoveryModel } from "./personalRecoveryModel";
import { DEFAULT_DATA, recordDateISO } from "./session";
import { MAX_EXERCISE_REPEATS, MAX_EXERCISE_REPS, MIN_EXERCISE_REPS } from "./config";

export const APP_SIDE_CONVENTION_VERSION = 2;

const PROFILE_SIDE_FIELD_PAIRS = [
  ["leftMeanMovement", "rightMeanMovement"],
  ["leftBaselineMovement", "rightBaselineMovement"],
  ["leftPeakMovement", "rightPeakMovement"],
];

const PROGRESS_FIELDS = [
  "baselineProgress",
  "initialBaselineProgress",
  "movementProgress",
  "initialMovementProgress",
];

function normalizeExerciseIds(ids) {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.filter((id) => EXERCISE_BY_ID.has(id)))];
}

function normalizeRepeatCounts(counts) {
  if (!counts || typeof counts !== "object") return {};
  const result = {};
  for (const [id, value] of Object.entries(counts)) {
    if (!EXERCISE_BY_ID.has(id)) continue;
    const n = Math.round(Number(value));
    // 1 is the implicit default — only persist genuine repeats, clamped to the UI ceiling.
    if (Number.isFinite(n) && n >= 2) result[id] = Math.min(n, MAX_EXERCISE_REPEATS);
  }
  return result;
}

function normalizeRepCounts(counts) {
  if (!counts || typeof counts !== "object") return {};
  const result = {};
  for (const [id, value] of Object.entries(counts)) {
    if (!EXERCISE_BY_ID.has(id)) continue;
    const n = Math.round(Number(value));
    if (Number.isFinite(n) && n >= MIN_EXERCISE_REPS) result[id] = Math.min(n, MAX_EXERCISE_REPS);
  }
  return result;
}

function normalizePersonalPlan(plan) {
  const selectedExerciseIds = normalizeExerciseIds(plan?.selectedExerciseIds);
  const repeatCounts = normalizeRepeatCounts(plan?.repeatCounts);
  const repCounts = normalizeRepCounts(plan?.repCounts);
  const selectedSet = new Set(selectedExerciseIds);
  return {
    selectedExerciseIds,
    addedExerciseIds: normalizeExerciseIds(plan?.addedExerciseIds),
    removedExerciseIds: normalizeExerciseIds(plan?.removedExerciseIds),
    repeatCounts: selectedExerciseIds.length
      ? Object.fromEntries(Object.entries(repeatCounts).filter(([id]) => selectedSet.has(id)))
      : repeatCounts,
    repCounts: selectedExerciseIds.length
      ? Object.fromEntries(Object.entries(repCounts).filter(([id]) => selectedSet.has(id)))
      : repCounts,
  };
}

function normalizeAssessments(assessments) {
  if (!Array.isArray(assessments)) return [];
  return assessments
    .filter((assessment) => assessment && typeof assessment === "object")
    .map((assessment) => normalizeDatedRecord({
      ...assessment,
      zones: Array.isArray(assessment.zones) ? assessment.zones : [],
      ts: assessment.ts ?? assessment.sourceSessionTs ?? Date.now(),
    }))
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

function normalizeDatedRecord(record) {
  if (!record || typeof record !== "object") return record;
  const date = recordDateISO(record);
  return date && date !== record.date ? { ...record, date } : record;
}

function normalizeDatedRecords(records) {
  if (!Array.isArray(records)) return [];
  return records
    .filter((record) => record && typeof record === "object")
    .map(normalizeDatedRecord);
}

export function normalizeAppData(parsed = {}) {
  const compactParsed = compactAppDataForStorage(parsed);
  const rawMovementProfileHistory = Array.isArray(compactParsed.movementProfileHistory) ? compactParsed.movementProfileHistory : [];
  const withInitialProfile = {
    ...compactParsed,
    movementProfileHistory: rawMovementProfileHistory,
    initialMovementProfile: compactParsed.initialMovementProfile ?? rawMovementProfileHistory.at(-1) ?? compactParsed.movementProfile ?? null,
  };
  const migratedParsed = migrateAppDataSideConvention(withInitialProfile);
  const movementProfileHistory = Array.isArray(migratedParsed.movementProfileHistory) ? migratedParsed.movementProfileHistory : [];
  const prefs = { ...DEFAULT_DATA.prefs, ...(migratedParsed.prefs ?? {}) };
  return {
    ...DEFAULT_DATA,
    ...migratedParsed,
    journal: normalizeDatedRecords(migratedParsed.journal),
    sessions: normalizeDatedRecords(migratedParsed.sessions),
    assessments: normalizeAssessments(migratedParsed.assessments),
    movementProfileHistory,
    personalRecoveryModel: normalizePersonalRecoveryModel(migratedParsed.personalRecoveryModel),
    prefs: {
      ...prefs,
      personalModelEnabled: prefs.personalModelEnabled !== false,
      clinicalScaleEstimatesEnabled: prefs.clinicalScaleEstimatesEnabled !== false,
      dataCaptureEnabled: prefs.dataCaptureEnabled === true,
      scoringNoiseMode: normalizeScoringNoiseMode(prefs.scoringNoiseMode),
      scoringDiagnosticsEnabled: prefs.scoringDiagnosticsEnabled === true,
      personalPlan: normalizePersonalPlan(prefs.personalPlan),
    },
  };
}

function swapProfileExerciseSideFields(exercise) {
  if (!exercise || typeof exercise !== "object") return exercise;
  const next = { ...exercise };
  for (const [leftKey, rightKey] of PROFILE_SIDE_FIELD_PAIRS) {
    const leftHasValue = Object.prototype.hasOwnProperty.call(next, leftKey);
    const rightHasValue = Object.prototype.hasOwnProperty.call(next, rightKey);
    if (!leftHasValue && !rightHasValue) continue;
    const leftValue = next[leftKey];
    const rightValue = next[rightKey];
    if (rightHasValue) next[leftKey] = rightValue;
    else delete next[leftKey];
    if (leftHasValue) next[rightKey] = leftValue;
    else delete next[rightKey];
  }
  next.limitedSide = flipLeftRightSide(next.limitedSide);
  return next;
}

function migrateMovementProfileSideConvention(profile) {
  if (!profile || typeof profile !== "object") return profile;
  if (profile.sideConvention === MOVEMENT_SIDE_CONVENTION) return profile;
  const exercises = {};
  for (const [exerciseId, exercise] of Object.entries(profile.exercises ?? {})) {
    exercises[exerciseId] = swapProfileExerciseSideFields(exercise);
  }
  return {
    ...profile,
    sideConvention: MOVEMENT_SIDE_CONVENTION,
    migratedFromSideConvention: profile.sideConvention ?? LEGACY_MOVEMENT_SIDE_CONVENTION,
    exercises,
  };
}

function markLegacyProgressSideConvention(progress) {
  if (!progress || typeof progress !== "object") return progress;
  if (progress.sideConvention === MOVEMENT_SIDE_CONVENTION || progress.sideConvention === LEGACY_MOVEMENT_SIDE_CONVENTION) {
    return progress;
  }
  return {
    ...progress,
    sideConvention: LEGACY_MOVEMENT_SIDE_CONVENTION,
  };
}

function migrateRecordProgressSideConvention(record) {
  if (!record || typeof record !== "object") return record;
  const next = { ...record };
  for (const field of PROGRESS_FIELDS) {
    if (next[field]) next[field] = markLegacyProgressSideConvention(next[field]);
  }
  return next;
}

function migrateSessionSideConvention(session) {
  const next = migrateRecordProgressSideConvention(session);
  if (!next || typeof next !== "object") return next;
  if (Array.isArray(next.scores)) {
    next.scores = next.scores.map(migrateRecordProgressSideConvention);
  }
  return next;
}

function migrateAppDataSideConvention(data) {
  return {
    ...data,
    sideConventionVersion: APP_SIDE_CONVENTION_VERSION,
    movementProfile: migrateMovementProfileSideConvention(data.movementProfile),
    initialMovementProfile: migrateMovementProfileSideConvention(data.initialMovementProfile),
    movementProfileHistory: Array.isArray(data.movementProfileHistory)
      ? data.movementProfileHistory.map(migrateMovementProfileSideConvention)
      : [],
    sessions: Array.isArray(data.sessions) ? data.sessions.map(migrateSessionSideConvention) : [],
    assessments: Array.isArray(data.assessments) ? data.assessments.map(migrateRecordProgressSideConvention) : [],
  };
}

function progressNeedsSideConventionMigration(progress) {
  return Boolean(
    progress
    && typeof progress === "object"
    && progress.sideConvention !== MOVEMENT_SIDE_CONVENTION
    && progress.sideConvention !== LEGACY_MOVEMENT_SIDE_CONVENTION,
  );
}

function recordNeedsProgressSideConventionMigration(record) {
  return Boolean(record && typeof record === "object" && PROGRESS_FIELDS.some((field) => progressNeedsSideConventionMigration(record[field])));
}

function profileNeedsSideConventionMigration(profile) {
  return Boolean(profile && typeof profile === "object" && profile.sideConvention !== MOVEMENT_SIDE_CONVENTION);
}

export function needsSideConventionMigration(data = {}) {
  if (!data || typeof data !== "object") return false;
  if (data.sideConventionVersion !== APP_SIDE_CONVENTION_VERSION) return true;
  if (profileNeedsSideConventionMigration(data.movementProfile) || profileNeedsSideConventionMigration(data.initialMovementProfile)) return true;
  if (Array.isArray(data.movementProfileHistory) && data.movementProfileHistory.some(profileNeedsSideConventionMigration)) return true;
  if (Array.isArray(data.assessments) && data.assessments.some(recordNeedsProgressSideConventionMigration)) return true;
  return Array.isArray(data.sessions) && data.sessions.some((session) => (
    recordNeedsProgressSideConventionMigration(session)
    || (Array.isArray(session.scores) && session.scores.some(recordNeedsProgressSideConventionMigration))
  ));
}

function recordNeedsDateNormalization(record) {
  const date = recordDateISO(record);
  return Boolean(date && record?.date !== date);
}

function needsDateNormalization(data = {}) {
  return (Array.isArray(data.sessions) && data.sessions.some(recordNeedsDateNormalization))
    || (Array.isArray(data.journal) && data.journal.some(recordNeedsDateNormalization))
    || (Array.isArray(data.assessments) && data.assessments.some(recordNeedsDateNormalization));
}

export function needsAppDataMigration(data = {}) {
  return needsSideConventionMigration(data) || needsDateNormalization(data);
}

export function archiveMovementProfile(profile, archivedAt = Date.now()) {
  if (!profile) return null;
  const { neutralLandmarks, noiseFloor, normalization, ...summary } = profile;
  const { neutralFacialTransformationMatrix, ...normalizationSummary } = normalization ?? {};
  const archivedNormalization = normalization
    ? {
      ...normalizationSummary,
      hasNeutralFacialTransformationMatrix: Boolean(neutralFacialTransformationMatrix),
    }
    : null;
  return {
    ...summary,
    ...(archivedNormalization ? { normalization: archivedNormalization } : {}),
    archivedAt,
    hasNeutralLandmarks: Boolean(neutralLandmarks),
    hasNoiseFloor: Boolean(noiseFloor),
  };
}

function averageProfileSymmetry(exercises) {
  const valid = Object.values(exercises ?? {}).map((e) => e.initialSymmetry).filter((v) => v != null);
  return valid.length ? roundMetric(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
}

// Fields that define the original baseline reference. A retake refreshes live-scoring
// calibration (noise floor, neutral, activation/visible threshold bands) but must NOT
// move these — the baseline is the fixed point progress is measured against. If they
// moved, improving and then retaking would re-anchor the baseline to the improved state
// and collapse measured improvement toward zero.
const PROFILE_FROZEN_REFERENCE_FIELDS = [
  "leftBaselineMovement",
  "rightBaselineMovement",
  "initialSymmetry",
  "leftMeanMovement",
  "rightMeanMovement",
  "meanSymmetry",
  "leftPeakMovement",
  "rightPeakMovement",
];

function preserveExerciseReference(oldExercise, newExercise) {
  // First time we have this exercise: the retake IS the reference.
  if (!oldExercise) return newExercise;
  if (!newExercise) return oldExercise;
  const merged = { ...newExercise };
  for (const field of PROFILE_FROZEN_REFERENCE_FIELDS) {
    if (oldExercise[field] != null) merged[field] = oldExercise[field];
  }
  // Keep the original recovery target in the (otherwise refreshed) threshold bands so the
  // coaching goal stays anchored, while minimumVisible/reliableMovement track the new calibration.
  if (newExercise.thresholdBands || oldExercise.thresholdBands) {
    merged.thresholdBands = {
      ...(newExercise.thresholdBands ?? {}),
      ...(oldExercise.thresholdBands?.baselineTarget != null
        ? { baselineTarget: oldExercise.thresholdBands.baselineTarget }
        : {}),
    };
  }
  return merged;
}

export function mergeMovementProfileRetake(currentProfile, partialProfile) {
  if (!currentProfile || !partialProfile?.exercises) return partialProfile;
  const exercises = { ...(currentProfile.exercises ?? {}) };
  for (const [exerciseId, retaken] of Object.entries(partialProfile.exercises)) {
    exercises[exerciseId] = preserveExerciseReference(currentProfile.exercises?.[exerciseId], retaken);
  }
  const retakenExerciseIds = Object.keys(partialProfile.exercises);
  return {
    ...currentProfile,
    updatedAt: Date.now(),
    lastPartialRetakeAt: Date.now(),
    lastPartialRetakeExerciseIds: retakenExerciseIds,
    lastPartialCalibrationQuality: partialProfile.calibrationQuality,
    lastPartialSetupQuality: partialProfile.setupQuality ?? null,
    exercises,
    initialAvgSymmetry: averageProfileSymmetry(exercises),
  };
}

export function mergeMissingMovementProfileBaselines(currentProfile, partialProfile, exerciseIds = []) {
  if (!currentProfile || !partialProfile?.exercises) return currentProfile;
  const additions = {};
  for (const exerciseId of exerciseIds) {
    if (!currentProfile.exercises?.[exerciseId] && partialProfile.exercises[exerciseId]) {
      additions[exerciseId] = partialProfile.exercises[exerciseId];
    }
  }
  if (Object.keys(additions).length === 0) return currentProfile;
  const exercises = { ...(currentProfile.exercises ?? {}), ...additions };
  return {
    ...currentProfile,
    exercises,
    initialAvgSymmetry: averageProfileSymmetry(exercises),
  };
}

export function resetMovementProfileBaselines(profile, exerciseIds = [], resetAt = Date.now()) {
  const ids = normalizeExerciseIds(exerciseIds);
  if (!profile?.exercises || ids.length === 0) return profile;
  const exercises = { ...profile.exercises };
  const removedIds = [];
  for (const exerciseId of ids) {
    if (!exercises[exerciseId]) continue;
    delete exercises[exerciseId];
    removedIds.push(exerciseId);
  }
  if (removedIds.length === 0) return profile;
  return {
    ...profile,
    updatedAt: resetAt,
    lastBaselineResetAt: resetAt,
    lastBaselineResetExerciseIds: removedIds,
    exercises,
    initialAvgSymmetry: averageProfileSymmetry(exercises),
  };
}
