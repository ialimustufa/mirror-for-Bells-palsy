import { COMFORT_DOSING, DAY_END_HOUR, DAY_START_HOUR, HOLD_SEC, MAX_EXERCISE_REPS, MIN_EXERCISE_REPS, REST_SEC } from "./config";
import { EXERCISES } from "./exercises";

// Persisted app state is intentionally compact and append-only for sessions/journal.
// Derived trend metrics are recomputed in views instead of stored.
// selectedExerciseIds is the canonical saved routine. added/removed are retained so
// older saved plans can still be interpreted after migration.
// repCounts maps an exercise id -> the target reps for that exercise in a routine.
// repeatCounts maps an exercise id -> how many times it repeats in the routine (>= 2;
// a count of 1 is the default and is omitted). Kept de-duplicated alongside the id lists.
export const DEFAULT_PERSONAL_PLAN = { selectedExerciseIds: [], addedExerciseIds: [], removedExerciseIds: [], repeatCounts: {}, repCounts: {} };

export const DEFAULT_DATA = {
  journal: [],
  sessions: [],
  assessments: [],
  movementProfile: null,
  initialMovementProfile: null,
  movementProfileHistory: [],
  personalRecoveryModel: null,
  prefs: {
    voiceEnabled: true,
    mirrorEnabled: true,
    symmetryEnabled: true,
    personalModelEnabled: true,
    clinicalScaleEstimatesEnabled: true,
    dataCaptureEnabled: false,
    scoringNoiseMode: "normal",
    scoringDiagnosticsEnabled: false,
    dailyGoal: 3,
    onboarded: false,
    personalPlan: DEFAULT_PERSONAL_PLAN,
  },
};

const DAY_MS = 1000 * 60 * 60 * 24;
const MIN_REASONABLE_RECORD_TS = Date.UTC(2020, 0, 1);

function pad2(value) {
  return String(value).padStart(2, "0");
}

function parseCalendarDateParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const localDate = new Date(year, monthIndex, day);
  if (
    localDate.getFullYear() !== year
    || localDate.getMonth() !== monthIndex
    || localDate.getDate() !== day
  ) {
    return null;
  }
  return { year, monthIndex, day };
}

function calendarDateUtcMs(value) {
  const parts = parseCalendarDateParts(value);
  if (parts) return Date.UTC(parts.year, parts.monthIndex, parts.day);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return NaN;
  return Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

export function localDateISO(date = new Date()) {
  const parsed = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.getFullYear()}-${pad2(parsed.getMonth() + 1)}-${pad2(parsed.getDate())}`;
}

export function normalizeCalendarDate(value) {
  const parts = parseCalendarDateParts(value);
  if (!parts) return null;
  return `${parts.year}-${pad2(parts.monthIndex + 1)}-${pad2(parts.day)}`;
}

export function dateISOFromTimestamp(ts) {
  const value = Number(ts);
  if (!Number.isFinite(value) || value < MIN_REASONABLE_RECORD_TS) return null;
  return localDateISO(new Date(value));
}

export function recordDateISO(record = {}) {
  if (!record || typeof record !== "object") return null;
  return dateISOFromTimestamp(record.ts)
    ?? dateISOFromTimestamp(record.sourceSessionTs)
    ?? dateISOFromTimestamp(record.createdAt)
    ?? normalizeCalendarDate(record.date);
}

export function addDaysISO(dateISO, days) {
  const parts = parseCalendarDateParts(dateISO);
  if (!parts) return null;
  const date = new Date(parts.year, parts.monthIndex, parts.day);
  date.setDate(date.getDate() + days);
  return localDateISO(date);
}

export function formatCalendarDate(dateISO, options = {}) {
  const parts = parseCalendarDateParts(dateISO);
  if (!parts) return "";
  return new Date(parts.year, parts.monthIndex, parts.day).toLocaleDateString(undefined, options);
}

export const todayISO = () => localDateISO(new Date());
export const daysBetween = (a, b) => {
  const start = calendarDateUtcMs(a);
  const end = calendarDateUtcMs(b);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.round((end - start) / DAY_MS) : 0;
};

// Single-exercise standalone runs are tagged "practice" and standardized assessment
// runs are tagged "assessment" — they're still saved, but don't count toward the
// daily-goal X-of-Y counter. Legacy records have no kind and continue to count.
export function isCountedSession(s) {
  return s?.kind !== "practice" && s?.kind !== "assessment";
}

export function getComfortDosing(profileOrLevel) {
  const key = typeof profileOrLevel === "string" ? profileOrLevel : profileOrLevel?.comfortLevel;
  return COMFORT_DOSING[key] ?? COMFORT_DOSING.normal;
}

export function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function applySessionDose(exercise, profile, options = {}) {
  const dosing = getComfortDosing(profile);
  const dosedReps = clampNumber(Math.round(exercise.reps * dosing.repScale), dosing.minReps, dosing.maxReps);
  const customReps = Number(options.reps);
  const reps = Number.isFinite(customReps)
    ? clampNumber(Math.round(customReps), MIN_EXERCISE_REPS, MAX_EXERCISE_REPS)
    : dosedReps;
  const holdSec = clampNumber(Math.round(exercise.holdSec + dosing.holdDeltaSec), dosing.minHoldSec, dosing.maxHoldSec);
  return {
    ...exercise,
    baseReps: exercise.reps,
    baseHoldSec: exercise.holdSec,
    reps,
    holdSec,
    restSec: dosing.restSec,
    comfortLevel: dosing.key,
    ...(Number.isFinite(customReps) ? { customReps: true } : {}),
  };
}

export function buildSessionExercises(ids, profile, repCounts = {}) {
  return ids
    .map((id) => EXERCISES.find((e) => e.id === id))
    .filter(Boolean)
    .map((exercise) => applySessionDose(exercise, profile, { reps: repCounts?.[exercise.id] }));
}

export function appendSessionRecord(data = DEFAULT_DATA, rec) {
  return {
    ...data,
    sessions: [...(data.sessions ?? []), rec],
  };
}

// Expand a unique, ordered id list by per-id repeat counts, spacing repeats of the
// same exercise as far apart as possible so they aren't performed back-to-back. Greedy:
// at each slot place the id with the most remaining repeats that isn't the one just
// placed (ties keep the original order). Copies only end up adjacent when nothing else
// is left to interleave (e.g. a single exercise repeated on its own).
export function spreadRepeatedExercises(ids, counts = {}) {
  const remaining = ids.map((id) => ({ id, n: Math.max(1, Math.round(counts[id] ?? 1)) }));
  const total = remaining.reduce((sum, e) => sum + e.n, 0);
  const result = [];
  let last = null;
  for (let i = 0; i < total; i++) {
    let pick = null;
    for (const e of remaining) {
      if (e.n <= 0) continue;
      // Skip the just-placed id while any other exercise still has repeats left.
      if (e.id === last && remaining.some((o) => o !== e && o.n > 0)) continue;
      if (!pick || e.n > pick.n) pick = e;
    }
    if (!pick) pick = remaining.find((e) => e.n > 0);
    result.push(pick.id);
    pick.n -= 1;
    last = pick.id;
  }
  return result;
}

export function exerciseRestSec(exercise) {
  return exercise?.restSec ?? REST_SEC;
}

export function exerciseHoldSec(exercise) {
  return exercise?.holdSec ?? HOLD_SEC;
}

// Wall-clock seconds an exercise occupies: a hold per rep plus reps+1 rests — the
// entry-settle rest before the first hold, and a recovery rest after each hold
// (including the last, before the interstitial). Shared so the pre-session estimate
// and the in-session countdown agree.
export function exercisePlannedSec(exercise) {
  if (!exercise) return 0;
  const reps = Math.max(0, exercise.reps ?? 0);
  return reps * exerciseHoldSec(exercise) + (reps + 1) * exerciseRestSec(exercise);
}

export function minCompletedRepsBeforeRetake(totalReps) {
  const reps = Math.max(0, Math.round(totalReps ?? 0));
  return Math.max(1, Math.ceil(reps * 0.25));
}

export function canPromptRetakeAfterRep(repIdx, totalReps) {
  const completedReps = Math.max(0, Math.floor((repIdx ?? -1) + 1));
  return completedReps >= minCompletedRepsBeforeRetake(totalReps);
}

// Evenly-spaced session times today (e.g. dailyGoal=5 -> 9:00, 12:00, 15:00, 18:00, 21:00).
export function todaysSessionSlots(dailyGoal) {
  if (!dailyGoal || dailyGoal <= 0) return [];
  const minutes = (DAY_END_HOUR - DAY_START_HOUR) * 60;
  const step = dailyGoal === 1 ? 0 : minutes / (dailyGoal - 1);
  const slots = [];
  for (let i = 0; i < dailyGoal; i++) {
    const total = DAY_START_HOUR * 60 + step * i;
    const h = Math.floor(total / 60), m = Math.round(total % 60);
    const d = new Date(); d.setHours(h, m, 0, 0);
    slots.push(d);
  }
  return slots;
}

export function nextSessionAt(dailyGoal, completedToday) {
  if (completedToday >= dailyGoal) return null;
  const slots = todaysSessionSlots(dailyGoal);
  return slots[completedToday] ?? null;
}

export function formatClock(d) {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, "0")} ${ampm}`;
}

export const computeStreak = (sessions) => {
  const counted = sessions.filter(isCountedSession);
  if (!counted.length) return 0;
  const dates = [...new Set(counted.map(recordDateISO).filter(Boolean))].sort().reverse();
  let streak = 0; let cursor = todayISO();
  for (const d of dates) {
    if (d === cursor) { streak++; cursor = addDaysISO(cursor, -1); if (!cursor) break; }
    else if (daysBetween(d, cursor) > 0) break;
  }
  return streak;
};
