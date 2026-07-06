// Daily cadence: short sessions spread N times across waking hours.
export const DAY_START_HOUR = 9;  // 9 AM
export const DAY_END_HOUR = 21;   // 9 PM
export const INTERSTITIAL_SEC = 10;
// Max times a single exercise can be queued in one routine.
export const MAX_EXERCISE_REPEATS = 5;
export const MIN_EXERCISE_REPS = 1;
export const MAX_EXERCISE_REPS = 20;
export const HOLD_SEC = 4;       // fallback hold duration; profiled sessions can use exercise-specific dosing
export const REST_SEC = 2;       // fallback rest duration; serves as entry settle AND between-rep recovery

export const CALIBRATION_FRAMES = 24;
export const CALIBRATION_STABILITY_EPS = 0.006;
export const CALIBRATION_RESET_EPS = 0.018;

export const FACE_CENTER_MAX_OFFSET = 0.12;
export const FACE_TILT_MAX_RAD = 0.12;
// 2D alignment only catches in-plane roll. The 3D pose matrix lets us also reject
// hold frames where the user has yawed or pitched far from the neutral pose, which
// degrades the corrected normalization through perspective and weak-z effects.
// ~11.5°: well outside normal micro-wobble, well inside what the 2D gate permits.
export const HOLD_HEAD_POSE_MAX_RAD = 0.20;

// v3: corrected column-major reading of MediaPipe's facial transformation matrix
// (the pose-inverse step now applies R^T rather than R) plus the hold-time
// head-pose-deviation gate. Off-axis baselines captured pre-v3 may have slightly
// inflated leftBaselineMovement/rightBaselineMovement.
export const PROFILE_VERSION = 3;
export const PROFILE_HOLD_SEC = 4;
export const PROFILE_REST_SEC = 2;
export const PROFILE_EXERCISE_NEUTRAL_MIN_FRAMES = 8;
export const PROFILE_REST_RETRY_LIMIT = 1;
export const PROFILE_BASELINE_TOP_FRACTION = 0.2;
export const PROFILE_MIN_SCORED_FRAMES = 8;
export const PROFILE_MIN_ALIGNMENT_RATIO = 0.7;
export const PROFILE_RETAKE_DAYS = 14;
export const PROFILE_HISTORY_LIMIT = 6;
export const PROFILE_STEADY_NOISE_MAX = 0.006;
export const PROFILE_USABLE_NOISE_MAX = 0.018;

export const REPORT_SNAPSHOT_WIDTH = 400;
export const REPORT_SNAPSHOT_QUALITY = 0.75;

// Cap how many past sessions keep their heavy media (report images + captured
// frame samples). Older sessions keep their compact score records — which drive
// progress charts and the recovery model — but shed their blobs so local storage
// cannot grow without bound. Scores are never dropped by retention.
export const MEDIA_RETENTION_SESSIONS = 12;

export const COMFORT_DOSING = {
  gentle: { key: "gentle", label: "Gentle", repScale: 0.65, minReps: 3, maxReps: 8, holdDeltaSec: -1, minHoldSec: 2, maxHoldSec: 4, restSec: 3 },
  normal: { key: "normal", label: "Normal", repScale: 1, minReps: 4, maxReps: 10, holdDeltaSec: 0, minHoldSec: 2, maxHoldSec: 5, restSec: 2 },
  advanced: { key: "advanced", label: "Advanced", repScale: 1.15, minReps: 5, maxReps: 12, holdDeltaSec: 0, minHoldSec: 2, maxHoldSec: 5, restSec: 2 },
};
