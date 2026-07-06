import {
  CALIBRATION_FRAMES,
  CALIBRATION_RESET_EPS,
  CALIBRATION_STABILITY_EPS,
  FACE_CENTER_MAX_OFFSET,
  FACE_TILT_MAX_RAD,
  HOLD_HEAD_POSE_MAX_RAD,
  PROFILE_BASELINE_TOP_FRACTION,
  PROFILE_EXERCISE_NEUTRAL_MIN_FRAMES,
  PROFILE_MIN_ALIGNMENT_RATIO,
  PROFILE_MIN_SCORED_FRAMES,
  PROFILE_RETAKE_DAYS,
  PROFILE_STEADY_NOISE_MAX,
  PROFILE_USABLE_NOISE_MAX,
  PROFILE_VERSION,
  REPORT_SNAPSHOT_QUALITY,
  REPORT_SNAPSHOT_WIDTH,
} from "../domain/config";
import { DAILY_ESSENTIALS, EXERCISES, PLAN_REGION_ORDER, PROFILE_ASSESSMENT_EXERCISES } from "../domain/exercises";
import { summarizeJournalSafetyPrompts } from "../domain/safetyPrompts";
import { clampNumber, daysBetween, isCountedSession } from "../domain/session";

const SYMMETRY_PAIRS = [[105, 334], [70, 300], [159, 386], [145, 374], [50, 280], [205, 425], [61, 291], [37, 267], [84, 314]];

// Per-exercise blendshape pair — used ONLY for auto-advance gating (activation magnitude),
// not for the symmetry score. The model's L/R blendshape values regress toward each other
// on asymmetric faces and give false-symmetric readings.
const EXERCISE_BLENDSHAPES = {
  "eyebrow-raise": { left: "browOuterUpLeft", right: "browOuterUpRight" },
  "gentle-frown":  { left: "browDownLeft",    right: "browDownRight" },
  "eye-close":     { left: "eyeBlinkLeft",    right: "eyeBlinkRight" },
  "blink":         { left: "eyeBlinkLeft",    right: "eyeBlinkRight" },
  "nose-wrinkle":  { left: "noseSneerLeft",   right: "noseSneerRight" },
  "cheek-suck":    { left: "cheekSquintLeft", right: "cheekSquintRight" },
  "closed-smile":  { left: "mouthSmileLeft",  right: "mouthSmileRight" },
  "open-smile":    { left: "mouthSmileLeft",  right: "mouthSmileRight" },
  "lip-press":     { left: "mouthPressLeft",  right: "mouthPressRight" },
  "emoji-smile":    { left: "mouthSmileLeft",  right: "mouthSmileRight" },
  "emoji-big-smile": { left: "mouthSmileLeft", right: "mouthSmileRight" },
  "emoji-raised-brow": { left: "browOuterUpLeft", right: "browOuterUpRight" },
  "emoji-wink":     { left: "eyeBlinkLeft",    right: "eyeBlinkRight" },
  "emoji-smirk":    { left: "mouthSmileLeft",  right: "mouthSmileRight" },
  "emoji-sad-frown": { left: "mouthFrownLeft", right: "mouthFrownRight" },
  "emoji-nose-scrunch": { left: "noseSneerLeft", right: "noseSneerRight" },
};

const MOVEMENT_SIDE_CONVENTION = "user-anatomical-v1";
const LEGACY_MOVEMENT_SIDE_CONVENTION = "legacy-image-left-v0";
// v3: directional blendshape fusion gates rep activation only; the symmetry ratio is
// computed from geometry alone (previously the per-side assist inflated the healthy side
// and dragged min/max symmetry down). See computeDirectionalExerciseSymmetry.
const SCORING_MODEL_VERSION = 3;
const DEFAULT_SCORING_NOISE_MODE = "normal";
const SCORING_NOISE_MODES = ["normal", "soft", "raw"];
const SCORING_NOISE_MODE_SET = new Set(SCORING_NOISE_MODES);
const SCORING_ABSOLUTE_MIN_SIGNAL = 0.0007;
const SCORE_DROP_REASONS = Object.freeze({
  noFace: "no-face",
  missingNeutral: "missing-neutral",
  headPose: "head-pose",
  alignment: "alignment",
  belowSignalGate: "below-signal-gate",
  belowActivationThreshold: "below-activation-threshold",
  noSymmetryResult: "no-symmetry-result",
});

const SCORING_NOISE_CONFIG = {
  normal: {
    pairwiseNoiseWeight: 0.7,
    pairwiseGate: 0.014,
    directionalNoiseWeight: 0.6,
    directionalGateMultiplier: 1,
    directionalGateCap: 0.012,
    nostrilNoiseWeight: 0.35,
    nostrilGateMultiplier: 0.35,
    nostrilGateCap: 0.0012,
    browNoiseWeight: 1,
    browGateMultiplier: 1.25,
    browGateCap: Infinity,
    browMinSignal: 0.008,
    frownMinSignal: 0.0035,
    noseMinSignal: SCORING_ABSOLUTE_MIN_SIGNAL,
    preserveDirectionalSignal: true,
  },
  soft: {
    pairwiseNoiseWeight: 0.4,
    pairwiseGate: 0.014,
    directionalNoiseWeight: 0.35,
    directionalGateMultiplier: 0.5,
    directionalGateCap: 0.002,
    nostrilNoiseWeight: 0.2,
    nostrilGateMultiplier: 0.2,
    nostrilGateCap: 0.0009,
    browNoiseWeight: 0.35,
    browGateMultiplier: 0.5,
    browGateCap: 0.002,
    browMinSignal: 0.004,
    frownMinSignal: 0.002,
    noseMinSignal: SCORING_ABSOLUTE_MIN_SIGNAL,
    preserveDirectionalSignal: true,
  },
  raw: {
    pairwiseNoiseWeight: 0,
    pairwiseGate: SCORING_ABSOLUTE_MIN_SIGNAL,
    directionalNoiseWeight: 0,
    directionalGateMultiplier: 0,
    directionalGateCap: 0,
    nostrilNoiseWeight: 0,
    nostrilGateMultiplier: 0,
    nostrilGateCap: 0,
    browNoiseWeight: 0,
    browGateMultiplier: 0,
    browGateCap: 0,
    browMinSignal: SCORING_ABSOLUTE_MIN_SIGNAL,
    frownMinSignal: SCORING_ABSOLUTE_MIN_SIGNAL,
    noseMinSignal: SCORING_ABSOLUTE_MIN_SIGNAL,
    preserveDirectionalSignal: false,
  },
};

function normalizeScoringNoiseMode(mode) {
  const value = typeof mode === "string" ? mode.toLowerCase() : "";
  return SCORING_NOISE_MODE_SET.has(value) ? value : DEFAULT_SCORING_NOISE_MODE;
}

function scoringOptionsFrom(options = {}) {
  const scoringNoiseMode = normalizeScoringNoiseMode(typeof options === "string" ? options : options?.scoringNoiseMode);
  // scoringNoiseOverrides lets the replay/calibration harness sweep individual noise-gate
  // constants (e.g. directionalGateCap) without editing source — the mechanism the scoring
  // model comments call for when tuning the gate against captured frames. Production callers
  // never pass it, so the selected mode's config is used verbatim.
  const overrides = (typeof options === "object" && options?.scoringNoiseOverrides && typeof options.scoringNoiseOverrides === "object")
    ? options.scoringNoiseOverrides
    : null;
  return {
    ...SCORING_NOISE_CONFIG[scoringNoiseMode],
    ...(overrides ?? {}),
    scoringNoiseMode,
    scoringDiagnosticsEnabled: Boolean(typeof options === "object" && options?.scoringDiagnosticsEnabled),
  };
}

function bsActivation(bsMap, mapping) {
  if (!bsMap || !mapping) return 0;
  return Math.max(bsMap[mapping.left] ?? 0, bsMap[mapping.right] ?? 0);
}

function flipLeftRightSide(side) {
  if (side === "left") return "right";
  if (side === "right") return "left";
  return side;
}

function toUserSideSymmetryResult(result) {
  if (!result) return result;
  return {
    ...result,
    leftDisp: result.rightDisp,
    rightDisp: result.leftDisp,
    sideConvention: MOVEMENT_SIDE_CONVENTION,
  };
}

function progressUsesLegacySideConvention(progress) {
  return progress?.sideConvention === LEGACY_MOVEMENT_SIDE_CONVENTION;
}

function progressUsesCurrentSideConvention(progress) {
  return progress && !progressUsesLegacySideConvention(progress);
}

// Raw MediaPipe/image-coordinate landmark groups. In a front-facing camera feed,
// image-left corresponds to the user's right; computeExerciseSymmetry converts
// these raw measurements to user/anatomical left/right before callers see them.
// Symmetry is the ratio of the two sides' displacement-from-neutral, computed
// in a face-local frame.
// Groups densified for Bell's palsy sensitivity — affected-side movement is often subtle,
// and more landmarks per side gives spatial averaging that pulls real signal out of noise.
const EXERCISE_LANDMARK_PAIRS = {
  // Brow upper row + lower brow ridge + forehead row above (frontalis muscle)
  "eyebrow-raise":  {
    left:  [70, 63, 105, 66, 107, 46, 53, 52, 65, 55, 109, 67, 104, 69],
    right: [300, 293, 334, 296, 336, 276, 283, 282, 295, 285, 338, 297, 333, 299],
  },
  "gentle-frown":   {
    left:  [70, 63, 105, 66, 107, 46, 53, 52, 65, 55, 109, 67, 104, 69],
    right: [300, 293, 334, 296, 336, 276, 283, 282, 295, 285, 338, 297, 333, 299],
  },
  // Full eye contour — all 16 points around the eye (upper lid, lower lid, inner/outer corner)
  "eye-close":      {
    left:  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
    right: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  },
  "blink":          {
    left:  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
    right: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  },
  "wink":           {
    left:  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
    right: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466],
  },
  // Nostril edge + ala wings + upper-bridge sides (nasalis insertion).
  // Removed unrelated points (infraorbital, lateral cheek) that drift during talking/breathing.
  "nose-wrinkle":   {
    left:  [49, 48, 64, 102, 219, 218, 122],
    right: [279, 278, 294, 331, 439, 438, 351],
  },
  // Mid-cheek + zygomatic + nasolabial fold for fuller buccinator/zygomaticus coverage
  "cheek-puff":     {
    left:  [205, 192, 213, 50, 187, 147, 36, 142, 207, 216],
    right: [425, 416, 433, 280, 411, 376, 266, 371, 427, 436],
  },
  "cheek-suck":     {
    left:  [205, 192, 213, 50, 187, 147, 36, 142, 207, 216],
    right: [425, 416, 433, 280, 411, 376, 266, 371, 427, 436],
  },
  "water-swish":    {
    left:  [205, 192, 213, 50, 187, 147, 36, 142, 207, 216, 61, 84, 91, 146],
    right: [425, 416, 433, 280, 411, 376, 266, 371, 427, 436, 291, 314, 321, 375],
  },
  "water-hold-left": {
    left:  [205, 192, 213, 50, 187, 147, 36, 142, 207, 216, 61, 84, 91, 146],
    right: [425, 416, 433, 280, 411, 376, 266, 371, 427, 436, 291, 314, 321, 375],
  },
  "water-hold-right": {
    left:  [205, 192, 213, 50, 187, 147, 36, 142, 207, 216, 61, 84, 91, 146],
    right: [425, 416, 433, 280, 411, 376, 266, 371, 427, 436, 291, 314, 321, 375],
  },
  // Mouth corner + outer lip ring + inner lip ring + chin corner
  "closed-smile":   {
    left:  [61, 84, 91, 146, 78, 95, 88, 178, 39, 40, 181],
    right: [291, 314, 321, 375, 308, 324, 318, 402, 269, 270, 405],
  },
  "open-smile":     {
    left:  [61, 84, 91, 146, 78, 95, 88, 178, 39, 40, 185, 181, 17],
    right: [291, 314, 321, 375, 308, 324, 318, 402, 269, 270, 409, 405, 17],
  },
  "pucker":         {
    left:  [61, 91, 146, 78, 185, 95, 88, 178, 40, 39, 37, 0],
    right: [291, 321, 375, 308, 409, 324, 318, 402, 270, 269, 267, 0],
  },
  "lip-press":      {
    left:  [61, 84, 91, 78, 95, 88, 178, 39],
    right: [291, 314, 321, 308, 324, 318, 402, 269],
  },
  "vowel-a":        {
    left:  [61, 84, 91, 146, 78, 95, 88, 178, 40, 17, 200],
    right: [291, 314, 321, 375, 308, 324, 318, 402, 270, 17, 200],
  },
  "vowel-e":        {
    left:  [61, 84, 91, 146, 78, 95, 88, 178, 39, 40, 181],
    right: [291, 314, 321, 375, 308, 324, 318, 402, 269, 270, 405],
  },
  "vowel-i":        {
    left:  [61, 84, 91, 78, 95, 88, 178, 39, 40],
    right: [291, 314, 321, 308, 324, 318, 402, 269, 270],
  },
  "vowel-o":        {
    left:  [61, 91, 146, 78, 185, 95, 88, 178, 40, 37, 0],
    right: [291, 321, 375, 308, 409, 324, 318, 402, 270, 267, 0],
  },
  "vowel-u":        {
    left:  [61, 91, 146, 78, 185, 95, 88, 178, 40, 37, 0],
    right: [291, 321, 375, 308, 409, 324, 318, 402, 270, 267, 0],
  },
  "emoji-smile":    {
    left:  [61, 84, 91, 146, 78, 95, 88, 178, 39, 40, 181],
    right: [291, 314, 321, 375, 308, 324, 318, 402, 269, 270, 405],
  },
  "emoji-big-smile": {
    left:  [61, 84, 91, 146, 78, 95, 88, 178, 39, 40, 185, 181, 17],
    right: [291, 314, 321, 375, 308, 324, 318, 402, 269, 270, 409, 405, 17],
  },
  "emoji-surprise": {
    left:  [70, 63, 105, 66, 107, 61, 91, 146, 78, 185, 95, 88, 178, 40, 37, 0, 17],
    right: [300, 293, 334, 296, 336, 291, 321, 375, 308, 409, 324, 318, 402, 270, 267, 0, 17],
  },
  "emoji-raised-brow": {
    left:  [70, 63, 105, 66, 107, 46, 53, 52, 65, 55, 109, 67, 104, 69],
    right: [300, 293, 334, 296, 336, 276, 283, 282, 295, 285, 338, 297, 333, 299],
  },
  "emoji-wink":     {
    left:  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246, 61, 84, 91],
    right: [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466, 291, 314, 321],
  },
  "emoji-smirk":    {
    left:  [61, 84, 91, 146, 78, 95, 88, 178, 39, 40, 181, 205, 50],
    right: [291, 314, 321, 375, 308, 324, 318, 402, 269, 270, 405, 425, 280],
  },
  "emoji-kiss":     {
    left:  [61, 91, 146, 78, 185, 95, 88, 178, 40, 39, 37, 0],
    right: [291, 321, 375, 308, 409, 324, 318, 402, 270, 269, 267, 0],
  },
  "emoji-pucker":   {
    left:  [61, 91, 146, 78, 185, 95, 88, 178, 40, 39, 37, 0],
    right: [291, 321, 375, 308, 409, 324, 318, 402, 270, 269, 267, 0],
  },
  "emoji-sad-frown": {
    left:  [70, 63, 105, 66, 107, 61, 84, 91, 146, 78, 95, 88, 178, 39, 181],
    right: [300, 293, 334, 296, 336, 291, 314, 321, 375, 308, 324, 318, 402, 269, 405],
  },
  "emoji-nose-scrunch": {
    left:  [49, 48, 64, 102, 219, 218, 122, 33, 7, 163, 144, 145, 159, 160],
    right: [279, 278, 294, 331, 439, 438, 351, 263, 249, 390, 373, 374, 386, 387],
  },
};

const WATER_HOLD_SIDE_BY_ID = {
  "water-hold-left": "left",
  "water-hold-right": "right",
};
const WATER_HOLD_OPPOSITE_WEIGHT = 1.25;
const WATER_HOLD_SEAL_LEAK_WEIGHT = 4;
const WATER_HOLD_MOUTH_SEAL_LANDMARKS = {
  left: [61, 84, 91, 146, 78, 95, 88, 178],
  right: [291, 314, 321, 375, 308, 324, 318, 402],
};

const DIRECTIONAL_EXERCISE_SIGNALS = {
  "eye-close": { type: "aperture-decrease", key: "eyeClosure", minSignal: 0.006 },
  "blink": { type: "aperture-decrease", key: "eyeClosure", minSignal: 0.006 },
  "wink": { type: "aperture-decrease", key: "eyeClosure", minSignal: 0.006 },
  "emoji-wink": { type: "aperture-decrease", key: "eyeClosure", minSignal: 0.006 },
  "closed-smile": {
    type: "vector",
    key: "smilePull",
    minSignal: 0.012,
    vectors: { left: { x: -0.88, y: -0.48 }, right: { x: 0.88, y: -0.48 } },
  },
  "open-smile": {
    type: "vector",
    key: "smilePull",
    minSignal: 0.012,
    vectors: { left: { x: -0.88, y: -0.48 }, right: { x: 0.88, y: -0.48 } },
  },
  "emoji-smile": {
    type: "vector",
    key: "smilePull",
    minSignal: 0.012,
    vectors: { left: { x: -0.88, y: -0.48 }, right: { x: 0.88, y: -0.48 } },
  },
  "emoji-big-smile": {
    type: "vector",
    key: "smilePull",
    minSignal: 0.012,
    vectors: { left: { x: -0.88, y: -0.48 }, right: { x: 0.88, y: -0.48 } },
  },
  "emoji-smirk": {
    type: "vector",
    key: "smilePull",
    minSignal: 0.012,
    vectors: { left: { x: -0.88, y: -0.48 }, right: { x: 0.88, y: -0.48 } },
  },
  "pucker": {
    type: "vector",
    key: "puckerInward",
    minSignal: 0.01,
    vectors: { left: { x: 1, y: 0 }, right: { x: -1, y: 0 } },
  },
  "emoji-pucker": {
    type: "vector",
    key: "puckerInward",
    minSignal: 0.01,
    vectors: { left: { x: 1, y: 0 }, right: { x: -1, y: 0 } },
  },
  "emoji-kiss": {
    type: "vector",
    key: "puckerInward",
    minSignal: 0.01,
    vectors: { left: { x: 1, y: 0 }, right: { x: -1, y: 0 } },
  },
  "cheek-puff": {
    type: "vector",
    key: "cheekPuffOutward",
    minSignal: 0.012,
    vectors: { left: { x: -1, y: 0 }, right: { x: 1, y: 0 } },
  },
  "cheek-suck": {
    type: "vector",
    key: "cheekSuckInward",
    minSignal: 0.012,
    vectors: { left: { x: 1, y: 0 }, right: { x: -1, y: 0 } },
  },
  "vowel-a": { type: "aperture-increase", key: "mouthOpen", minSignal: 0.008 },
  "vowel-e": {
    type: "vector",
    key: "smilePull",
    minSignal: 0.012,
    vectors: { left: { x: -0.88, y: -0.48 }, right: { x: 0.88, y: -0.48 } },
  },
  "vowel-i": {
    type: "vector",
    key: "smilePull",
    minSignal: 0.012,
    vectors: { left: { x: -0.88, y: -0.48 }, right: { x: 0.88, y: -0.48 } },
  },
  "vowel-o": {
    type: "vector",
    key: "puckerInward",
    minSignal: 0.01,
    vectors: { left: { x: 1, y: 0 }, right: { x: -1, y: 0 } },
  },
  "vowel-u": {
    type: "vector",
    key: "puckerInward",
    minSignal: 0.01,
    vectors: { left: { x: 1, y: 0 }, right: { x: -1, y: 0 } },
  },
};

// Blendshape fusion for the subtle directional exercises, keyed by the directional
// signal key. MediaPipe blendshapes (eyeBlink/mouthSmile/cheekSquint) capture these
// movements far better than the tiny landmark deltas, which often vanish under the
// noise floor. The assist is added PER SIDE and only when that side already shows a
// little geometric movement in the correct direction (`minRaw`), so the model's
// tendency to report symmetric blendshapes on asymmetric faces can't fabricate a
// score on a side that isn't moving. `weight` maps a 1.0 activation to a mesh-scale
// magnitude. These are initial values; tune empirically against the replay harness.
const DIRECTIONAL_BS_FUSION = {
  eyeClosure: { left: "eyeBlinkLeft", right: "eyeBlinkRight", weight: 0.012, minRaw: 0.0015 },
  smilePull: { left: "mouthSmileLeft", right: "mouthSmileRight", weight: 0.02, minRaw: 0.002 },
  cheekSuckInward: { left: "cheekSquintLeft", right: "cheekSquintRight", weight: 0.02, minRaw: 0.002 },
};

// Whether an exercise's symmetry ratio is affected by the blendshape-fusion change in
// scoring model v3. Only these exercises can score differently under the fix, so a
// rescore/backfill can use the others as an untouched control to validate that its
// neutral/noise reconstruction reproduces the live numbers.
function exerciseUsesBlendshapeFusion(exerciseId) {
  const key = DIRECTIONAL_EXERCISE_SIGNALS[exerciseId]?.key;
  return key != null && Object.prototype.hasOwnProperty.call(DIRECTIONAL_BS_FUSION, key);
}

// Raw image-left is the user's anatomical right, so fuse the opposite-named blendshape
// (matching the convention used by computeNostrilFlareSymmetry). The calibration-time
// neutral activation is subtracted so a face that rests with a slight squint does not
// earn free signal.
function directionalBsActivation(bsMap, neutralBs, fusion, rawSide) {
  if (!bsMap || !fusion) return 0;
  const name = rawSide === "left" ? fusion.right : fusion.left;
  return Math.max(0, (bsMap[name] ?? 0) - (neutralBs?.[name] ?? 0));
}

function facialTransformInfo(matrix) {
  if (!matrix) return null;
  const data = matrix.data ?? matrix;
  if (!data || data.length < 12) return null;
  const rows = matrix.rows ?? 4;
  const columns = matrix.columns ?? (data.length >= 16 ? 4 : 3);
  if (rows < 3 || columns < 3 || data.length < rows * columns) return null;
  return { data, rows, columns };
}

function facialTransformValue(info, row, column) {
  // MediaPipe's MatrixData proto stores packed_data column-major by default,
  // and the C++ face geometry pipeline writes it from Eigen (also column-major).
  // The Tasks Vision JS binding passes packed_data through unchanged, so the
  // (row, column) element lives at data[column * rows + row].
  const value = Number(info.data[column * info.rows + row]);
  return Number.isFinite(value) ? value : null;
}

function cloneFacialTransformationMatrix(matrix) {
  const info = facialTransformInfo(matrix);
  if (!info) return null;
  return {
    rows: info.rows,
    columns: info.columns,
    data: Array.from(info.data, (value) => Number(value)),
  };
}

function firstFacialTransformationMatrix(result) {
  return cloneFacialTransformationMatrix(result?.facialTransformationMatrixes?.[0]);
}

function averageFacialTransformationMatrix(buffer) {
  const matrices = (buffer ?? []).map(cloneFacialTransformationMatrix).filter(Boolean);
  if (!matrices.length) return null;
  const { rows, columns } = matrices[0];
  const length = rows * columns;
  const sums = new Float64Array(length);
  let count = 0;
  for (const matrix of matrices) {
    if (matrix.rows !== rows || matrix.columns !== columns || matrix.data.length < length) continue;
    for (let i = 0; i < length; i++) sums[i] += matrix.data[i];
    count++;
  }
  if (!count) return null;
  return { rows, columns, data: Array.from(sums, (value) => value / count) };
}

function smoothFacialTransformationMatrix(prev, next) {
  const matrix = cloneFacialTransformationMatrix(next);
  if (!matrix) return null;
  const previous = cloneFacialTransformationMatrix(prev);
  if (!previous || previous.rows !== matrix.rows || previous.columns !== matrix.columns || previous.data.length !== matrix.data.length) {
    return matrix;
  }
  const a = SMOOTHING_ALPHA;
  return {
    rows: matrix.rows,
    columns: matrix.columns,
    data: matrix.data.map((value, index) => previous.data[index] + a * (value - previous.data[index])),
  };
}

function compactFacialTransformationMatrix(matrix) {
  const cloned = cloneFacialTransformationMatrix(matrix);
  if (!cloned) return null;
  return {
    rows: cloned.rows,
    columns: cloned.columns,
    data: cloned.data.map((value) => roundMetric(value, 5)),
  };
}

function facialTransformRotation(matrix) {
  const info = facialTransformInfo(matrix);
  if (!info) return null;
  const m00 = facialTransformValue(info, 0, 0), m01 = facialTransformValue(info, 0, 1), m02 = facialTransformValue(info, 0, 2);
  const m10 = facialTransformValue(info, 1, 0), m11 = facialTransformValue(info, 1, 1), m12 = facialTransformValue(info, 1, 2);
  const m20 = facialTransformValue(info, 2, 0), m21 = facialTransformValue(info, 2, 1), m22 = facialTransformValue(info, 2, 2);
  if ([m00, m01, m02, m10, m11, m12, m20, m21, m22].some((value) => value == null)) return null;

  // The 3x3 part of MediaPipe's pose matrix is a pure rotation (canonical face
  // → camera frame), so no scale normalization is needed.
  return {
    r00: m00, r01: m01, r02: m02,
    r10: m10, r11: m11, r12: m12,
    r20: m20, r21: m21, r22: m22,
  };
}

// Angle between two head-pose rotations, in radians. Used to reject hold frames where
// the user has yawed or pitched far from the neutral pose — the 2D alignment gate only
// catches in-plane roll, so without this an off-axis frame still scores even though
// perspective foreshortening and MediaPipe's weakly-scaled normalized z make symmetry
// less reliable. Math: for orthogonal R_a, R_b, trace(R_a · R_bᵀ) = Frobenius inner
// product of the entries = 1 + 2·cos(θ). Returns null when either matrix is missing,
// so callers can treat that as "no gate, defer to other checks".
function headPoseDeviationRad(currentMatrix, neutralMatrix) {
  const a = facialTransformRotation(currentMatrix);
  const b = facialTransformRotation(neutralMatrix);
  if (!a || !b) return null;
  const dot =
    a.r00 * b.r00 + a.r01 * b.r01 + a.r02 * b.r02 +
    a.r10 * b.r10 + a.r11 * b.r11 + a.r12 * b.r12 +
    a.r20 * b.r20 + a.r21 * b.r21 + a.r22 * b.r22;
  const cosTheta = Math.max(-1, Math.min(1, (dot - 1) / 2));
  return Math.acos(cosTheta);
}

function inverseRotateLandmarkDelta(rotation, dx, dy, dz) {
  // MediaPipe normalized landmarks use screen-positive Y. The face-geometry pose
  // matrix follows a 3D camera convention, so flip Y before inverse rotation and
  // flip it back for existing scorer conventions.
  const vx = dx;
  const vy = -dy;
  const vz = dz ?? 0;
  const x = rotation.r00 * vx + rotation.r10 * vy + rotation.r20 * vz;
  const yUp = rotation.r01 * vx + rotation.r11 * vy + rotation.r21 * vz;
  const z = rotation.r02 * vx + rotation.r12 * vy + rotation.r22 * vz;
  return { x, y: -yUp, z };
}

function faceFrameNormalizeFallback(lm) {
  if (!lm || !lm[1] || !lm[33] || !lm[263]) return null;
  const o = lm[1];
  const ex = lm[263].x - lm[33].x, ey = lm[263].y - lm[33].y;
  const scale = Math.hypot(ex, ey);
  if (scale < 0.01) return null;
  const ux = ex / scale, uy = ey / scale;
  const out = new Array(lm.length);
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i]; if (!p) continue;
    const dx = p.x - o.x, dy = p.y - o.y;
    out[i] = {
      x: (dx * ux + dy * uy) / scale,
      y: (-dx * uy + dy * ux) / scale,
      z: ((p.z ?? 0) - (o.z ?? 0)) / scale,
    };
  }
  return out;
}

// Convert landmarks to a face-local frame. When MediaPipe's facial transformation
// matrix is available, remove the 3D head-pose rotation first, then use the
// transformed inter-ocular distance as scale. Fallback keeps the legacy
// nose-origin + eye-line roll/scale frame.
function faceFrameNormalize(lm, facialTransformationMatrix = null) {
  if (!lm || !lm[1] || !lm[33] || !lm[263]) return null;
  const rotation = facialTransformRotation(facialTransformationMatrix);
  if (!rotation) return faceFrameNormalizeFallback(lm);

  const o = lm[1];
  const eyeDelta = inverseRotateLandmarkDelta(
    rotation,
    lm[263].x - lm[33].x,
    lm[263].y - lm[33].y,
    (lm[263].z ?? 0) - (lm[33].z ?? 0),
  );
  const scale = Math.hypot(eyeDelta.x, eyeDelta.y, eyeDelta.z);
  const planarScale = Math.hypot(eyeDelta.x, eyeDelta.y);
  if (scale < 0.01 || planarScale < 0.001) return faceFrameNormalizeFallback(lm);

  const ux = eyeDelta.x / planarScale;
  const uy = eyeDelta.y / planarScale;
  const out = new Array(lm.length);
  for (let i = 0; i < lm.length; i++) {
    const p = lm[i]; if (!p) continue;
    const d = inverseRotateLandmarkDelta(
      rotation,
      p.x - o.x,
      p.y - o.y,
      (p.z ?? 0) - (o.z ?? 0),
    );
    out[i] = {
      x: (d.x * ux + d.y * uy) / scale,
      y: (-d.x * uy + d.y * ux) / scale,
      z: d.z / scale,
    };
  }
  return out;
}

const RESTING_ASYMMETRY_VERSION = 1;
const RESTING_EYE_TOP = {
  left: [173, 157, 158, 159, 160, 161, 246],
  right: [398, 384, 385, 386, 387, 388, 466],
};
const RESTING_EYE_BOTTOM = {
  left: [7, 163, 144, 145, 153, 154, 155],
  right: [249, 390, 373, 374, 380, 381, 382],
};
const RESTING_MIDFACE = {
  midline: [1, 4, 5, 195, 197],
  left: [50, 187, 205, 207, 216, 61, 84, 91, 146],
  right: [280, 411, 425, 427, 436, 291, 314, 321, 375],
};
const RESTING_ORAL_COMMISSURE = {
  left: [61, 84],
  right: [291, 314],
};

function compactMetricValue(value, digits = 4) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function userSideMetric({ label, rawLeft, rawRight, lowSideLabel = "smallerSide", highSideLabel = "largerSide" }) {
  if (!Number.isFinite(rawLeft) || !Number.isFinite(rawRight)) return null;
  const userLeft = rawRight;
  const userRight = rawLeft;
  const difference = userLeft - userRight;
  const absoluteDifference = Math.abs(difference);
  const smallerSide = userLeft < userRight ? "left" : userRight < userLeft ? "right" : "balanced";
  const largerSide = userLeft > userRight ? "left" : userRight > userLeft ? "right" : "balanced";
  return {
    label,
    userLeft: compactMetricValue(userLeft),
    userRight: compactMetricValue(userRight),
    difference: compactMetricValue(difference),
    absoluteDifference: compactMetricValue(absoluteDifference),
    asymmetryRatio: compactMetricValue(absoluteDifference / Math.max(Math.abs(userLeft), Math.abs(userRight), 0.001)),
    [lowSideLabel]: smallerSide,
    [highSideLabel]: largerSide,
  };
}

function eyeAperture(frame, rawSide) {
  const top = avgY(frame, RESTING_EYE_TOP[rawSide]);
  const bottom = avgY(frame, RESTING_EYE_BOTTOM[rawSide]);
  return top == null || bottom == null ? null : Math.max(0, bottom - top);
}

function midfaceDistanceFromMidline(frame, rawSide) {
  const mid = avgXY(frame, RESTING_MIDFACE.midline);
  const side = avgXY(frame, RESTING_MIDFACE[rawSide]);
  if (!mid || !side) return null;
  return rawSide === "left" ? Math.max(0, mid.x - side.x) : Math.max(0, side.x - mid.x);
}

function oralCommissureY(frame, rawSide) {
  return avgY(frame, RESTING_ORAL_COMMISSURE[rawSide]);
}

function summarizeRestingAsymmetry(landmarks, facialTransformationMatrix = null) {
  const frame = faceFrameNormalize(landmarks, facialTransformationMatrix);
  if (!frame) return null;
  const palpebralFissure = userSideMetric({
    label: "Palpebral fissure",
    rawLeft: eyeAperture(frame, "left"),
    rawRight: eyeAperture(frame, "right"),
    lowSideLabel: "narrowerSide",
    highSideLabel: "widerSide",
  });
  const nasolabialMidface = userSideMetric({
    label: "Nasolabial/midface proxy",
    rawLeft: midfaceDistanceFromMidline(frame, "left"),
    rawRight: midfaceDistanceFromMidline(frame, "right"),
    lowSideLabel: "smallerSide",
    highSideLabel: "largerSide",
  });
  const oralCommissure = userSideMetric({
    label: "Oral commissure vertical position",
    rawLeft: oralCommissureY(frame, "left"),
    rawRight: oralCommissureY(frame, "right"),
    lowSideLabel: "higherSide",
    highSideLabel: "lowerSide",
  });
  const metrics = { palpebralFissure, nasolabialMidface, oralCommissure };
  const values = Object.values(metrics).map((item) => item?.asymmetryRatio).filter(Number.isFinite);
  return {
    version: RESTING_ASYMMETRY_VERSION,
    coordinateFrame: facialTransformRotation(facialTransformationMatrix) ? "matrix-face-local-v1" : "eye-line-face-local-v1",
    metrics,
    averageAsymmetryRatio: values.length ? compactMetricValue(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
  };
}

function noiseFloorValue(noiseFloor, index) {
  if (!noiseFloor) return 0;
  const values = noiseFloorValues(noiseFloor);
  const value = values[index];
  return Number.isFinite(value) ? value : 0;
}

function noiseFloorValues(noiseFloor) {
  if (!noiseFloor) return null;
  if (Array.isArray(noiseFloor) || ArrayBuffer.isView(noiseFloor)) return noiseFloor;
  if (Array.isArray(noiseFloor.values) || ArrayBuffer.isView(noiseFloor.values)) return noiseFloor.values;
  return noiseFloor;
}

function directionalNoiseFloor(noiseFloor) {
  return noiseFloor?.directional ?? null;
}

function directionalSideNoise(noiseFloor, key, side, fallback = 0) {
  const directional = directionalNoiseFloor(noiseFloor);
  const value = directional?.[key]?.[side] ?? (key === "nostrilOutward" ? noiseFloor?.nostrilOutward?.[side] : null);
  return Number.isFinite(value) ? value : fallback;
}

function landmarkNoiseTotal(noiseFloor, idxs) {
  const values = noiseFloorValues(noiseFloor);
  if (!values || !idxs?.length) return null;
  let total = 0, count = 0;
  for (const idx of idxs) {
    const value = values[idx];
    if (!Number.isFinite(value)) continue;
    total += Math.max(0, value);
    count++;
  }
  return count ? { sum: total, average: total / count } : null;
}

function directionalSideNoiseWithFallback(noiseFloor, key, side, idxs, config) {
  const directional = directionalSideNoise(noiseFloor, key, side, null);
  if (directional != null) return directional;
  const landmarkNoise = landmarkNoiseTotal(noiseFloor, idxs);
  if (!landmarkNoise) return 0;
  return config?.type === "vector" ? landmarkNoise.sum : landmarkNoise.average;
}

function adjustedSignal(rawSignal, noise, noiseWeight) {
  const raw = Number.isFinite(rawSignal) ? rawSignal : 0;
  const safeNoise = Number.isFinite(noise) ? Math.max(0, noise) : 0;
  const penalty = safeNoise * Math.max(0, noiseWeight ?? 0);
  return {
    raw,
    noise: safeNoise,
    noisePenalty: penalty,
    adjusted: Math.max(0, raw - penalty),
  };
}

function noiseGate(noise, multiplier, cap = Infinity) {
  const safeNoise = Number.isFinite(noise) ? Math.max(0, noise) : 0;
  const weighted = safeNoise * Math.max(0, multiplier ?? 0);
  return Number.isFinite(cap) ? Math.min(weighted, cap) : weighted;
}

function sumDisp(lmN, neuN, idxs, noiseFloor, scoringOptions = {}) {
  // Sum of per-landmark distance from neutral, with each point's natural at-rest jitter
  // subtracted out. This pulls subtle real movement (e.g. affected-side recruitment in
  // Bell's palsy) above the noise band so it can be scored.
  const options = scoringOptionsFrom(scoringOptions);
  let rawTotal = 0;
  let noisePenaltyTotal = 0;
  let adjustedTotal = 0;
  for (const i of idxs) {
    const a = lmN[i], b = neuN[i]; if (!a || !b) continue;
    const d = Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
    const adjusted = adjustedSignal(d, noiseFloorValue(noiseFloor, i), options.pairwiseNoiseWeight);
    rawTotal += adjusted.raw;
    noisePenaltyTotal += adjusted.noisePenalty;
    adjustedTotal += adjusted.adjusted;
  }
  return { raw: rawTotal, noisePenalty: noisePenaltyTotal, adjusted: adjustedTotal };
}

function computePairwiseSymmetry(lm, neutral, mapping, noiseFloor, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  if (!mapping || !neutral) return null;
  const options = scoringOptionsFrom(scoringOptions);
  const exerciseId = typeof scoringOptions === "object" ? scoringOptions?.exerciseId ?? "pairwise" : "pairwise";
  const lmN = faceFrameNormalize(lm, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!lmN || !neuN) {
    logScoringDiagnostics(exerciseId, "normalize failed", { hasCurrent: Boolean(lmN), hasNeutral: Boolean(neuN) }, options);
    return null;
  }
  const lDisp = sumDisp(lmN, neuN, mapping.left, noiseFloor, options);
  const rDisp = sumDisp(lmN, neuN, mapping.right, noiseFloor, options);
  const lAdjusted = lDisp.adjusted;
  const rAdjusted = rDisp.adjusted;
  const peak = Math.max(lAdjusted, rAdjusted);
  // Lower threshold than the pre-denoising version (0.04 → 0.02): with per-landmark noise
  // subtracted out, the residual is real motion, so we can score smaller movements.
  const debugPayload = {
    rawImageLeft: {
      signal: debugMetric(lDisp.raw),
      noisePenalty: debugMetric(lDisp.noisePenalty),
      adjusted: debugMetric(lAdjusted),
      final: debugMetric(lAdjusted),
    },
    rawImageRight: {
      signal: debugMetric(rDisp.raw),
      noisePenalty: debugMetric(rDisp.noisePenalty),
      adjusted: debugMetric(rAdjusted),
      final: debugMetric(rAdjusted),
    },
    returnedUserLeftDisp: debugMetric(rAdjusted),
    returnedUserRightDisp: debugMetric(lAdjusted),
    peak: debugMetric(peak),
    gate: debugMetric(options.pairwiseGate),
    noiseSource: "landmark-distance",
    activationState: { aboveGate: peak >= options.pairwiseGate },
  };
  if (peak < options.pairwiseGate) {
    logScoringDiagnostics(exerciseId, "below signal gate", debugPayload, options);
    return null;
  }
  const symmetry = Math.min(lAdjusted, rAdjusted) / peak;
  logScoringDiagnostics(exerciseId, "scored", { ...debugPayload, symmetry: debugMetric(symmetry) }, options);
  return { symmetry, leftDisp: lAdjusted, rightDisp: rAdjusted, peak };
}

function verticalSpread(frame, idxs) {
  let minY = Infinity, maxY = -Infinity, count = 0;
  for (const i of idxs) {
    const p = frame[i];
    if (!p) continue;
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
    count++;
  }
  return count ? maxY - minY : null;
}

function normalizedVector(vector) {
  const x = Number(vector?.x ?? 0);
  const y = Number(vector?.y ?? 0);
  const z = Number(vector?.z ?? 0);
  const length = Math.hypot(x, y, z);
  return length > 0 ? { x: x / length, y: y / length, z: z / length } : null;
}

function vectorProjectionSignal(frame, neutralFrame, idxs, vector) {
  const unit = normalizedVector(vector);
  if (!unit) return null;
  let total = 0, count = 0;
  for (const i of idxs ?? []) {
    const current = frame[i], neutralPoint = neutralFrame[i];
    if (!current || !neutralPoint) continue;
    const dx = current.x - neutralPoint.x;
    const dy = current.y - neutralPoint.y;
    const dz = (current.z ?? 0) - (neutralPoint.z ?? 0);
    total += Math.max(0, dx * unit.x + dy * unit.y + dz * unit.z);
    count++;
  }
  return count ? total : null;
}

function eyeClosureRawSignal(frame, neutralFrame, rawSide) {
  const curTop = avgY(frame, RESTING_EYE_TOP[rawSide]);
  const curBottom = avgY(frame, RESTING_EYE_BOTTOM[rawSide]);
  const neutralTop = avgY(neutralFrame, RESTING_EYE_TOP[rawSide]);
  const neutralBottom = avgY(neutralFrame, RESTING_EYE_BOTTOM[rawSide]);
  if ([curTop, curBottom, neutralTop, neutralBottom].some((value) => value == null)) return null;
  const currentAperture = Math.max(0, curBottom - curTop);
  const neutralAperture = Math.max(0, neutralBottom - neutralTop);
  const apertureClose = Math.max(0, neutralAperture - currentAperture);
  const centerShift = Math.abs(((curTop + curBottom) / 2) - ((neutralTop + neutralBottom) / 2));
  // Eye closure is the upper and lower lids CONVERGING — the upper lid does most of the travel,
  // so the lid-pair center naturally shifts downward during a normal close. We must still reject
  // common-mode artifacts (a head bob, or a normalization scale change from lateral eye drift)
  // that shrink the apparent gap without the lids actually converging. Use the center shift as a
  // GATE rather than a linear subtraction. For lid travels a (top down) and b (bottom up),
  // apertureClose = a + b and centerShift = |a - b| / 2, so a genuine convergent close has
  // centerShift / apertureClose <= 0.5 (max 0.5 when only one lid moves — the normal upper-lid
  // close). Translation/scale drives the center as hard as the gap, pushing the ratio above 0.5
  // (the lateral-drift artifact sits at ~0.67). Reject above 0.5, otherwise score the FULL
  // aperture reduction. Previously we SUBTRACTED centerShift, which cancelled the upper-lid
  // travel that IS the close and roughly halved a genuine closure.
  if (2 * centerShift > apertureClose) return 0;
  return apertureClose;
}

function directionalRawSignal(frame, neutralFrame, mapping, config, rawSide) {
  const idxs = mapping?.[rawSide];
  if (!idxs?.length) return null;
  if (config.type === "vector") {
    return vectorProjectionSignal(frame, neutralFrame, idxs, config.vectors?.[rawSide]);
  }
  if (config.key === "eyeClosure") return eyeClosureRawSignal(frame, neutralFrame, rawSide);
  const currentSpread = verticalSpread(frame, idxs);
  const neutralSpread = verticalSpread(neutralFrame, idxs);
  if (currentSpread == null || neutralSpread == null) return null;
  if (config.type === "aperture-decrease") return Math.max(0, neutralSpread - currentSpread);
  if (config.type === "aperture-increase") return Math.max(0, currentSpread - neutralSpread);
  return null;
}

function directionalExerciseRawSignals(exerciseId, frame, neutralFrame) {
  const config = DIRECTIONAL_EXERCISE_SIGNALS[exerciseId];
  const mapping = EXERCISE_LANDMARK_PAIRS[exerciseId];
  if (!config || !mapping || !frame || !neutralFrame) return null;
  const left = directionalRawSignal(frame, neutralFrame, mapping, config, "left");
  const right = directionalRawSignal(frame, neutralFrame, mapping, config, "right");
  if (left == null && right == null) return null;
  return { config, left, right };
}

function directionalExerciseGate(config, leftNoise, rightNoise, options) {
  const maxNoise = Math.max(leftNoise ?? 0, rightNoise ?? 0);
  return Math.max(
    config.minSignal ?? SCORING_ABSOLUTE_MIN_SIGNAL,
    noiseGate(maxNoise, options.directionalGateMultiplier, options.directionalGateCap),
  );
}

function computeDirectionalExerciseSymmetry(exerciseId, lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  const options = scoringOptionsFrom(scoringOptions);
  const lmN = faceFrameNormalize(lm, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!lmN || !neuN) {
    logScoringDiagnostics(exerciseId, "normalize failed", { hasCurrent: Boolean(lmN), hasNeutral: Boolean(neuN) }, options);
    return null;
  }
  const signals = directionalExerciseRawSignals(exerciseId, lmN, neuN);
  if (!signals) return null;
  const { config } = signals;
  const mapping = EXERCISE_LANDMARK_PAIRS[exerciseId];
  const leftNoise = directionalSideNoiseWithFallback(noiseFloor, config.key, "left", mapping?.left, config);
  const rightNoise = directionalSideNoiseWithFallback(noiseFloor, config.key, "right", mapping?.right, config);
  const left = adjustedSignal(signals.left, leftNoise, options.directionalNoiseWeight);
  const right = adjustedSignal(signals.right, rightNoise, options.directionalNoiseWeight);
  // Blendshape assist: only credit a side that already shows a little geometric
  // movement in the right direction, so a side that isn't moving stays low.
  const fusion = DIRECTIONAL_BS_FUSION[config.key];
  const lHasDirection = fusion != null && signals.left != null && signals.left >= fusion.minRaw;
  const rHasDirection = fusion != null && signals.right != null && signals.right >= fusion.minRaw;
  const lBsAssist = lHasDirection ? fusion.weight * directionalBsActivation(bsMap, neutralBs, fusion, "left") : 0;
  const rBsAssist = rHasDirection ? fusion.weight * directionalBsActivation(bsMap, neutralBs, fusion, "right") : 0;
  // Gate, don't score: the blendshape assist only rescues a rep from being dropped
  // (it feeds the fused peak the activation gate sees). The symmetry RATIO is computed
  // from geometry alone. The blendshape model reports a stronger activation on the side
  // that is actually moving (the healthy side on a palsy face), so folding the assist
  // into the ratio inflated the larger side and pushed min/max down — making a face read
  // as MORE asymmetric the harder the healthy side worked. Geometry already carries the
  // true left/right balance; blendshapes only tell us movement happened at all.
  const lGeom = left.adjusted;
  const rGeom = right.adjusted;
  const lFused = lGeom + lBsAssist;
  const rFused = rGeom + rBsAssist;
  const fusedPeak = Math.max(lFused, rFused);
  const geomPeak = Math.max(lGeom, rGeom);
  const gate = directionalExerciseGate(config, left.noise, right.noise, options);
  const debugPayload = {
    signalType: config.type,
    directionalKey: config.key,
    rawImageLeft: {
      signal: debugMetric(left.raw),
      noisePenalty: debugMetric(left.noisePenalty),
      blendshapeAssist: debugMetric(lBsAssist),
      adjusted: debugMetric(lGeom),
      fused: debugMetric(lFused),
      final: debugMetric(lGeom),
    },
    rawImageRight: {
      signal: debugMetric(right.raw),
      noisePenalty: debugMetric(right.noisePenalty),
      blendshapeAssist: debugMetric(rBsAssist),
      adjusted: debugMetric(rGeom),
      fused: debugMetric(rFused),
      final: debugMetric(rGeom),
    },
    returnedUserLeftDisp: debugMetric(rGeom),
    returnedUserRightDisp: debugMetric(lGeom),
    peak: debugMetric(fusedPeak),
    geomPeak: debugMetric(geomPeak),
    gate: debugMetric(gate),
    noiseSource: config.key,
    activationState: { aboveGate: fusedPeak >= gate },
  };
  if (fusedPeak < gate) {
    logScoringDiagnostics(exerciseId, "below signal gate", debugPayload, options);
    return null;
  }
  // Movement detected only through the blendshape (geometry fully eaten by the noise
  // floor on both sides): the rep moved, but there is no geometric balance to score, so
  // drop it instead of returning a fabricated 0/0 symmetry that would tank the average.
  if (geomPeak <= 0) {
    logScoringDiagnostics(exerciseId, "blendshape-only, no geometric balance", debugPayload, options);
    return null;
  }
  const symmetry = Math.min(lGeom, rGeom) / geomPeak;
  logScoringDiagnostics(exerciseId, "scored", { ...debugPayload, symmetry: debugMetric(symmetry) }, options);
  // gate/leftNoise/rightNoise/minSignal are surfaced for the calibration harness: they let a
  // sweep recompute the admit decision for any gate constants without re-scoring each frame.
  return {
    symmetry,
    leftDisp: lGeom,
    rightDisp: rGeom,
    peak: fusedPeak,
    gate,
    leftNoise: left.noise,
    rightNoise: right.noise,
    minSignal: config.minSignal ?? SCORING_ABSOLUTE_MIN_SIGNAL,
    directionalKey: config.key,
  };
}

function waterHoldSealLeakSignal(frame, neutralFrame, rawSide) {
  const idxs = WATER_HOLD_MOUTH_SEAL_LANDMARKS[rawSide];
  const currentSpread = verticalSpread(frame, idxs);
  const neutralSpread = verticalSpread(neutralFrame, idxs);
  if (currentSpread == null || neutralSpread == null) return 0;
  return Math.max(0, currentSpread - neutralSpread);
}

function computeWaterHoldSymmetry(exerciseId, lm, neutral, noiseFloor, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  const targetUserSide = WATER_HOLD_SIDE_BY_ID[exerciseId];
  const mapping = EXERCISE_LANDMARK_PAIRS[exerciseId];
  if (!targetUserSide || !mapping || !neutral) return null;
  const options = scoringOptionsFrom(scoringOptions);
  const lmN = faceFrameNormalize(lm, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!lmN || !neuN) {
    logScoringDiagnostics(exerciseId, "normalize failed", { hasCurrent: Boolean(lmN), hasNeutral: Boolean(neuN) }, options);
    return null;
  }

  const rawSignals = {
    left: sumDisp(lmN, neuN, mapping.left, noiseFloor, options),
    right: sumDisp(lmN, neuN, mapping.right, noiseFloor, options),
  };
  const rawTargetSide = flipLeftRightSide(targetUserSide);
  const rawOppositeSide = flipLeftRightSide(rawTargetSide);
  const targetSignal = rawSignals[rawTargetSide]?.adjusted ?? 0;
  const oppositeSignal = rawSignals[rawOppositeSide]?.adjusted ?? 0;
  const leakSignal = waterHoldSealLeakSignal(lmN, neuN, rawTargetSide);
  const isolationPenalty = oppositeSignal * WATER_HOLD_OPPOSITE_WEIGHT;
  const sealPenalty = leakSignal * WATER_HOLD_SEAL_LEAK_WEIGHT;
  const penalty = isolationPenalty + sealPenalty;
  const quality = targetSignal > 0 ? clampNumber(targetSignal / (targetSignal + penalty), 0, 1) : 0;
  // Water hold is a one-sided isolation, not a left/right symmetry: even a clean hold keeps a
  // little opposite-side movement and seal activity, so penalty ~ target and `quality` pins near
  // 0.5 — a good hold then reads ~45% on the raw 0-1 scale and drags the session symmetry average
  // (where two-sided exercises reach 90%+). Floor a scored hold at 50% and map the quality into
  // [0.5, 1.0]: a neutral hold = 50%, a clean isolated hold climbs from there. Only applied once
  // the hold clears the target gate below, so a non-attempt still scores nothing.
  const scaledQuality = clampNumber(0.5 + quality * 0.5, 0.5, 1);
  const gate = Math.max(SCORING_ABSOLUTE_MIN_SIGNAL, options.pairwiseGate * 0.5);
  const debugPayload = {
    targetUserSide,
    rawImageLeft: {
      signal: debugMetric(rawSignals.left.raw),
      noisePenalty: debugMetric(rawSignals.left.noisePenalty),
      adjusted: debugMetric(rawSignals.left.adjusted),
      final: debugMetric(rawSignals.left.adjusted),
      role: rawTargetSide === "left" ? "target" : "opposite",
    },
    rawImageRight: {
      signal: debugMetric(rawSignals.right.raw),
      noisePenalty: debugMetric(rawSignals.right.noisePenalty),
      adjusted: debugMetric(rawSignals.right.adjusted),
      final: debugMetric(rawSignals.right.adjusted),
      role: rawTargetSide === "right" ? "target" : "opposite",
    },
    targetSignal: debugMetric(targetSignal),
    oppositeSignal: debugMetric(oppositeSignal),
    isolationPenalty: debugMetric(isolationPenalty),
    sealLeakSignal: debugMetric(leakSignal),
    sealPenalty: debugMetric(sealPenalty),
    gate: debugMetric(gate),
    peak: debugMetric(targetSignal),
    noiseSource: "landmark-distance",
    activationState: { aboveGate: targetSignal >= gate },
  };
  if (targetSignal < gate) {
    logScoringDiagnostics(exerciseId, "below target gate", debugPayload, options);
    return null;
  }
  logScoringDiagnostics(exerciseId, "scored", { ...debugPayload, rawQuality: debugMetric(quality), symmetry: debugMetric(scaledQuality) }, options);
  return {
    symmetry: scaledQuality,
    leftDisp: rawSignals.left.adjusted,
    rightDisp: rawSignals.right.adjusted,
    peak: targetSignal,
    scoreType: "side-seal-proxy",
    targetSide: targetUserSide,
  };
}

function emptyDirectionalNoiseSamples() {
  return {
    nostrilOutward: { left: [], right: [] },
    noseScrunchLift: { left: [], right: [] },
    browGap: { left: [], right: [] },
    frown: { left: [], right: [] },
    smilePull: { left: [], right: [] },
    puckerInward: { left: [], right: [] },
    cheekPuffOutward: { left: [], right: [] },
    cheekSuckInward: { left: [], right: [] },
    eyeClosure: { left: [], right: [] },
    mouthOpen: { left: [], right: [] },
  };
}

function pushDirectionalSample(samples, key, side, value) {
  if (Number.isFinite(value)) samples[key]?.[side]?.push(value);
}

function compactDirectionalSideNoise(samples) {
  return {
    left: robustDirectionalNoise(samples.left),
    right: robustDirectionalNoise(samples.right),
  };
}

function directionalNoiseFromSamples(samples) {
  const directional = {};
  for (const key of Object.keys(samples)) {
    const item = compactDirectionalSideNoise(samples[key]);
    if (item.left != null || item.right != null) directional[key] = item;
  }
  return Object.keys(directional).length ? directional : null;
}

// Per-landmark "noise" = each point's average jitter from the neutral mean across the
// calibration window. Captured during get-ready, then subtracted from displacement
// during hold to expose subtle real motion. Direction-specific jitter is also recorded
// for low-motion families where generic landmark distance overstates the usable signal.
function computeNoiseFloor(buffer, neutral, matrixBuffer = null, neutralFacialTransformationMatrix = null) {
  if (!buffer || buffer.length < 5 || !neutral) return null;
  const neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!neuN) return null;
  const N = neutral.length;
  const sums = new Float32Array(N);
  const counts = new Uint16Array(N);
  const directionalSamples = emptyDirectionalNoiseSamples();
  for (let sampleIndex = 0; sampleIndex < buffer.length; sampleIndex++) {
    const lm = buffer[sampleIndex];
    const lmN = faceFrameNormalize(lm, matrixBuffer?.[sampleIndex]);
    if (!lmN) continue;
    const leftOutward = nostrilOutwardSignal(lmN, neuN, "left");
    const rightOutward = nostrilOutwardSignal(lmN, neuN, "right");
    if (leftOutward) pushDirectionalSample(directionalSamples, "nostrilOutward", "left", leftOutward.signal);
    if (rightOutward) pushDirectionalSample(directionalSamples, "nostrilOutward", "right", rightOutward.signal);
    const noseScrunchLift = noseScrunchLiftSignal(lmN, neuN);
    pushDirectionalSample(directionalSamples, "noseScrunchLift", "left", noseScrunchLift?.left);
    pushDirectionalSample(directionalSamples, "noseScrunchLift", "right", noseScrunchLift?.right);
    pushDirectionalSample(directionalSamples, "browGap", "left", browGapSignal(lmN, neuN, "left"));
    pushDirectionalSample(directionalSamples, "browGap", "right", browGapSignal(lmN, neuN, "right"));
    pushDirectionalSample(directionalSamples, "frown", "left", frownSignal(lmN, neuN, "left"));
    pushDirectionalSample(directionalSamples, "frown", "right", frownSignal(lmN, neuN, "right"));
    for (const [exerciseId, config] of Object.entries(DIRECTIONAL_EXERCISE_SIGNALS)) {
      const signals = directionalExerciseRawSignals(exerciseId, lmN, neuN);
      pushDirectionalSample(directionalSamples, config.key, "left", signals?.left);
      pushDirectionalSample(directionalSamples, config.key, "right", signals?.right);
    }
    for (let i = 0; i < N; i++) {
      const a = lmN[i], b = neuN[i];
      if (!a || !b) continue;
      sums[i] += Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
      counts[i]++;
    }
  }
  const noise = new Float32Array(N);
  for (let i = 0; i < N; i++) noise[i] = counts[i] > 0 ? sums[i] / counts[i] : 0;
  const directional = directionalNoiseFromSamples(directionalSamples);
  if (directional) {
    Object.defineProperty(noise, "directional", { value: directional });
  }
  if (directional?.nostrilOutward) {
    Object.defineProperty(noise, "nostrilOutward", { value: directional.nostrilOutward });
  }
  return noise;
}

function dist3(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = (a.z ?? 0) - (b.z ?? 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function computeSymmetry(current, neutral, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null) {
  if (!current || !neutral) return null;
  const curN = faceFrameNormalize(current, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!curN || !neuN) return null;
  let weighted = 0, weight = 0;
  let leftTotal = 0, rightTotal = 0;
  for (const [l, r] of SYMMETRY_PAIRS) {
    if (!curN[l] || !curN[r] || !neuN[l] || !neuN[r]) continue;
    const lDisp = dist3(curN[l], neuN[l]);
    const rDisp = dist3(curN[r], neuN[r]);
    leftTotal += lDisp;
    rightTotal += rDisp;
    const total = lDisp + rDisp;
    if (total < 0.012) continue;
    const ratio = Math.min(lDisp, rDisp) / Math.max(lDisp, rDisp);
    weighted += ratio * total; weight += total;
  }
  if (weight < 0.024) return null;
  return { symmetry: weighted / weight, leftDisp: leftTotal, rightDisp: rightTotal };
}

// Brow tracking: more precise than generic landmark-pair displacement because (a) it's
// less sensitive to pitch (eye and brow translate together), and (b) it isolates the
// vertical axis where the actual lift/depress signal lives. Measures per-side change in
// brow-to-upper-eyelid vertical gap, in the face-local frame.
const BROW_LANDMARKS = {
  // Upper brow row + lower brow ridge — 10 points per side
  leftBrow:    [70, 63, 105, 66, 107, 46, 53, 52, 65, 55],
  rightBrow:   [300, 293, 334, 296, 336, 276, 283, 282, 295, 285],
  // Inner brow/corrugator points that move down and inward during a frown.
  leftInnerBrow: [107, 66, 65, 55],
  rightInnerBrow: [336, 296, 295, 285],
  midline: [1, 4, 5, 195, 197],
  // Upper eyelid arc — the stable reference the brow lifts away from
  leftEyeTop:  [159, 158, 157, 160, 161],
  rightEyeTop: [386, 385, 384, 387, 388],
};
const BROW_EXERCISES = new Set(["eyebrow-raise", "gentle-frown", "emoji-raised-brow"]);
const FROWN_EXERCISES = new Set(["gentle-frown"]);
const FROWN_INWARD_WEIGHT = 1.15;
const FROWN_BS_WEIGHT = 0.01;

function avgY(frame, idxs) {
  let s = 0, c = 0;
  for (const i of idxs) { if (frame[i]) { s += frame[i].y; c++; } }
  return c ? s / c : null;
}

function browEyeGap(frame, browIdxs, eyeIdxs) {
  const b = avgY(frame, browIdxs), e = avgY(frame, eyeIdxs);
  return (b == null || e == null) ? null : (e - b); // smaller image y = higher; positive = brow above eye
}

function browDistanceFromMidline(frame, browIdxs, side) {
  const brow = avgXY(frame, browIdxs);
  const mid = avgXY(frame, BROW_LANDMARKS.midline);
  if (!brow || !mid) return null;
  return side === "left" ? mid.x - brow.x : brow.x - mid.x;
}

function browGapSignal(frame, neutralFrame, side) {
  const browIdxs = side === "left" ? BROW_LANDMARKS.leftBrow : BROW_LANDMARKS.rightBrow;
  const eyeIdxs = side === "left" ? BROW_LANDMARKS.leftEyeTop : BROW_LANDMARKS.rightEyeTop;
  const curGap = browEyeGap(frame, browIdxs, eyeIdxs);
  const neutralGap = browEyeGap(neutralFrame, browIdxs, eyeIdxs);
  return curGap == null || neutralGap == null ? null : Math.abs(curGap - neutralGap);
}

function frownSignal(frame, neutralFrame, side) {
  const browIdxs = side === "left" ? BROW_LANDMARKS.leftInnerBrow : BROW_LANDMARKS.rightInnerBrow;
  const eyeIdxs = side === "left" ? BROW_LANDMARKS.leftEyeTop : BROW_LANDMARKS.rightEyeTop;
  const curGap = browEyeGap(frame, browIdxs, eyeIdxs);
  const neutralGap = browEyeGap(neutralFrame, browIdxs, eyeIdxs);
  const curDist = browDistanceFromMidline(frame, browIdxs, side);
  const neutralDist = browDistanceFromMidline(neutralFrame, browIdxs, side);
  if ([curGap, neutralGap, curDist, neutralDist].some((value) => value == null)) return null;
  const down = Math.max(0, neutralGap - curGap);
  const inward = Math.max(0, neutralDist - curDist);
  return Math.hypot(down, inward * FROWN_INWARD_WEIGHT);
}

// Nose tracking separates nostril flare (outward aperture widening) from nose scrunch
// (upward ala lift / sneer). A centroid-shift-only score can miss true nostril flare
// because the nostril rim widens while the whole cluster barely translates.
const NOSE_LANDMARKS = {
  // Raw image-coordinate L/R. computeExerciseSymmetry flips the final result into
  // user/anatomical L/R, and nose blendshape fusion below uses the matching opposite
  // anatomical blendshape for each raw image side.
  midline: [1, 2, 4, 5, 195, 197],
  leftRim: [49, 48, 64],
  rightRim: [279, 278, 294],
  leftAla: [102, 219, 218],
  rightAla: [331, 439, 438],
};
const NOSTRIL_FLARE_EXERCISES = new Set(["nose-wrinkle"]);
const NOSE_SCRUNCH_EXERCISES = new Set(["emoji-nose-scrunch"]);
const NOSE_EXERCISES = new Set([...NOSTRIL_FLARE_EXERCISES, ...NOSE_SCRUNCH_EXERCISES]);
const NOSE_PROFILE_THRESHOLD_FLOOR = 0.0008;
const NOSE_PROFILE_THRESHOLD_MAX = 0.0014;
// Subtle exercises occasionally capture a transient spike during calibration (e.g. a blink
// while calibrating eye closure), inflating the baseline peak so the activation threshold
// (peak*0.35) becomes unreachable and every rep is force-skipped. Cap each family's threshold
// the same way the nose family is capped, so a mis-scaled baseline can never push the gate
// above what the scorer actually produces. Caps are set just above the achievable threshold
// observed in real captures, so good calibrations are untouched and only gross inflation is
// clamped. eyeClosure/smilePull/puckerInward are grounded in captured peak distributions
// (2026-06-26 dataset); cheek and lip-press lack capture data and use provisional ceilings in
// the same vector-scale ballpark — validate these against a capture that includes them.
const SUBTLE_PROFILE_THRESHOLD_MAX_BY_KEY = {
  eyeClosure: 0.012,        // captured: working ~0.0103, achievable peaks 0.01-0.05
  smilePull: 0.45,          // captured (open-smile): working ~0.39, peaks 0.20-0.86
  // pucker: the earlier 0.45 was set to the INFLATED baseline value (~0.43) and dropped 23%
  // of genuine reps. Captured pucker peaks are p10/p50/p90 = 0.27/0.52/0.70 with ~zero noise,
  // so minimumVisible should be ~20% of the median peak (~0.10). Cap at 0.12 — a non-inflated
  // baseline derives ~0.10 (unclamped); only an inflated baseline is clamped. Lifts activation
  // 78% -> 97% on the captured data.
  puckerInward: 0.12,       // captured (pucker): peaks 0.27-0.70, ~zero noise floor
  cheekSuckInward: 0.18,    // validated: captured peaks 0.38-1.19, threshold ~0.17, 100% activation
  cheekPuffOutward: 0.18,   // provisional (no capture; same signal scale as cheek-suck)
};
const SUBTLE_PROFILE_THRESHOLD_MAX_BY_EXERCISE = {
  "lip-press": 0.1,         // provisional (pairwise-scored, no capture)
};

function subtleProfileThresholdMax(exerciseId) {
  const key = DIRECTIONAL_EXERCISE_SIGNALS[exerciseId]?.key;
  const keyCap = key != null ? SUBTLE_PROFILE_THRESHOLD_MAX_BY_KEY[key] : undefined;
  const exerciseCap = SUBTLE_PROFILE_THRESHOLD_MAX_BY_EXERCISE[exerciseId];
  const cap = Math.min(keyCap ?? Infinity, exerciseCap ?? Infinity);
  return Number.isFinite(cap) ? cap : null;
}

function avgXY(frame, idxs) {
  let sx = 0, sy = 0, c = 0;
  for (const i of idxs) {
    const p = frame[i]; if (!p) continue;
    sx += p.x; sy += p.y; c++;
  }
  return c ? { x: sx / c, y: sy / c } : null;
}

function avgNoseCluster(frame, rimIdxs, alaIdxs) {
  let sx = 0, sy = 0, c = 0;
  for (const idxs of [rimIdxs, alaIdxs]) {
    for (const i of idxs) {
      const p = frame[i]; if (!p) continue;
      sx += p.x; sy += p.y; c++;
    }
  }
  return c ? { x: sx / c, y: sy / c } : null;
}

function noseShape(frame) {
  const mid = avgXY(frame, NOSE_LANDMARKS.midline);
  const leftRim = avgXY(frame, NOSE_LANDMARKS.leftRim);
  const rightRim = avgXY(frame, NOSE_LANDMARKS.rightRim);
  const leftAla = avgXY(frame, NOSE_LANDMARKS.leftAla);
  const rightAla = avgXY(frame, NOSE_LANDMARKS.rightAla);
  const leftCluster = avgNoseCluster(frame, NOSE_LANDMARKS.leftRim, NOSE_LANDMARKS.leftAla);
  const rightCluster = avgNoseCluster(frame, NOSE_LANDMARKS.rightRim, NOSE_LANDMARKS.rightAla);
  if (!mid || !leftRim || !rightRim || !leftAla || !rightAla || !leftCluster || !rightCluster) return null;

  // Aperture proxy: distance from the face midline to a weighted nostril-side center.
  // The rim gets more weight than the ala because flare primarily opens the nostril.
  const leftOpenX = (leftRim.x * 2 + leftAla.x) / 3;
  const rightOpenX = (rightRim.x * 2 + rightAla.x) / 3;
  return {
    leftWidth: Math.max(0, mid.x - leftOpenX),
    rightWidth: Math.max(0, rightOpenX - mid.x),
    leftY: leftCluster.y,
    rightY: rightCluster.y,
  };
}

function noseScrunchLiftSignal(frame, neutralFrame) {
  const cur = noseShape(frame);
  const neutral = noseShape(neutralFrame);
  if (!cur || !neutral) return null;
  return {
    left: Math.max(0, neutral.leftY - cur.leftY),
    right: Math.max(0, neutral.rightY - cur.rightY),
  };
}

// Delta gating intentionally watches mouth corners and chin so talking, jaw motion,
// and expression changes reset neutral calibration.
const CALIBRATION_DELTA_POINTS = [1, 4, 10, 33, 61, 152, 199, 263, 291];
// Profile quality uses a stricter stable-core subset. Thresholds are compatibility
// defaults until we tune them against captured calibration samples.
const CORE_QUALITY_POINTS = [1, 4, 10, 33, 263];

function normalizedFrameDelta(aLm, bLm, aFacialTransformationMatrix = null, bFacialTransformationMatrix = null) {
  const aN = faceFrameNormalize(aLm, aFacialTransformationMatrix), bN = faceFrameNormalize(bLm, bFacialTransformationMatrix);
  if (!aN || !bN) return Infinity;
  let total = 0, count = 0;
  for (const i of CALIBRATION_DELTA_POINTS) {
    const a = aN[i], b = bN[i];
    if (!a || !b) continue;
    total += Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));
    count++;
  }
  return count ? total / count : Infinity;
}

function meanNoise(noiseFloor, idxs) {
  if (!noiseFloor) return 0;
  let s = 0, c = 0;
  for (const i of idxs) {
    const n = noiseFloorValue(noiseFloor, i);
    if (n == null) continue;
    s += n; c++;
  }
  return c ? s / c : 0;
}

function averageBlendshapes(buffer) {
  if (!buffer || buffer.length === 0) return null;
  const sums = {};
  const counts = {};
  for (const bs of buffer) {
    if (!bs) continue;
    for (const k in bs) {
      sums[k] = (sums[k] ?? 0) + bs[k];
      counts[k] = (counts[k] ?? 0) + 1;
    }
  }
  const avg = {};
  for (const k in sums) avg[k] = counts[k] > 0 ? sums[k] / counts[k] : 0;
  return avg;
}

// Weight that maps a 1.0 nose-sneer blendshape activation to a strong mesh magnitude
// (~0.03). Nostril flare only uses a smaller blendshape assist when there is already
// outward mesh evidence, so a pure upward scrunch does not count as flare.
const NOSE_BS_WEIGHT = 0.03;
const NOSTRIL_FLARE_BS_WEIGHT = 0.012;
const NOSTRIL_FLARE_BS_MIN_OUTWARD = 0.00018;
const NOSTRIL_FLARE_MIN_OUTWARD_RATIO = 0.35;
const SCORING_DEBUG_LOG_INTERVAL_MS = 700;
let lastScoringDebugLogAt = 0;

function scoringDiagnosticsEnabled(scoringOptions = {}) {
  const options = scoringOptionsFrom(scoringOptions);
  if (options.scoringDiagnosticsEnabled) return true;
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

function debugMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : value ?? null;
}

function logScoringDiagnostics(exerciseId, reason, payload = {}, scoringOptions = {}) {
  const options = scoringOptionsFrom(scoringOptions);
  if (!scoringDiagnosticsEnabled(options)) return;
  const win = typeof window !== "undefined" ? window : null;
  const now = win?.performance?.now?.() ?? Date.now();
  if (now - lastScoringDebugLogAt < SCORING_DEBUG_LOG_INTERVAL_MS) return;
  lastScoringDebugLogAt = now;
  console.log("[Mirror scoring]", reason, {
    exerciseId,
    scoringNoiseMode: options.scoringNoiseMode,
    ...payload,
  });
}

function noseSideNoise(noiseFloor, directionalKey = "nostrilOutward") {
  const leftIdxs = [...NOSE_LANDMARKS.leftRim, ...NOSE_LANDMARKS.leftAla];
  const rightIdxs = [...NOSE_LANDMARKS.rightRim, ...NOSE_LANDMARKS.rightAla];
  const fallbackLeft = meanNoise(noiseFloor, leftIdxs) / Math.sqrt(leftIdxs.length);
  const fallbackRight = meanNoise(noiseFloor, rightIdxs) / Math.sqrt(rightIdxs.length);
  const leftSpecific = directionalSideNoise(noiseFloor, directionalKey, "left", null);
  const rightSpecific = directionalSideNoise(noiseFloor, directionalKey, "right", null);
  return {
    left: leftSpecific ?? fallbackLeft,
    right: rightSpecific ?? fallbackRight,
    source: leftSpecific != null || rightSpecific != null ? directionalKey : "landmark-distance",
  };
}

function nostrilOutwardSignal(frame, neutralFrame, side) {
  const curMid = avgXY(frame, NOSE_LANDMARKS.midline);
  const neuMid = avgXY(neutralFrame, NOSE_LANDMARKS.midline);
  if (!curMid || !neuMid) return null;
  const groups = side === "left"
    ? [{ idxs: NOSE_LANDMARKS.leftRim, weight: 1 }, { idxs: NOSE_LANDMARKS.leftAla, weight: 0.55 }]
    : [{ idxs: NOSE_LANDMARKS.rightRim, weight: 1 }, { idxs: NOSE_LANDMARKS.rightAla, weight: 0.55 }];
  let total = 0, weight = 0, outwardWeight = 0;
  for (const group of groups) {
    for (const i of group.idxs) {
      const cur = frame[i], neu = neutralFrame[i];
      if (!cur || !neu) continue;
      const curWidth = side === "left" ? curMid.x - cur.x : cur.x - curMid.x;
      const neuWidth = side === "left" ? neuMid.x - neu.x : neu.x - neuMid.x;
      const delta = curWidth - neuWidth;
      if (delta > 0) {
        total += delta * group.weight;
        outwardWeight += group.weight;
      }
      weight += group.weight;
    }
  }
  return weight > 0 ? { signal: total / weight, outwardRatio: outwardWeight / weight } : null;
}

function robustDirectionalNoise(samples) {
  const valid = samples.filter((value) => Number.isFinite(value));
  return valid.length ? percentile(valid, 0.75) : null;
}

function computeNostrilFlareSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  if (!lm || !neutral) return null;
  const options = scoringOptionsFrom(scoringOptions);
  const lmN = faceFrameNormalize(lm, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!lmN || !neuN) {
    logScoringDiagnostics("nose-wrinkle", "normalize failed", { hasCurrent: Boolean(lmN), hasNeutral: Boolean(neuN) }, options);
    return null;
  }
  const lOutward = nostrilOutwardSignal(lmN, neuN, "left");
  const rOutward = nostrilOutwardSignal(lmN, neuN, "right");
  if (!lOutward || !rOutward) {
    logScoringDiagnostics("nose-wrinkle", "outward signal missing", { hasRawImageLeft: Boolean(lOutward), hasRawImageRight: Boolean(rOutward) }, options);
    return null;
  }

  const lFlareRaw = lOutward.signal;
  const rFlareRaw = rOutward.signal;

  const { left: leftNoise, right: rightNoise, source: noiseSource } = noseSideNoise(noiseFloor);

  // Raw image-left is the user's anatomical right, so use the opposite named blendshape.
  const lBs = bsMap ? Math.max(0, (bsMap.noseSneerRight ?? 0) - (neutralBs?.noseSneerRight ?? 0)) : 0;
  const rBs = bsMap ? Math.max(0, (bsMap.noseSneerLeft ?? 0) - (neutralBs?.noseSneerLeft ?? 0)) : 0;
  const lHasOutwardShape = lFlareRaw >= NOSTRIL_FLARE_BS_MIN_OUTWARD && lOutward.outwardRatio >= NOSTRIL_FLARE_MIN_OUTWARD_RATIO;
  const rHasOutwardShape = rFlareRaw >= NOSTRIL_FLARE_BS_MIN_OUTWARD && rOutward.outwardRatio >= NOSTRIL_FLARE_MIN_OUTWARD_RATIO;
  const lBsAssist = lHasOutwardShape ? NOSTRIL_FLARE_BS_WEIGHT * lBs : 0;
  const rBsAssist = rHasOutwardShape ? NOSTRIL_FLARE_BS_WEIGHT * rBs : 0;
  const lNoisePenalty = leftNoise * options.nostrilNoiseWeight;
  const rNoisePenalty = rightNoise * options.nostrilNoiseWeight;

  const lNoiseAdjusted = Math.max(0, lFlareRaw - lNoisePenalty) + lBsAssist;
  const rNoiseAdjusted = Math.max(0, rFlareRaw - rNoisePenalty) + rBsAssist;
  const lFlare = options.preserveDirectionalSignal && lHasOutwardShape ? Math.max(lNoiseAdjusted, lFlareRaw + lBsAssist) : lNoiseAdjusted;
  const rFlare = options.preserveDirectionalSignal && rHasOutwardShape ? Math.max(rNoiseAdjusted, rFlareRaw + rBsAssist) : rNoiseAdjusted;
  const peak = Math.max(lFlare, rFlare);
  const maxNoise = Math.max(leftNoise, rightNoise);
  const noiseGateValue = noiseGate(maxNoise, options.nostrilGateMultiplier, options.nostrilGateCap);
  const gate = Math.max(options.noseMinSignal, noiseGateValue);
  const debugPayload = {
    rawImageLeft: {
      signal: debugMetric(lFlareRaw),
      outwardRatio: debugMetric(lOutward.outwardRatio),
      noise: debugMetric(leftNoise),
      noisePenalty: debugMetric(lNoisePenalty),
      blendshape: debugMetric(lBs),
      blendshapeAssist: debugMetric(lBsAssist),
      noiseAdjusted: debugMetric(lNoiseAdjusted),
      final: debugMetric(lFlare),
      passesShape: lHasOutwardShape,
    },
    rawImageRight: {
      signal: debugMetric(rFlareRaw),
      outwardRatio: debugMetric(rOutward.outwardRatio),
      noise: debugMetric(rightNoise),
      noisePenalty: debugMetric(rNoisePenalty),
      blendshape: debugMetric(rBs),
      blendshapeAssist: debugMetric(rBsAssist),
      noiseAdjusted: debugMetric(rNoiseAdjusted),
      final: debugMetric(rFlare),
      passesShape: rHasOutwardShape,
    },
    returnedUserLeftDisp: debugMetric(rFlare),
    returnedUserRightDisp: debugMetric(lFlare),
    peak: debugMetric(peak),
    gate: debugMetric(gate),
    minSignal: debugMetric(options.noseMinSignal),
    noiseGate: debugMetric(noiseGateValue),
    noiseSource,
    profileThresholdMax: debugMetric(NOSE_PROFILE_THRESHOLD_MAX),
    activationState: {
      rawImageLeftShapeValid: lHasOutwardShape,
      rawImageRightShapeValid: rHasOutwardShape,
      aboveGate: peak >= gate,
    },
  };
  if (peak < gate) {
    logScoringDiagnostics("nose-wrinkle", "below signal gate", debugPayload, options);
    return null;
  }
  const symmetry = Math.min(lFlare, rFlare) / peak;
  logScoringDiagnostics("nose-wrinkle", "scored", { ...debugPayload, symmetry: debugMetric(symmetry) }, options);
  return { symmetry, leftDisp: lFlare, rightDisp: rFlare, peak };
}

function computeNoseScrunchSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  if (!lm || !neutral) return null;
  const options = scoringOptionsFrom(scoringOptions);
  const lmN = faceFrameNormalize(lm, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!lmN || !neuN) {
    logScoringDiagnostics("emoji-nose-scrunch", "normalize failed", { hasCurrent: Boolean(lmN), hasNeutral: Boolean(neuN) }, options);
    return null;
  }
  const lift = noseScrunchLiftSignal(lmN, neuN);
  if (!lift) {
    logScoringDiagnostics("emoji-nose-scrunch", "lift signal missing", {}, options);
    return null;
  }

  const lLiftRaw = lift.left;   // smaller y = lifted upward
  const rLiftRaw = lift.right;
  const { left: leftNoise, right: rightNoise, source: noiseSource } = noseSideNoise(noiseFloor, "noseScrunchLift");
  const lAdjusted = adjustedSignal(lLiftRaw, leftNoise, options.directionalNoiseWeight);
  const rAdjusted = adjustedSignal(rLiftRaw, rightNoise, options.directionalNoiseWeight);
  const lLift = lAdjusted.adjusted;
  const rLift = rAdjusted.adjusted;

  // Per-side blendshape activation, with calibration-time neutral subtracted so a slightly
  // raised resting `noseSneer*` doesn't masquerade as movement.
  const lBs = bsMap ? Math.max(0, (bsMap.noseSneerRight ?? 0) - (neutralBs?.noseSneerRight ?? 0)) : 0;
  const rBs = bsMap ? Math.max(0, (bsMap.noseSneerLeft ?? 0) - (neutralBs?.noseSneerLeft ?? 0)) : 0;

  const lMag = lLift + NOSE_BS_WEIGHT * lBs;
  const rMag = rLift + NOSE_BS_WEIGHT * rBs;
  const peak = Math.max(lMag, rMag);
  // Adaptive gate: small absolute floor for real nose signals, but rises with calibration
  // jitter so a noisy session doesn't drift into "scored" territory after denoising.
  const maxNoise = Math.max(leftNoise, rightNoise);
  const noiseGateValue = noiseGate(maxNoise, options.directionalGateMultiplier, options.directionalGateCap);
  const gate = Math.max(options.noseMinSignal, noiseGateValue);
  const debugPayload = {
    rawImageLeft: {
      signal: debugMetric(lLiftRaw),
      noise: debugMetric(leftNoise),
      noisePenalty: debugMetric(lAdjusted.noisePenalty),
      adjusted: debugMetric(lLift),
      blendshape: debugMetric(lBs),
      final: debugMetric(lMag),
    },
    rawImageRight: {
      signal: debugMetric(rLiftRaw),
      noise: debugMetric(rightNoise),
      noisePenalty: debugMetric(rAdjusted.noisePenalty),
      adjusted: debugMetric(rLift),
      blendshape: debugMetric(rBs),
      final: debugMetric(rMag),
    },
    returnedUserLeftDisp: debugMetric(rMag),
    returnedUserRightDisp: debugMetric(lMag),
    peak: debugMetric(peak),
    gate: debugMetric(gate),
    minSignal: debugMetric(options.noseMinSignal),
    noiseGate: debugMetric(noiseGateValue),
    noiseSource,
    profileThresholdMax: debugMetric(NOSE_PROFILE_THRESHOLD_MAX),
    activationState: { aboveGate: peak >= gate },
  };
  if (peak < gate) {
    logScoringDiagnostics("emoji-nose-scrunch", "below signal gate", debugPayload, options);
    return null;
  }
  const symmetry = Math.min(lMag, rMag) / peak;
  logScoringDiagnostics("emoji-nose-scrunch", "scored", { ...debugPayload, symmetry: debugMetric(symmetry) }, options);
  return { symmetry, leftDisp: lMag, rightDisp: rMag, peak };
}

function computeNoseSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  return computeNostrilFlareSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix, neutralFacialTransformationMatrix, scoringOptions)
    ?? computeNoseScrunchSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix, neutralFacialTransformationMatrix, scoringOptions);
}

function computeFrownSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  if (!lm || !neutral) return null;
  const options = scoringOptionsFrom(scoringOptions);
  const lmN = faceFrameNormalize(lm, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!lmN || !neuN) {
    logScoringDiagnostics("gentle-frown", "normalize failed", { hasCurrent: Boolean(lmN), hasNeutral: Boolean(neuN) }, options);
    return null;
  }

  const lRaw = frownSignal(lmN, neuN, "left");
  const rRaw = frownSignal(lmN, neuN, "right");
  if (lRaw == null || rRaw == null) {
    logScoringDiagnostics("gentle-frown", "frown signal missing", { hasRawImageLeft: lRaw != null, hasRawImageRight: rRaw != null }, options);
    return null;
  }

  const leftNoiseIdxs = [...BROW_LANDMARKS.leftInnerBrow, ...BROW_LANDMARKS.leftEyeTop];
  const rightNoiseIdxs = [...BROW_LANDMARKS.rightInnerBrow, ...BROW_LANDMARKS.rightEyeTop];
  const fallbackLeftNoise = meanNoise(noiseFloor, leftNoiseIdxs) / Math.sqrt(leftNoiseIdxs.length);
  const fallbackRightNoise = meanNoise(noiseFloor, rightNoiseIdxs) / Math.sqrt(rightNoiseIdxs.length);
  const leftSpecificNoise = directionalSideNoise(noiseFloor, "frown", "left", null);
  const rightSpecificNoise = directionalSideNoise(noiseFloor, "frown", "right", null);
  const leftNoise = leftSpecificNoise ?? fallbackLeftNoise;
  const rightNoise = rightSpecificNoise ?? fallbackRightNoise;
  const noiseSource = leftSpecificNoise != null || rightSpecificNoise != null ? "frown" : "landmark-distance";

  const lAdjusted = adjustedSignal(lRaw, leftNoise, options.directionalNoiseWeight);
  const rAdjusted = adjustedSignal(rRaw, rightNoise, options.directionalNoiseWeight);
  const lMesh = lAdjusted.adjusted;
  const rMesh = rAdjusted.adjusted;
  // Raw image-left is the user's anatomical right, so use the opposite named blendshape.
  const lBs = bsMap ? Math.max(0, (bsMap.browDownRight ?? 0) - (neutralBs?.browDownRight ?? 0)) : 0;
  const rBs = bsMap ? Math.max(0, (bsMap.browDownLeft ?? 0) - (neutralBs?.browDownLeft ?? 0)) : 0;
  const lMag = lMesh + FROWN_BS_WEIGHT * lBs;
  const rMag = rMesh + FROWN_BS_WEIGHT * rBs;
  const peak = Math.max(lMag, rMag);
  const maxNoise = Math.max(leftNoise, rightNoise);
  const noiseGateValue = noiseGate(maxNoise, options.directionalGateMultiplier, options.directionalGateCap);
  const gate = Math.max(options.frownMinSignal, noiseGateValue);
  const debugPayload = {
    rawImageLeft: {
      signal: debugMetric(lRaw),
      noise: debugMetric(leftNoise),
      noisePenalty: debugMetric(lAdjusted.noisePenalty),
      adjusted: debugMetric(lMesh),
      blendshape: debugMetric(lBs),
      final: debugMetric(lMag),
    },
    rawImageRight: {
      signal: debugMetric(rRaw),
      noise: debugMetric(rightNoise),
      noisePenalty: debugMetric(rAdjusted.noisePenalty),
      adjusted: debugMetric(rMesh),
      blendshape: debugMetric(rBs),
      final: debugMetric(rMag),
    },
    returnedUserLeftDisp: debugMetric(rMag),
    returnedUserRightDisp: debugMetric(lMag),
    peak: debugMetric(peak),
    gate: debugMetric(gate),
    minSignal: debugMetric(options.frownMinSignal),
    noiseGate: debugMetric(noiseGateValue),
    noiseSource,
    activationState: { aboveGate: peak >= gate },
  };
  if (peak < gate) {
    logScoringDiagnostics("gentle-frown", "below signal gate", debugPayload, options);
    return null;
  }
  const symmetry = Math.min(lMag, rMag) / peak;
  logScoringDiagnostics("gentle-frown", "scored", { ...debugPayload, symmetry: debugMetric(symmetry) }, options);
  return { symmetry, leftDisp: lMag, rightDisp: rMag, peak };
}

function computeBrowSymmetry(lm, neutral, noiseFloor = null, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  if (!lm || !neutral) return null;
  const options = scoringOptionsFrom(scoringOptions);
  const lmN = faceFrameNormalize(lm, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!lmN || !neuN) {
    logScoringDiagnostics("eyebrow-raise", "normalize failed", { hasCurrent: Boolean(lmN), hasNeutral: Boolean(neuN) }, options);
    return null;
  }
  const lRaw = browGapSignal(lmN, neuN, "left"); // frown has a separate direction-specific scorer.
  const rRaw = browGapSignal(lmN, neuN, "right");
  if (lRaw == null || rRaw == null) {
    logScoringDiagnostics("eyebrow-raise", "brow signal missing", { hasRawImageLeft: lRaw != null, hasRawImageRight: rRaw != null }, options);
    return null;
  }
  const leftNoiseIdxs = [...BROW_LANDMARKS.leftBrow, ...BROW_LANDMARKS.leftEyeTop];
  const rightNoiseIdxs = [...BROW_LANDMARKS.rightBrow, ...BROW_LANDMARKS.rightEyeTop];
  const fallbackLeftNoise = meanNoise(noiseFloor, leftNoiseIdxs) / Math.sqrt(leftNoiseIdxs.length);
  const fallbackRightNoise = meanNoise(noiseFloor, rightNoiseIdxs) / Math.sqrt(rightNoiseIdxs.length);
  const leftSpecificNoise = directionalSideNoise(noiseFloor, "browGap", "left", null);
  const rightSpecificNoise = directionalSideNoise(noiseFloor, "browGap", "right", null);
  const leftNoise = leftSpecificNoise ?? fallbackLeftNoise;
  const rightNoise = rightSpecificNoise ?? fallbackRightNoise;
  const noiseSource = leftSpecificNoise != null || rightSpecificNoise != null ? "browGap" : "landmark-distance";
  const lAdjusted = adjustedSignal(lRaw, leftNoise, options.browNoiseWeight);
  const rAdjusted = adjustedSignal(rRaw, rightNoise, options.browNoiseWeight);
  const lLift = lAdjusted.adjusted;
  const rLift = rAdjusted.adjusted;
  const peak = Math.max(lLift, rLift);
  const maxNoise = Math.max(leftNoise, rightNoise);
  const noiseGateValue = noiseGate(maxNoise, options.browGateMultiplier, options.browGateCap);
  const gate = Math.max(options.browMinSignal, noiseGateValue);
  const debugPayload = {
    rawImageLeft: {
      signal: debugMetric(lRaw),
      noise: debugMetric(leftNoise),
      noisePenalty: debugMetric(lAdjusted.noisePenalty),
      adjusted: debugMetric(lLift),
      final: debugMetric(lLift),
    },
    rawImageRight: {
      signal: debugMetric(rRaw),
      noise: debugMetric(rightNoise),
      noisePenalty: debugMetric(rAdjusted.noisePenalty),
      adjusted: debugMetric(rLift),
      final: debugMetric(rLift),
    },
    returnedUserLeftDisp: debugMetric(rLift),
    returnedUserRightDisp: debugMetric(lLift),
    peak: debugMetric(peak),
    gate: debugMetric(gate),
    minSignal: debugMetric(options.browMinSignal),
    noiseGate: debugMetric(noiseGateValue),
    noiseSource,
    activationState: { aboveGate: peak >= gate },
  };
  if (peak < gate) {
    logScoringDiagnostics("eyebrow-raise", "below signal gate", debugPayload, options);
    return null;
  }
  const symmetry = Math.min(lLift, rLift) / peak;
  logScoringDiagnostics("eyebrow-raise", "scored", { ...debugPayload, symmetry: debugMetric(symmetry) }, options);
  return { symmetry, leftDisp: lLift, rightDisp: rLift, peak };
}

function computeExerciseSymmetry(exerciseId, lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  const options = typeof scoringOptions === "object"
    ? { ...scoringOptions, exerciseId }
    : { scoringNoiseMode: scoringOptions, exerciseId };
  // Reject frames where the head has drifted significantly from the neutral pose.
  // When both matrices are present, this is a 3D yaw/pitch/roll check that the 2D
  // alignment gate can't make. If either matrix is null, the deviation is null and
  // we fall through to the fallback normalization path.
  const poseDeviation = headPoseDeviationRad(facialTransformationMatrix, neutralFacialTransformationMatrix);
  if (poseDeviation != null && poseDeviation > HOLD_HEAD_POSE_MAX_RAD) return null;

  const mapping = EXERCISE_LANDMARK_PAIRS[exerciseId] ?? null;
  if (FROWN_EXERCISES.has(exerciseId)) {
    return toUserSideSymmetryResult(computeFrownSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix, neutralFacialTransformationMatrix, options));
  }
  if (NOSTRIL_FLARE_EXERCISES.has(exerciseId)) {
    return toUserSideSymmetryResult(computeNostrilFlareSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix, neutralFacialTransformationMatrix, options));
  }
  if (NOSE_SCRUNCH_EXERCISES.has(exerciseId)) {
    return toUserSideSymmetryResult(computeNoseScrunchSymmetry(lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix, neutralFacialTransformationMatrix, options));
  }
  if (BROW_EXERCISES.has(exerciseId)) {
    return toUserSideSymmetryResult(computeBrowSymmetry(lm, neutral, noiseFloor, facialTransformationMatrix, neutralFacialTransformationMatrix, options));
  }
  if (WATER_HOLD_SIDE_BY_ID[exerciseId]) {
    return toUserSideSymmetryResult(computeWaterHoldSymmetry(exerciseId, lm, neutral, noiseFloor, facialTransformationMatrix, neutralFacialTransformationMatrix, options));
  }
  if (DIRECTIONAL_EXERCISE_SIGNALS[exerciseId]) {
    return toUserSideSymmetryResult(computeDirectionalExerciseSymmetry(exerciseId, lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix, neutralFacialTransformationMatrix, options));
  }
  const rawResult = computePairwiseSymmetry(lm, neutral, mapping, noiseFloor, facialTransformationMatrix, neutralFacialTransformationMatrix, options)
    ?? computeSymmetry(lm, neutral, facialTransformationMatrix, neutralFacialTransformationMatrix);
  return toUserSideSymmetryResult(rawResult);
}

const QUIET_REGION_BY_EXERCISE = {
  "eyebrow-raise": ["mouth"],
  "gentle-frown": ["mouth"],
  "emoji-raised-brow": ["mouth"],
  "eye-close": ["mouth"],
  "blink": ["mouth"],
  "wink": ["mouth"],
  "emoji-wink": ["mouth"],
  "closed-smile": ["eyes", "brow"],
  "open-smile": ["eyes", "brow"],
  "emoji-smile": ["eyes", "brow"],
  "emoji-big-smile": ["eyes", "brow"],
  "emoji-smirk": ["eyes"],
  "pucker": ["eyes", "brow"],
  "emoji-pucker": ["eyes", "brow"],
  "emoji-kiss": ["eyes", "brow"],
  "vowel-a": ["eyes", "brow"],
  "vowel-e": ["eyes", "brow"],
  "vowel-i": ["eyes", "brow"],
  "vowel-o": ["eyes", "brow"],
  "vowel-u": ["eyes", "brow"],
  "nose-wrinkle": ["eyes", "mouth"],
  "emoji-nose-scrunch": ["eyes", "mouth"],
};

const QUIET_REGION_MAPPINGS = {
  eyes: EXERCISE_LANDMARK_PAIRS["eye-close"],
  brow: EXERCISE_LANDMARK_PAIRS["eyebrow-raise"],
  mouth: EXERCISE_LANDMARK_PAIRS["closed-smile"],
};

function coactivationRisk(score) {
  if (!Number.isFinite(score) || score < 0.18) return "low";
  if (score < 0.38) return "medium";
  return "high";
}

function computeQuietRegionCoactivation(exerciseId, lm, neutral, noiseFloor, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, targetPeak = null, scoringOptions = {}) {
  const regions = QUIET_REGION_BY_EXERCISE[exerciseId] ?? [];
  if (!regions.length || !lm || !neutral) return null;
  const options = scoringOptionsFrom(scoringOptions);
  const lmN = faceFrameNormalize(lm, facialTransformationMatrix), neuN = faceFrameNormalize(neutral, neutralFacialTransformationMatrix);
  if (!lmN || !neuN) return null;
  const entries = [];
  for (const region of regions) {
    const mapping = QUIET_REGION_MAPPINGS[region];
    if (!mapping) continue;
    const left = sumDisp(lmN, neuN, mapping.left, noiseFloor, options).adjusted;
    const right = sumDisp(lmN, neuN, mapping.right, noiseFloor, options).adjusted;
    const movement = left + right;
    entries.push({ region, movement: roundMetric(movement, 5) });
  }
  if (!entries.length) return null;
  const quietMovement = entries.reduce((sum, item) => sum + (item.movement ?? 0), 0);
  const denominator = Math.max(SCORING_ABSOLUTE_MIN_SIGNAL, quietMovement + (Number.isFinite(targetPeak) ? targetPeak : 0));
  const score = denominator > 0 ? quietMovement / denominator : 0;
  return {
    score: roundMetric(score, 4),
    risk: coactivationRisk(score),
    quietMovement: roundMetric(quietMovement, 5),
    targetPeak: roundMetric(targetPeak, 5),
    regions: entries,
  };
}

function scoringDiagnostic(result, meta = {}) {
  return {
    scoringModelVersion: SCORING_MODEL_VERSION,
    result: result ?? null,
    scored: Boolean(result),
    dropReason: result ? null : (meta.dropReason ?? SCORE_DROP_REASONS.noSymmetryResult),
    ...meta,
  };
}

function computeExerciseSymmetryDiagnostic(exerciseId, lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix = null, neutralFacialTransformationMatrix = null, scoringOptions = {}) {
  const scoringNoiseMode = normalizeScoringNoiseMode(typeof scoringOptions === "string" ? scoringOptions : scoringOptions?.scoringNoiseMode);
  const normalizationMethod = facialTransformationMatrix && neutralFacialTransformationMatrix ? "matrix" : "eye-line";
  if (!lm) {
    return scoringDiagnostic(null, {
      exerciseId,
      scoringNoiseMode,
      normalizationMethod,
      dropReason: SCORE_DROP_REASONS.noFace,
    });
  }
  if (!neutral) {
    return scoringDiagnostic(null, {
      exerciseId,
      scoringNoiseMode,
      normalizationMethod,
      dropReason: SCORE_DROP_REASONS.missingNeutral,
    });
  }
  const poseDeviation = headPoseDeviationRad(facialTransformationMatrix, neutralFacialTransformationMatrix);
  if (poseDeviation != null && poseDeviation > HOLD_HEAD_POSE_MAX_RAD) {
    return scoringDiagnostic(null, {
      exerciseId,
      scoringNoiseMode,
      normalizationMethod,
      dropReason: SCORE_DROP_REASONS.headPose,
      headPoseDeviationRad: roundMetric(poseDeviation, 5),
      headPoseMaxRad: HOLD_HEAD_POSE_MAX_RAD,
    });
  }
  const result = computeExerciseSymmetry(exerciseId, lm, neutral, noiseFloor, bsMap, neutralBs, facialTransformationMatrix, neutralFacialTransformationMatrix, scoringOptions);
  return scoringDiagnostic(result, {
    exerciseId,
    scoringNoiseMode,
    normalizationMethod,
    dropReason: result ? null : SCORE_DROP_REASONS.belowSignalGate,
    hasNoiseFloor: Boolean(noiseFloor),
    hasBlendshapes: Boolean(bsMap),
    hasNeutralBlendshapes: Boolean(neutralBs),
  });
}

function roundMetric(v, digits = 4) {
  return Number.isFinite(v) ? Number(v.toFixed(digits)) : null;
}

function percentile(values, pct) {
  const valid = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!valid.length) return null;
  const idx = Math.min(valid.length - 1, Math.max(0, Math.ceil(valid.length * pct) - 1));
  return valid[idx];
}

function averageSamples(samples) {
  if (!samples?.length) return null;
  const totals = samples.reduce((acc, item) => ({
    left: acc.left + (item.left ?? 0),
    right: acc.right + (item.right ?? 0),
    symmetry: acc.symmetry + (item.symmetry ?? 0),
    peak: acc.peak + (item.peak ?? 0),
  }), { left: 0, right: 0, symmetry: 0, peak: 0 });
  return {
    count: samples.length,
    left: totals.left / samples.length,
    right: totals.right / samples.length,
    symmetry: totals.symmetry / samples.length,
    peak: totals.peak / samples.length,
  };
}

function robustMovementWindow(samples, fraction = PROFILE_BASELINE_TOP_FRACTION) {
  const valid = (samples ?? []).filter((item) => Number.isFinite(item?.peak) && item.peak > 0);
  if (!valid.length) return null;
  const count = Math.max(1, Math.ceil(valid.length * fraction));
  return averageSamples([...valid].sort((a, b) => b.peak - a.peak).slice(0, count));
}

function exerciseBaselineQuality(stat) {
  const holdFrames = stat.holdFrames ?? stat.frames ?? 0;
  const scoredFrames = stat.frames ?? 0;
  const alignedFrames = stat.alignedFrames ?? 0;
  const scoredRatio = holdFrames > 0 ? scoredFrames / holdFrames : 0;
  const alignmentRatio = holdFrames > 0 ? alignedFrames / holdFrames : 0;
  const peak = Math.max(stat.leftPeak ?? 0, stat.rightPeak ?? 0);
  const signalScore = clampNumber(peak / 0.04, 0, 1);
  const neutralOk = (stat.neutralFrames ?? 0) >= PROFILE_EXERCISE_NEUTRAL_MIN_FRAMES;
  const frameScore = clampNumber(scoredFrames / PROFILE_MIN_SCORED_FRAMES, 0, 1);
  const score = roundMetric(frameScore * 0.35 + alignmentRatio * 0.25 + signalScore * 0.25 + (neutralOk ? 0.15 : 0), 3);
  const issues = [];
  if (!neutralOk) issues.push("short neutral capture");
  if (scoredFrames < PROFILE_MIN_SCORED_FRAMES) issues.push("low scored frames");
  if (alignmentRatio < PROFILE_MIN_ALIGNMENT_RATIO) issues.push("face alignment drift");
  if (peak < 0.006) issues.push("very low movement signal");
  const key = score >= 0.8 && issues.length === 0 ? "strong" : score >= 0.55 ? "usable" : "retake";
  const label = key === "strong" ? "Strong" : key === "usable" ? "Usable" : "Retake";
  return {
    key,
    label,
    score,
    issues,
    holdFrames,
    scoredFrames,
    scoredRatio: roundMetric(scoredRatio, 3),
    alignmentRatio: roundMetric(alignmentRatio, 3),
    peakMovement: roundMetric(peak),
  };
}

function compactLandmarks(lm) {
  if (!lm) return null;
  return lm.map((p) => ({ x: roundMetric(p.x, 5), y: roundMetric(p.y, 5), z: roundMetric(p.z ?? 0, 5) }));
}

function compactDirectionalNoise(directional) {
  if (!directional || typeof directional !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(directional)) {
    const left = roundMetric(value?.left, 6);
    const right = roundMetric(value?.right, 6);
    if (left != null || right != null) out[key] = { left, right };
  }
  return Object.keys(out).length ? out : null;
}

function compactNoiseFloor(noise) {
  if (!noise) return null;
  const values = Array.from(noiseFloorValues(noise), (v) => roundMetric(v, 5));
  const directional = compactDirectionalNoise(directionalNoiseFloor(noise));
  return directional ? { values, directional } : values;
}

function inferLimitedSide(left, right) {
  const peak = Math.max(left ?? 0, right ?? 0);
  if (peak < 0.0001) return "unknown";
  const diff = Math.abs((left ?? 0) - (right ?? 0)) / peak;
  if (diff < 0.15) return "balanced";
  return left < right ? "left" : "right";
}

function activationThresholdForExercise(exerciseId, peak) {
  if (NOSE_EXERCISES.has(exerciseId)) {
    return roundMetric(Math.max(peak * 0.25, NOSE_PROFILE_THRESHOLD_FLOOR));
  }
  return roundMetric(Math.max(peak * 0.35, 0.004));
}

function thresholdBandsForExercise(exerciseId, peak) {
  const baselineTarget = roundMetric(peak);
  if (NOSE_EXERCISES.has(exerciseId)) {
    return {
      minimumVisible: roundMetric(Math.max(peak * 0.15, NOSE_PROFILE_THRESHOLD_FLOOR * 0.6)),
      reliableMovement: activationThresholdForExercise(exerciseId, peak),
      baselineTarget,
    };
  }
  return {
    minimumVisible: roundMetric(Math.max(peak * 0.2, 0.002)),
    reliableMovement: activationThresholdForExercise(exerciseId, peak),
    baselineTarget,
  };
}

function effectiveProfileThreshold(exerciseId, threshold) {
  if (threshold == null) return null;
  if (NOSE_EXERCISES.has(exerciseId)) return Math.min(threshold, NOSE_PROFILE_THRESHOLD_MAX);
  const subtleCap = subtleProfileThresholdMax(exerciseId);
  if (subtleCap != null) return Math.min(threshold, subtleCap);
  return threshold;
}

// Threshold a live rep must clear to count toward the score. We gate on the lower
// `minimumVisible` band rather than `reliableMovement` (the coaching target): the
// baseline is a fixed reference, so any visible movement should register as progress
// instead of being dropped. Falls back to the stored activation threshold for older
// profiles captured before threshold bands existed.
function profileLiveScoringThreshold(exerciseId, profileExercise) {
  if (!profileExercise) return null;
  const minimumVisible = profileExercise.thresholdBands?.minimumVisible;
  if (Number.isFinite(minimumVisible)) return effectiveProfileThreshold(exerciseId, minimumVisible);
  return effectiveProfileThreshold(exerciseId, profileExercise.activationThreshold);
}

function buildMovementProfile({ neutral, noise, neutralFacialTransformationMatrix, exerciseStats, affectedSide, comfortLevel, scoringNoiseMode = DEFAULT_SCORING_NOISE_MODE, setupQuality = null }) {
  const exercises = {};
  for (const stat of exerciseStats) {
    const leftBaseline = stat.leftRobustAvg ?? stat.leftAvg;
    const rightBaseline = stat.rightRobustAvg ?? stat.rightAvg;
    const symmetryBaseline = stat.symRobustAvg ?? stat.symAvg;
    const leftPeak = stat.leftPeak ?? 0;
    const rightPeak = stat.rightPeak ?? 0;
    const peak = Math.max(leftPeak, rightPeak);
    const thresholdBands = thresholdBandsForExercise(stat.exerciseId, peak);
    exercises[stat.exerciseId] = {
      exerciseId: stat.exerciseId,
      name: stat.name,
      region: stat.region,
      frames: stat.frames,
      holdFrames: stat.holdFrames ?? stat.frames,
      alignedFrames: stat.alignedFrames ?? 0,
      neutralFrames: stat.neutralFrames ?? 0,
      neutralSource: stat.neutralSource ?? "global",
      quality: stat.quality ?? null,
      baselineMethod: stat.baselineMethod ?? "mean",
      baselineFrames: stat.baselineFrames ?? stat.frames,
      leftMeanMovement: roundMetric(stat.leftAvg),
      rightMeanMovement: roundMetric(stat.rightAvg),
      meanSymmetry: stat.symAvg == null ? null : roundMetric(stat.symAvg),
      leftBaselineMovement: roundMetric(leftBaseline),
      rightBaselineMovement: roundMetric(rightBaseline),
      leftPeakMovement: roundMetric(leftPeak),
      rightPeakMovement: roundMetric(rightPeak),
      initialSymmetry: symmetryBaseline == null ? null : roundMetric(symmetryBaseline),
      activationThreshold: thresholdBands.reliableMovement,
      thresholdBands,
      limitedSide: inferLimitedSide(leftPeak, rightPeak),
    };
  }
  const valid = Object.values(exercises).filter((e) => e.initialSymmetry != null);
  const initialAvgSymmetry = valid.length
    ? valid.reduce((sum, e) => sum + e.initialSymmetry, 0) / valid.length
    : null;
  const noiseValues = noise ? Array.from(noise).filter((v) => Number.isFinite(v)) : [];
  const avgNoise = noiseValues.length ? noiseValues.reduce((a, b) => a + b, 0) / noiseValues.length : null;
  const coreNoiseValues = noise ? CORE_QUALITY_POINTS.map((idx) => noise[idx]).filter((v) => Number.isFinite(v)) : [];
  const coreAvgNoise = coreNoiseValues.length ? coreNoiseValues.reduce((a, b) => a + b, 0) / coreNoiseValues.length : null;
  const p90Noise = percentile(noiseValues, 0.9);
  return {
    version: PROFILE_VERSION,
    scoringModelVersion: SCORING_MODEL_VERSION,
    sideConvention: MOVEMENT_SIDE_CONVENTION,
    createdAt: Date.now(),
    scoringNoiseMode: normalizeScoringNoiseMode(scoringNoiseMode),
    affectedSide,
    comfortLevel,
    setupQuality,
    neutralLandmarks: compactLandmarks(neutral),
    noiseFloor: compactNoiseFloor(noise),
    normalization: {
      method: neutralFacialTransformationMatrix ? "mediapipe-facial-transformation-matrix-v2" : "eye-line-roll-scale",
      fallbackMethod: "eye-line-roll-scale",
      neutralFacialTransformationMatrix: compactFacialTransformationMatrix(neutralFacialTransformationMatrix),
    },
    calibrationQuality: {
      frames: CALIBRATION_FRAMES,
      exerciseNeutralMinFrames: PROFILE_EXERCISE_NEUTRAL_MIN_FRAMES,
      baselineTopFraction: PROFILE_BASELINE_TOP_FRACTION,
      avgNoise: roundMetric(avgNoise, 5),
      coreAvgNoise: roundMetric(coreAvgNoise, 5),
      coreQualityPoints: CORE_QUALITY_POINTS,
      p90Noise: roundMetric(p90Noise, 5),
      stabilityEps: CALIBRATION_STABILITY_EPS,
      steadyNoiseMax: PROFILE_STEADY_NOISE_MAX,
      usableNoiseMax: PROFILE_USABLE_NOISE_MAX,
    },
    initialAvgSymmetry: roundMetric(initialAvgSymmetry),
    exercises,
  };
}

function getProfileExercise(profile, exerciseId) {
  return profile?.exercises?.[exerciseId] ?? null;
}

function movementForSide(left, right, side) {
  if (side === "left") return left ?? 0;
  if (side === "right") return right ?? 0;
  return Math.min(left ?? 0, right ?? 0);
}

function resolveFocusSide(profile, profileExercise, left, right) {
  if (profile?.affectedSide === "left" || profile?.affectedSide === "right") return profile.affectedSide;
  if (profileExercise?.limitedSide === "left" || profileExercise?.limitedSide === "right") return profileExercise.limitedSide;
  return (left ?? 0) <= (right ?? 0) ? "left" : "right";
}

function profileBaselineForSide(profileExercise, side) {
  if (!profileExercise) return null;
  const avg = side === "left" ? profileExercise.leftBaselineMovement : profileExercise.rightBaselineMovement;
  const peak = side === "left" ? profileExercise.leftPeakMovement : profileExercise.rightPeakMovement;
  return avg ?? peak ?? null;
}

function referenceSideFor(side) {
  if (side === "left") return "right";
  if (side === "right") return "left";
  return null;
}

function ratioOrNull(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function computeBaselineProgressFromDisplacements(exerciseId, leftDisp, rightDisp, profile) {
  const profileExercise = getProfileExercise(profile, exerciseId);
  if (!profileExercise) return null;
  const side = resolveFocusSide(profile, profileExercise, leftDisp, rightDisp);
  const baseline = profileBaselineForSide(profileExercise, side);
  if (!baseline || baseline <= 0) return null;
  const current = movementForSide(leftDisp, rightDisp, side);
  const ratio = current / baseline;
  return {
    sideConvention: MOVEMENT_SIDE_CONVENTION,
    side,
    currentMovement: roundMetric(current),
    baselineMovement: roundMetric(baseline),
    ratio: roundMetric(ratio),
    deltaPct: Math.round((ratio - 1) * 100),
  };
}

function computeBaselineProgress(exerciseId, symResult, profile) {
  if (!symResult) return null;
  return computeBaselineProgressFromDisplacements(exerciseId, symResult.leftDisp, symResult.rightDisp, profile);
}

function computeMovementProgressFromDisplacements(exerciseId, leftDisp, rightDisp, profile) {
  const profileExercise = getProfileExercise(profile, exerciseId);
  if (!profileExercise) return null;
  const side = resolveFocusSide(profile, profileExercise, leftDisp, rightDisp);
  const referenceSide = referenceSideFor(side);
  if (!referenceSide) return null;

  const affectedMovement = movementForSide(leftDisp, rightDisp, side);
  const properMovement = movementForSide(leftDisp, rightDisp, referenceSide);
  const baselineAffectedMovement = profileBaselineForSide(profileExercise, side);
  const baselineProperMovement = profileBaselineForSide(profileExercise, referenceSide);
  const affectedProgressRatio = ratioOrNull(affectedMovement, baselineAffectedMovement);
  if (affectedProgressRatio == null) return null;

  const affectedToProperRatio = ratioOrNull(affectedMovement, properMovement);
  const baselineAffectedToProperRatio = ratioOrNull(baselineAffectedMovement, baselineProperMovement);
  const balanceProgressRatio = affectedToProperRatio != null && baselineAffectedToProperRatio != null
    ? ratioOrNull(affectedToProperRatio, baselineAffectedToProperRatio)
    : null;

  return {
    sideConvention: MOVEMENT_SIDE_CONVENTION,
    side,
    referenceSide,
    affectedMovement: roundMetric(affectedMovement),
    properMovement: roundMetric(properMovement),
    affectedToProperRatio: roundMetric(affectedToProperRatio),
    baselineAffectedMovement: roundMetric(baselineAffectedMovement),
    baselineProperMovement: roundMetric(baselineProperMovement),
    baselineAffectedToProperRatio: roundMetric(baselineAffectedToProperRatio),
    affectedProgressRatio: roundMetric(affectedProgressRatio),
    properProgressRatio: roundMetric(ratioOrNull(properMovement, baselineProperMovement)),
    balanceProgressRatio: roundMetric(balanceProgressRatio),
    deltaPct: Math.round((affectedProgressRatio - 1) * 100),
  };
}

function computeMovementProgress(exerciseId, symResult, profile) {
  if (!symResult) return null;
  return computeMovementProgressFromDisplacements(exerciseId, symResult.leftDisp, symResult.rightDisp, profile);
}

function summarizeBaselineProgress(items) {
  const valid = (items ?? []).filter((p) => !progressUsesLegacySideConvention(p) && p?.ratio != null);
  if (!valid.length) return null;
  const ratio = valid.reduce((sum, p) => sum + p.ratio, 0) / valid.length;
  const first = valid[0];
  return {
    sideConvention: MOVEMENT_SIDE_CONVENTION,
    side: first.side,
    ratio: roundMetric(ratio),
    deltaPct: Math.round((ratio - 1) * 100),
    baselineMovement: first.baselineMovement,
    currentMovement: roundMetric(valid.reduce((sum, p) => sum + (p.currentMovement ?? 0), 0) / valid.length),
    reps: valid.length,
  };
}

function summarizeSessionBaselineProgress(scores, key = "baselineProgress") {
  return summarizeBaselineProgress((scores ?? []).map((s) => s?.[key]).filter(Boolean));
}

function averageMetric(items, key) {
  const valid = items.map((item) => item?.[key]).filter((value) => Number.isFinite(value));
  return valid.length ? roundMetric(valid.reduce((sum, value) => sum + value, 0) / valid.length) : null;
}

function summarizeMovementProgress(items) {
  const valid = (items ?? []).filter((p) => !progressUsesLegacySideConvention(p) && p?.affectedProgressRatio != null);
  if (!valid.length) return null;
  const affectedProgressRatio = averageMetric(valid, "affectedProgressRatio");
  return {
    sideConvention: MOVEMENT_SIDE_CONVENTION,
    side: valid[0].side,
    referenceSide: valid[0].referenceSide,
    affectedMovement: averageMetric(valid, "affectedMovement"),
    properMovement: averageMetric(valid, "properMovement"),
    affectedToProperRatio: averageMetric(valid, "affectedToProperRatio"),
    baselineAffectedMovement: averageMetric(valid, "baselineAffectedMovement"),
    baselineProperMovement: averageMetric(valid, "baselineProperMovement"),
    baselineAffectedToProperRatio: averageMetric(valid, "baselineAffectedToProperRatio"),
    affectedProgressRatio,
    properProgressRatio: averageMetric(valid, "properProgressRatio"),
    balanceProgressRatio: averageMetric(valid, "balanceProgressRatio"),
    deltaPct: affectedProgressRatio == null ? null : Math.round((affectedProgressRatio - 1) * 100),
    reps: valid.length,
  };
}

function summarizeSessionMovementProgress(scores, key = "movementProgress") {
  return summarizeMovementProgress((scores ?? []).map((s) => s?.[key]).filter(Boolean));
}

function movementProgressLabel(progress) {
  if (progressUsesLegacySideConvention(progress)) return "legacy movement data";
  if (progress?.affectedProgressRatio == null) return null;
  if (progress.affectedProgressRatio >= 1) return `+${progress.deltaPct}% from baseline`;
  return `${Math.round(progress.affectedProgressRatio * 100)}% of baseline`;
}

function movementBalanceLabel(progress) {
  if (progressUsesLegacySideConvention(progress)) return null;
  if (progress?.affectedToProperRatio == null) return null;
  const today = Math.round(progress.affectedToProperRatio * 100);
  if (progress.baselineAffectedToProperRatio == null) return `affected vs proper: ${today}% today`;
  const baseline = Math.round(progress.baselineAffectedToProperRatio * 100);
  return `affected vs proper: ${today}% today vs ${baseline}% at baseline`;
}

function baselineProgressLabel(progress) {
  if (progressUsesLegacySideConvention(progress)) return "legacy movement data";
  if (progress?.affectedProgressRatio != null) return movementProgressLabel(progress);
  if (progress?.ratio == null) return null;
  if (progress.ratio >= 1) return `+${progress.deltaPct}% from baseline`;
  return `${Math.round(progress.ratio * 100)}% of baseline`;
}

function preferredBaselineProgress(record) {
  if (progressUsesCurrentSideConvention(record?.initialBaselineProgress)) return record.initialBaselineProgress;
  if (progressUsesCurrentSideConvention(record?.baselineProgress)) return record.baselineProgress;
  return null;
}

function preferredMovementProgress(record) {
  if (progressUsesCurrentSideConvention(record?.initialMovementProgress)) return record.initialMovementProgress;
  if (progressUsesCurrentSideConvention(record?.movementProgress)) return record.movementProgress;
  return null;
}

const EXERCISE_CATALOG_INDEX = new Map(EXERCISES.map((exercise, index) => [exercise.id, index]));
const PLAN_REGION_INDEX = new Map(PLAN_REGION_ORDER.map((region, index) => [region, index]));
const PLAN_STALE_SESSION_DAYS = 3;
const PLAN_CAPTURE_QUALITY_PENALTY = { unscored: 0.22, weak: 0.14, usable: 0.04 };
const PLAN_COACTIVATION_PENALTY = { high: 0.18, medium: 0.08 };

function uniqueKnownExerciseIds(ids) {
  const out = [];
  const seen = new Set();
  for (const id of ids ?? []) {
    if (seen.has(id) || !EXERCISE_CATALOG_INDEX.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function orderExerciseIdsByRegion(ids, priorityIds = []) {
  const priorityIndex = new Map(uniqueKnownExerciseIds(priorityIds).map((id, index) => [id, index]));
  return uniqueKnownExerciseIds(ids).sort((a, b) => {
    const exA = EXERCISES[EXERCISE_CATALOG_INDEX.get(a)];
    const exB = EXERCISES[EXERCISE_CATALOG_INDEX.get(b)];
    const regionA = PLAN_REGION_INDEX.get(exA?.region) ?? PLAN_REGION_ORDER.length;
    const regionB = PLAN_REGION_INDEX.get(exB?.region) ?? PLAN_REGION_ORDER.length;
    if (regionA !== regionB) return regionA - regionB;
    const priorityA = priorityIndex.has(a) ? priorityIndex.get(a) : Number.MAX_SAFE_INTEGER;
    const priorityB = priorityIndex.has(b) ? priorityIndex.get(b) : Number.MAX_SAFE_INTEGER;
    if (priorityA !== priorityB) return priorityA - priorityB;
    return EXERCISE_CATALOG_INDEX.get(a) - EXERCISE_CATALOG_INDEX.get(b);
  });
}

function applyPersonalPlanOverrides(coreIds, personalPlan) {
  const selectedPlan = uniqueKnownExerciseIds(personalPlan?.selectedExerciseIds);
  if (selectedPlan.length) return selectedPlan;
  const core = uniqueKnownExerciseIds(coreIds);
  const removed = new Set(uniqueKnownExerciseIds(personalPlan?.removedExerciseIds));
  const added = uniqueKnownExerciseIds(personalPlan?.addedExerciseIds);
  const selected = core.filter((id) => !removed.has(id));
  for (const id of added) {
    if (!selected.includes(id)) selected.push(id);
  }
  return selected.length ? selected : core;
}

function latestRecordDate(records = []) {
  const dated = records
    .map((record) => record?.date ?? (Number.isFinite(record?.ts) ? new Date(record.ts).toISOString().slice(0, 10) : null))
    .filter(Boolean)
    .sort();
  return dated.at(-1) ?? null;
}

function adaptivePlanContext(sessions = [], options = {}) {
  const countedSessions = (sessions ?? []).filter(isCountedSession);
  const latestSessionDate = latestRecordDate(countedSessions);
  const latestJournalDate = latestRecordDate(options.journal ?? []);
  const referenceDate = options.referenceDate ?? latestJournalDate ?? latestSessionDate ?? new Date().toISOString().slice(0, 10);
  const missedDays = latestSessionDate ? daysBetween(latestSessionDate, referenceDate) : null;
  const journalPrompts = summarizeJournalSafetyPrompts(options.journal ?? [], { referenceDate });
  const fatigueOrPainPrompt = journalPrompts.some((prompt) => prompt.id === "significant-fatigue" || prompt.id === "pain-or-strain");
  return {
    referenceDate,
    missedDays,
    stalePractice: missedDays != null && missedDays >= PLAN_STALE_SESSION_DAYS,
    fatigueOrPainPrompt,
  };
}

function planRiskPenalty(latest, context) {
  const capturePenalty = PLAN_CAPTURE_QUALITY_PENALTY[latest?.captureQuality?.key] ?? 0;
  const coactivationRisk = latest?.movementFeatures?.coactivation?.risk ?? latest?.coactivation?.risk;
  const coactivationPenalty = PLAN_COACTIVATION_PENALTY[coactivationRisk] ?? 0;
  const cautionPenalty = context?.fatigueOrPainPrompt && (capturePenalty > 0 || coactivationPenalty > 0) ? 0.06 : 0;
  return capturePenalty + coactivationPenalty + cautionPenalty;
}

function buildSystemDailyPlan(profile, sessions = [], count = DAILY_ESSENTIALS.length, options = {}) {
  if (!profile?.exercises) return DAILY_ESSENTIALS.slice(0, count);
  const scored = getAdaptiveFocusItems(profile, sessions, count, options).map((item) => item.id);
  return [...new Set([...scored, ...DAILY_ESSENTIALS])].slice(0, count);
}

function buildPersonalizedDailyPlan(profile, sessions = [], count = DAILY_ESSENTIALS.length, options = {}) {
  const core = buildSystemDailyPlan(profile, sessions, count, options);
  const withOverrides = options.personalPlan ? applyPersonalPlanOverrides(core, options.personalPlan) : core;
  const priority = uniqueKnownExerciseIds(options.personalPlan?.selectedExerciseIds).length ? withOverrides : core;
  return options.orderByRegion ? orderExerciseIdsByRegion(withOverrides, priority) : withOverrides;
}

function latestSessionBaselineProgress(sessions) {
  const latest = [...(sessions ?? [])].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).find((s) => preferredBaselineProgress(s));
  return preferredBaselineProgress(latest);
}

function latestSessionMovementProgress(sessions) {
  const latest = [...(sessions ?? [])].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)).find((s) => preferredMovementProgress(s) || preferredBaselineProgress(s));
  return preferredMovementProgress(latest) ?? preferredBaselineProgress(latest);
}

function latestExerciseProgressById(sessions) {
  const out = {};
  for (const session of [...(sessions ?? [])].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))) {
    for (const score of session.scores ?? []) {
      const progress = preferredMovementProgress(score) ?? preferredBaselineProgress(score);
      if (!out[score.exerciseId] && progress) out[score.exerciseId] = progress;
    }
  }
  return out;
}

function latestExerciseScoreById(sessions) {
  const out = {};
  for (const session of [...(sessions ?? [])].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))) {
    for (const score of session.scores ?? []) {
      if (!out[score.exerciseId]) out[score.exerciseId] = score;
    }
  }
  return out;
}

function getAdaptiveFocusItems(profile, sessions, count = 5, options = {}) {
  if (!profile?.exercises) return [];
  const latestByExercise = latestExerciseScoreById(sessions);
  const planContext = adaptivePlanContext(sessions, options);
  return Object.values(profile.exercises)
    .filter((ex) => EXERCISES.some((item) => item.id === ex.exerciseId))
    .map((ex) => {
      const latest = latestByExercise[ex.exerciseId];
      const baselineGap = ex.initialSymmetry == null ? 0.25 : 1 - ex.initialSymmetry;
      const latestGap = latest?.avg == null ? 0 : 1 - latest.avg;
      const latestProgress = preferredMovementProgress(latest) ?? preferredBaselineProgress(latest);
      const latestProgressRatio = latestProgress?.affectedProgressRatio ?? latestProgress?.ratio;
      const progressGap = latestProgressRatio == null ? 0.15 : Math.max(0, 1 - latestProgressRatio);
      const balanceGap = latestProgress?.balanceProgressRatio == null ? 0 : Math.max(0, 1 - latestProgress.balanceProgressRatio);
      const sideFocus = (profile.affectedSide === "left" || profile.affectedSide === "right") && ex.limitedSide === profile.affectedSide ? 0.2 : 0;
      const noRecentData = latest ? 0 : (planContext.stalePractice || planContext.fatigueOrPainPrompt ? 0 : 0.1);
      const riskPenalty = planRiskPenalty(latest, planContext);
      const score = Math.max(0, baselineGap * 0.35 + latestGap * 0.25 + progressGap * 0.35 + balanceGap * 0.2 + sideFocus + noRecentData - riskPenalty);
      return {
        id: ex.exerciseId,
        score,
        baselineGap,
        latestGap,
        progressGap,
        balanceGap,
        noRecentData,
        riskPenalty,
        planContext,
        latest,
        exercise: EXERCISES.find((item) => item.id === ex.exerciseId),
        profileExercise: ex,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

function focusReason(item) {
  if (!item) return "";
  const progress = preferredMovementProgress(item.latest) ?? preferredBaselineProgress(item.latest);
  if (progress?.affectedProgressRatio != null && progress.affectedProgressRatio < 1) {
    return `affected movement ${Math.round(progress.affectedProgressRatio * 100)}% of baseline`;
  }
  if (progress?.balanceProgressRatio != null && progress.balanceProgressRatio < 1) {
    return `balance ${Math.round(progress.balanceProgressRatio * 100)}% of baseline`;
  }
  if (progress?.ratio != null && progress.ratio < 1) {
    return `${Math.round(progress.ratio * 100)}% of baseline`;
  }
  if (item.latest?.avg != null) return `recent symmetry ${Math.round(item.latest.avg * 100)}%`;
  if (item.profileExercise.initialSymmetry != null) return `baseline symmetry ${Math.round(item.profileExercise.initialSymmetry * 100)}%`;
  return `limited side ${item.profileExercise.limitedSide}`;
}

function sessionFocusRecommendation(scores) {
  const ranked = (scores ?? [])
    .filter((s) => s.avg != null || preferredMovementProgress(s) || preferredBaselineProgress(s))
    .map((s) => {
      const progress = preferredMovementProgress(s) ?? preferredBaselineProgress(s);
      const progressRatio = progress?.affectedProgressRatio ?? progress?.ratio;
      const symmetryGap = s.avg == null ? 0 : 1 - s.avg;
      const progressGap = progressRatio == null ? 0.1 : Math.max(0, 1 - progressRatio);
      const balanceGap = progress?.balanceProgressRatio == null ? 0 : Math.max(0, 1 - progress.balanceProgressRatio);
      return { ...s, focusScore: symmetryGap * 0.45 + progressGap * 0.45 + balanceGap * 0.25 };
    })
    .sort((a, b) => b.focusScore - a.focusScore);
  return ranked[0] ?? null;
}

function profileAgeDays(profile) {
  if (!profile?.createdAt) return null;
  return Math.max(0, Math.floor((Date.now() - profile.createdAt) / (1000 * 60 * 60 * 24)));
}

function profileQuality(profile) {
  const metric = profile?.calibrationQuality?.coreAvgNoise ?? profile?.calibrationQuality?.avgNoise;
  if (metric == null) return { key: "unknown", label: "Unknown", color: "#A8A29E", metric: null };
  if (metric <= PROFILE_STEADY_NOISE_MAX) return { key: "steady", label: "Steady", color: "#7A8F73", metric };
  if (metric <= PROFILE_USABLE_NOISE_MAX) return { key: "usable", label: "Usable", color: "#D4A574", metric };
  return { key: "noisy", label: "Noisy", color: "#B8543A", metric };
}

function profileStatus(profile) {
  if (!profile) return null;
  const ageDays = profileAgeDays(profile);
  const quality = profileQuality(profile);
  const stale = ageDays != null && ageDays >= PROFILE_RETAKE_DAYS;
  const noisy = quality.key === "noisy";
  const exerciseEntries = Object.values(profile.exercises ?? {});
  const retakeExercises = exerciseEntries.filter((ex) => ex.quality?.key === "retake");
  return {
    ageDays,
    quality,
    stale,
    noisy,
    retakeExercises,
    shouldRetake: stale || noisy || retakeExercises.length > 0,
    reason: noisy ? "calibration was noisy" : stale ? `${ageDays} days old` : retakeExercises.length > 0 ? `${retakeExercises.length} exercise baseline${retakeExercises.length === 1 ? "" : "s"} need review` : null,
  };
}

function profileExerciseEntries(profile) {
  const order = new Map(PROFILE_ASSESSMENT_EXERCISES.map((id, index) => [id, index]));
  return Object.values(profile?.exercises ?? {}).sort((a, b) => {
    const aOrder = order.get(a.exerciseId) ?? 99;
    const bOrder = order.get(b.exerciseId) ?? 99;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return (a.name ?? "").localeCompare(b.name ?? "");
  });
}

function formatProfileSide(side) {
  const labels = { left: "left", right: "right", both: "both", unsure: "unsure", balanced: "balanced", unknown: "unknown" };
  return labels[side] ?? "unsure";
}

function formatProfileDate(ts) {
  if (!ts) return null;
  return new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function signedPointDelta(delta) {
  if (delta == null) return null;
  const pts = Math.round(delta * 100);
  if (pts === 0) return "0 pts";
  return `${pts > 0 ? "+" : ""}${pts} pts`;
}

function calibrationQualityMetric(profile) {
  if (profile?.calibrationQuality?.coreAvgNoise != null) {
    return {
      value: profile.calibrationQuality.coreAvgNoise,
      source: "coreAvgNoise",
      label: "Core calibration noise",
    };
  }
  if (profile?.calibrationQuality?.avgNoise != null) {
    return {
      value: profile.calibrationQuality.avgNoise,
      source: "avgNoise",
      label: "Calibration noise",
    };
  }
  return { value: null, source: null, label: "Calibration noise" };
}

function compareMovementProfiles(current, previous) {
  if (!current || !previous) return null;
  const avgSymmetryDelta = current.initialAvgSymmetry != null && previous.initialAvgSymmetry != null
    ? current.initialAvgSymmetry - previous.initialAvgSymmetry
    : null;
  const currentNoise = calibrationQualityMetric(current);
  const previousNoise = calibrationQualityMetric(previous);
  const noiseDelta = currentNoise.value != null && previousNoise.value != null
    ? currentNoise.value - previousNoise.value
    : null;
  const previousExercises = previous.exercises ?? {};
  const exerciseDeltas = profileExerciseEntries(current)
    .map((ex) => {
      const prev = previousExercises[ex.exerciseId];
      if (ex.initialSymmetry == null || prev?.initialSymmetry == null) return null;
      return { exerciseId: ex.exerciseId, name: ex.name, region: ex.region, symmetryDelta: ex.initialSymmetry - prev.initialSymmetry };
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.symmetryDelta) - Math.abs(a.symmetryDelta));
  return {
    previousDate: formatProfileDate(previous.createdAt),
    archivedDate: formatProfileDate(previous.archivedAt),
    avgSymmetryDelta,
    noiseDelta,
    noiseMetric: currentNoise.source ?? previousNoise.source,
    noiseLabel: currentNoise.label,
    exerciseDeltas,
  };
}

// Anatomical face midline (top of forehead → glabella → nose bridge → nose tip → philtrum → chin).
// Used as a dotted symmetry guide so the user can compare left/right sides of the face by eye.
const FACE_MIDLINE = [10, 151, 9, 8, 168, 6, 197, 195, 5, 4, 1, 19, 94, 2, 164, 0, 11, 12, 13, 14, 15, 16, 17, 18, 200, 199, 175, 152];

// Face contour + key feature indices for the overlay (subset of the 468-point mesh)
const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
const LEFT_BROW = [70, 63, 105, 66, 107];
const RIGHT_BROW = [336, 296, 334, 293, 300];
const LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];

// Compute the object-cover transform that maps normalized landmark coords -> mirrored display pixels
function objectCoverTransform(canvas, video) {
  const cw = canvas.width, ch = canvas.height;
  const vw = video.videoWidth || cw, vh = video.videoHeight || ch;
  if (!vw || !vh) return null;
  const scale = Math.max(cw / vw, ch / vh);
  const dw = vw * scale, dh = vh * scale;
  const ox = (cw - dw) / 2, oy = (ch - dh) / 2;
  return { dw, dh, ox, oy, cw };
}

function drawOverlay(canvas, video, lm, { aligned, phase }) {
  if (!canvas || !video) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Centering ring (posture guide) — green when aligned, soft amber otherwise
  const cx = canvas.width / 2, cy = canvas.height / 2;
  const ringR = Math.min(canvas.width, canvas.height) * 0.36;
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = aligned ? "rgba(122,143,115,0.85)" : "rgba(212,165,116,0.55)";
  ctx.setLineDash([8 * dpr, 8 * dpr]);
  ctx.beginPath(); ctx.ellipse(cx, cy, ringR * 0.78, ringR, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);

  if (!lm) return;
  const t = objectCoverTransform(canvas, video);
  if (!t) return;
  const px = (p) => t.cw - (p.x * t.dw + t.ox); // mirrored X to match scaleX(-1) on the video
  const py = (p) => p.y * t.dh + t.oy;

  // Faint full mesh (every 3rd point — keeps it readable)
  ctx.fillStyle = "rgba(244,239,230,0.18)";
  for (let i = 0; i < lm.length; i += 3) {
    const p = lm[i]; if (!p) continue;
    ctx.beginPath(); ctx.arc(px(p), py(p), 1 * dpr, 0, Math.PI * 2); ctx.fill();
  }

  // Feature polylines
  const stroke = (idxs, color, closed) => {
    ctx.beginPath();
    idxs.forEach((i, k) => { const p = lm[i]; if (!p) return; const x = px(p), y = py(p); if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    if (closed) ctx.closePath();
    ctx.strokeStyle = color; ctx.lineWidth = 1.5 * dpr; ctx.stroke();
  };
  stroke(FACE_OVAL, "rgba(244,239,230,0.6)", true);
  stroke(LEFT_BROW, "rgba(212,165,116,0.95)", false);
  stroke(RIGHT_BROW, "rgba(212,165,116,0.95)", false);
  stroke(LEFT_EYE, "rgba(184,84,58,0.9)", true);
  stroke(RIGHT_EYE, "rgba(184,84,58,0.9)", true);
  stroke(LIPS_OUTER, "rgba(184,84,58,0.95)", true);

  // Dotted vertical symmetry midline — follows the face's anatomical center line, not the screen center,
  // so it stays correct when the head tilts.
  ctx.save();
  ctx.setLineDash([4 * dpr, 5 * dpr]);
  ctx.strokeStyle = "rgba(244,239,230,0.55)";
  ctx.lineWidth = 1.25 * dpr;
  ctx.beginPath();
  let started = false;
  for (const i of FACE_MIDLINE) {
    const p = lm[i]; if (!p) continue;
    const x = px(p), y = py(p);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  if (started) ctx.stroke();
  ctx.restore();

  // Highlight the symmetry pairs in accent during hold
  if (phase === "hold") {
    ctx.fillStyle = "rgba(122,143,115,1)";
    for (const [l, r] of SYMMETRY_PAIRS) {
      for (const i of [l, r]) {
        const p = lm[i]; if (!p) continue;
        ctx.beginPath(); ctx.arc(px(p), py(p), 3 * dpr, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
}

function faceAlignmentFeedback(lm) {
  if (!lm || !lm[1] || !lm[33] || !lm[263]) {
    return { aligned: false, label: "Find your face in the camera", issue: "missing" };
  }
  const nose = lm[1];
  const centerOff = Math.hypot(nose.x - 0.5, nose.y - 0.5);
  const eyeDx = lm[263].x - lm[33].x;
  const eyeDy = lm[263].y - lm[33].y;
  const tiltRad = Math.atan2(eyeDy, eyeDx); // ~0 when level
  const centered = centerOff < FACE_CENTER_MAX_OFFSET;
  const level = Math.abs(tiltRad) < FACE_TILT_MAX_RAD;
  if (centered && level) return { aligned: true, label: "Posture · centered", issue: null, centerOff, tiltRad };
  if (!centered && !level) return { aligned: false, label: "Center and level your face", issue: "center-tilt", centerOff, tiltRad };
  if (!centered) return { aligned: false, label: "Center your face in the ring", issue: "center", centerOff, tiltRad };
  return { aligned: false, label: "Keep your eyes level", issue: "tilt", centerOff, tiltRad };
}

function calibrationPrompt(progress, delta) {
  if (delta > CALIBRATION_RESET_EPS) return "Too much movement. Relax your jaw, stop talking, and hold neutral.";
  if (delta > CALIBRATION_STABILITY_EPS) return "Small movement detected. Keep the same resting expression.";
  if (progress < 8) return "Good. Keep your face soft and neutral.";
  if (progress < CALIBRATION_FRAMES - 6) return "Stay relaxed. Avoid blinking or smiling.";
  return "Almost done. Hold this same neutral pose.";
}

function captureSnapshot(video, canvas, { width = REPORT_SNAPSHOT_WIDTH, quality = REPORT_SNAPSHOT_QUALITY } = {}) {
  if (!video || !canvas || !video.videoWidth) return null;
  const W = Math.min(width, video.videoWidth || width);
  const H = Math.round((video.videoHeight / video.videoWidth) * W);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.save();
  ctx.translate(W, 0); ctx.scale(-1, 1); // mirror to match the on-screen video
  ctx.drawImage(video, 0, 0, W, H);
  ctx.restore();
  try { return canvas.toDataURL("image/jpeg", quality); } catch { return null; }
}

function averageLandmarks(buffer) {
  if (!buffer.length) return null;
  const n = buffer[0].length; const out = [];
  for (let i = 0; i < n; i++) {
    let sx = 0, sy = 0, sz = 0;
    for (const lm of buffer) { sx += lm[i].x; sy += lm[i].y; sz += lm[i].z ?? 0; }
    out.push({ x: sx / buffer.length, y: sy / buffer.length, z: sz / buffer.length });
  }
  return out;
}

const SMOOTHING_ALPHA = 0.65; // EMA factor — higher = more responsive, lower = steadier

function smoothLandmarks(prev, next) {
  if (!prev || prev.length !== next.length) return next.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
  const a = SMOOTHING_ALPHA;
  const out = new Array(next.length);
  for (let i = 0; i < next.length; i++) {
    const p = prev[i], n = next[i];
    out[i] = {
      x: p.x + a * (n.x - p.x),
      y: p.y + a * (n.y - p.y),
      z: (p.z ?? 0) + a * ((n.z ?? 0) - (p.z ?? 0)),
    };
  }
  return out;
}

const LIVE_SCORE_DEFAULTS = {
  maxFrames: 9,
  maxAgeMs: 450,
  alpha: 0.3,
  invalidHoldMs: 150,
};

function medianMetric(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
}

function createLiveScoreStabilizer(config = {}) {
  const options = { ...LIVE_SCORE_DEFAULTS, ...config };
  const state = { samples: [], display: null, lastValidAt: null };

  const reset = () => {
    state.samples = [];
    state.display = null;
    state.lastValidAt = null;
  };

  const update = (symResult, now = Date.now()) => {
    if (!symResult || !Number.isFinite(symResult.leftDisp) || !Number.isFinite(symResult.rightDisp)) {
      if (state.display && state.lastValidAt != null && now - state.lastValidAt <= options.invalidHoldMs) {
        return state.display;
      }
      reset();
      return null;
    }

    state.lastValidAt = now;
    state.samples.push({
      ts: now,
      leftDisp: symResult.leftDisp,
      rightDisp: symResult.rightDisp,
      peak: symResult.peak,
    });
    state.samples = state.samples
      .filter((sample) => now - sample.ts <= options.maxAgeMs)
      .slice(-options.maxFrames);

    const leftDisp = medianMetric(state.samples.map((sample) => sample.leftDisp));
    const rightDisp = medianMetric(state.samples.map((sample) => sample.rightDisp));
    if (leftDisp == null || rightDisp == null) return state.display;
    const peak = Math.max(leftDisp, rightDisp, medianMetric(state.samples.map((sample) => sample.peak)) ?? 0);
    const symmetry = peak > 0 ? clampNumber(Math.min(leftDisp, rightDisp) / peak, 0, 1) : null;
    if (symmetry == null) return state.display;

    if (!state.display) {
      state.display = { symmetry, leftDisp, rightDisp, peak };
      return state.display;
    }

    const alpha = clampNumber(options.alpha, 0, 1);
    state.display = {
      symmetry: state.display.symmetry + alpha * (symmetry - state.display.symmetry),
      leftDisp: state.display.leftDisp + alpha * (leftDisp - state.display.leftDisp),
      rightDisp: state.display.rightDisp + alpha * (rightDisp - state.display.rightDisp),
      peak: state.display.peak + alpha * (peak - state.display.peak),
    };
    return state.display;
  };

  return { reset, update };
}
export {
  BROW_EXERCISES,
  CALIBRATION_DELTA_POINTS,
  CORE_QUALITY_POINTS,
  DEFAULT_SCORING_NOISE_MODE,
  EXERCISE_BLENDSHAPES,
  LEGACY_MOVEMENT_SIDE_CONVENTION,
  MOVEMENT_SIDE_CONVENTION,
  NOSE_EXERCISES,
  SCORE_DROP_REASONS,
  SCORING_MODEL_VERSION,
  SCORING_NOISE_MODES,
  activationThresholdForExercise,
  thresholdBandsForExercise,
  averageFacialTransformationMatrix,
  averageBlendshapes,
  averageLandmarks,
  baselineProgressLabel,
  bsActivation,
  buildMovementProfile,
  buildPersonalizedDailyPlan,
  calibrationPrompt,
  captureSnapshot,
  compareMovementProfiles,
  computeBaselineProgress,
  computeBaselineProgressFromDisplacements,
  computeBrowSymmetry,
  computeExerciseSymmetry,
  computeExerciseSymmetryDiagnostic,
  computeFrownSymmetry,
  createLiveScoreStabilizer,
  computeMovementProgress,
  computeMovementProgressFromDisplacements,
  computeNoiseFloor,
  computeNoseScrunchSymmetry,
  computeNoseSymmetry,
  computeNostrilFlareSymmetry,
  computePairwiseSymmetry,
  computeQuietRegionCoactivation,
  computeSymmetry,
  compactFacialTransformationMatrix,
  drawOverlay,
  effectiveProfileThreshold,
  profileLiveScoringThreshold,
  exerciseBaselineQuality,
  exerciseUsesBlendshapeFusion,
  faceAlignmentFeedback,
  faceFrameNormalize,
  firstFacialTransformationMatrix,
  flipLeftRightSide,
  focusReason,
  formatProfileDate,
  normalizeScoringNoiseMode,
  formatProfileSide,
  getAdaptiveFocusItems,
  getProfileExercise,
  headPoseDeviationRad,
  latestExerciseProgressById,
  latestExerciseScoreById,
  latestSessionBaselineProgress,
  latestSessionMovementProgress,
  movementBalanceLabel,
  movementProgressLabel,
  normalizedFrameDelta,
  objectCoverTransform,
  orderExerciseIdsByRegion,
  preferredBaselineProgress,
  preferredMovementProgress,
  progressUsesLegacySideConvention,
  profileAgeDays,
  profileBaselineForSide,
  profileExerciseEntries,
  profileQuality,
  profileStatus,
  resolveFocusSide,
  robustMovementWindow,
  roundMetric,
  sessionFocusRecommendation,
  signedPointDelta,
  smoothFacialTransformationMatrix,
  smoothLandmarks,
  scoringOptionsFrom,
  summarizeBaselineProgress,
  summarizeMovementProgress,
  summarizeRestingAsymmetry,
  summarizeSessionBaselineProgress,
  summarizeSessionMovementProgress,
  inferLimitedSide,
};
