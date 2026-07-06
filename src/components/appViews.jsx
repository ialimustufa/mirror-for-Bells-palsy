import { useEffect, useMemo, useRef, useState } from "react";
import { Home, Sparkles, BookOpen, TrendingUp, Play, X, ChevronLeft, ChevronRight, Eye, Flame, Check, Heart, Info, ArrowRight, Loader2, Volume2, VolumeX, Zap, AlertCircle, Share2, Trash2, Save, RotateCcw, Plus, Minus, Download, Upload } from "lucide-react";
import { AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip } from "recharts";
import { DAY_END_HOUR, DAY_START_HOUR, INTERSTITIAL_SEC, MAX_EXERCISE_REPEATS, MAX_EXERCISE_REPS, MIN_EXERCISE_REPS, PROFILE_HOLD_SEC, PROFILE_REST_SEC } from "../domain/config";
import { STANDARD_ASSESSMENT_EXERCISE_IDS, STANDARD_ASSESSMENT_REPS, STANDARD_ASSESSMENT_REST_SEC, summarizeAssessmentSession } from "../domain/assessment";
import { clinicalScaleInputCompletenessSummaries, clinicalScaleInputGapSummaries, clinicalScaleMovementLabels, clinicalScaleRestingEvidenceSummary } from "../domain/clinicalScales";
import { clinicalScalePresentationPolicy, compactClinicalScaleValueLabel, scaleNounForClinicalScale } from "../domain/clinicalScalePresentation";
import { EXERCISES, MOOD_OPTIONS, PROFILE_ASSESSMENT_EXERCISES, PROFILE_STARTER_ASSESSMENT_EXERCISES, REGIONS } from "../domain/exercises";
import { personalRecoveryFocusItems } from "../domain/personalRecoveryModel";
import { summarizeJournalSafetyPrompts } from "../domain/safetyPrompts";
import { summarizeSessionDiagnostics } from "../domain/sessionDiagnostics";
import { addDaysISO, applySessionDose, buildSessionExercises, clampNumber, daysBetween, exerciseHoldSec, exercisePlannedSec, formatCalendarDate, formatClock, getComfortDosing, isCountedSession, nextSessionAt, recordDateISO, spreadRepeatedExercises, todayISO } from "../domain/session";
import { formatDuration, formatSessionDate, shareSessionReport } from "../reports/sessionReport";
import { displayPct, recoveryColor, scoreColor } from "../ui/scoreFormatting";
import { SCORING_NOISE_MODES, baselineProgressLabel, compareMovementProfiles, focusReason, formatProfileDate, formatProfileSide, getAdaptiveFocusItems, latestExerciseProgressById, latestSessionMovementProgress, movementBalanceLabel, movementProgressLabel, objectCoverTransform, orderExerciseIdsByRegion, preferredBaselineProgress, preferredMovementProgress, profileExerciseEntries, profileStatus, progressUsesLegacySideConvention, sessionFocusRecommendation, signedPointDelta } from "../ml/faceMetrics";
import { flushSpeech, primeSpeech, warmSpeechVoices } from "../lib/speech";

const NAV_ITEMS = [
  { key: "home", label: "Today", icon: Home },
  { key: "practice", label: "Practice", icon: Sparkles },
  { key: "baseline", label: "Baseline", icon: Zap },
  { key: "journal", label: "Journal", icon: BookOpen },
  { key: "progress", label: "Progress", icon: TrendingUp },
];

const EMPTY_COUNTS = Object.freeze({});

const SCORING_NOISE_MODE_LABELS = {
  normal: "Normal",
  soft: "Soft",
  raw: "Raw",
};

const SCORING_NOISE_MODE_DESCRIPTIONS = {
  normal: "Production calibrated noise handling.",
  soft: "Reduced penalties for low movement testing.",
  raw: "No noise subtraction; minimum gates only.",
};

const PAST_SESSIONS_PAGE_SIZE = 5;

function Header({ view, streak }) {
  const titles = { home: "Today", practice: "Practice", baseline: "Baseline", journal: "Journal", progress: "Progress" };
  return (
    <header className="flex items-center justify-between lg:hidden">
      <div className="flex items-center gap-2">
        <div className="w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "#1F1B16" }}>
          <div className="w-4 h-4 rounded-full" style={{ background: "#F4EFE6" }} />
        </div>
        <div>
          <div className="text-lg leading-none" style={{ fontFamily: "Fraunces", fontWeight: 600, letterSpacing: "-0.01em" }}>Mirror</div>
          <div className="text-xs text-stone-500 mt-0.5">{titles[view]}</div>
        </div>
      </div>
      {streak > 0 && <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full" style={{ background: "rgba(184, 84, 58, 0.1)", color: "#B8543A" }}><Flame className="w-4 h-4" /><span className="text-sm font-semibold">{streak}</span></div>}
    </header>
  );
}

function Sidebar({ view, setView, streak }) {
  return (
    <aside className="hidden lg:flex fixed top-0 left-0 bottom-0 w-20 z-20 flex-col items-center py-5 gap-2" style={{ background: "rgba(31, 27, 22, 0.94)", borderRight: "1px solid rgba(244,239,230,0.06)" }}>
      <div className="w-10 h-10 rounded-full flex items-center justify-center mb-2" style={{ background: "#F4EFE6" }} title="Mirror">
        <div className="w-4 h-4 rounded-full" style={{ background: "#1F1B16" }} />
      </div>
      <div className="flex flex-col items-center gap-1 flex-1 mt-2">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.key;
          return (
            <button key={item.key} onClick={() => setView(item.key)} className="w-14 h-14 rounded-2xl flex flex-col items-center justify-center gap-0.5 transition-colors" style={{ background: active ? "#F4EFE6" : "transparent", color: active ? "#1F1B16" : "rgba(244,239,230,0.65)" }}>
              <Icon className="w-4 h-4" strokeWidth={2.2} />
              <span className="text-[9px] font-semibold">{item.label}</span>
            </button>
          );
        })}
      </div>
      {streak > 0 && (
        <div className="flex flex-col items-center gap-0.5 px-2 py-2 rounded-2xl" style={{ background: "rgba(184, 84, 58, 0.18)", color: "#FFB48F" }} title={`${streak} day streak`}>
          <Flame className="w-4 h-4" />
          <span className="text-xs font-semibold tabular-nums">{streak}</span>
        </div>
      )}
    </aside>
  );
}

function sameExerciseIds(a = [], b = []) {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

function sameExerciseSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const bSet = new Set(b);
  return a.every((id) => bSet.has(id));
}

function progressSummaryLabel(progress) {
  if (!progress) return null;
  return progress.affectedProgressRatio != null ? movementProgressLabel(progress) : baselineProgressLabel(progress);
}

function formatShortRecordDate(record) {
  return formatCalendarDate(recordDateISO(record), { month: "short", day: "numeric" });
}

function progressSideLabel(progress) {
  return progress?.affectedProgressRatio != null ? "affected" : progress?.side;
}

function clinicalScaleEstimateCards(scales, presentation, inputNotesByScale = {}) {
  if (!scales) return [];
  return [
    scales.houseBrackmann ? {
      key: "houseBrackmann",
      label: "House-Brackmann-inspired",
      value: `Grade ${scales.houseBrackmann.grade}`,
      sublabel: scales.houseBrackmann.label,
      statusLabel: scaleNounForClinicalScale(presentation, "houseBrackmann"),
    } : null,
    scales.sunnybrook ? {
      key: "sunnybrook",
      label: "Sunnybrook-style",
      value: `${Math.round(scales.sunnybrook.compositeScore)}/100`,
      sublabel: `${scales.sunnybrook.voluntaryMovementScore} vol - ${scales.sunnybrook.restingSymmetryScore} rest - ${scales.sunnybrook.synkinesisScore} synk${inputNotesByScale.sunnybrook ? ` · ${inputNotesByScale.sunnybrook}` : ""}`,
      statusLabel: scaleNounForClinicalScale(presentation, "sunnybrook"),
    } : null,
    scales.eface ? {
      key: "eface",
      label: "eFACE-style",
      value: `${Math.round(scales.eface.totalScore)}/100`,
      sublabel: `${Math.round(scales.eface.staticScore)} static · ${Math.round(scales.eface.dynamicScore)} dynamic · ${Math.round(scales.eface.synkinesisScore)} synk${inputNotesByScale.eface ? ` · ${inputNotesByScale.eface}` : ""}`,
      statusLabel: scaleNounForClinicalScale(presentation, "eface"),
    } : null,
  ].filter(Boolean);
}

function omittedClinicalScaleMovementLabels(clinicalScales) {
  const ids = clinicalScales?.evidence?.omittedMovementExerciseIds ?? clinicalScales?.coverage?.unusableExerciseIds ?? [];
  return clinicalScaleMovementLabels(ids);
}

function sourceSessionForAssessment(assessment, sessions = []) {
  if (!assessment) return null;
  return sessions.find((session) => (
    (assessment.sourceSessionId && session.id === assessment.sourceSessionId)
    || (assessment.sourceSessionTs && session.ts === assessment.sourceSessionTs)
  )) ?? null;
}

function assessmentWithClinicalScaleFallback(assessment, sourceSession) {
  if (!assessment || assessment.clinicalScales) return assessment ?? null;
  if (!sourceSession) return assessment;
  const sourceSummary = summarizeAssessmentSession(sourceSession);
  return {
    ...assessment,
    clinicalScales: sourceSummary.clinicalScales ?? null,
  };
}

function clampJournalRating(value) {
  return Math.max(1, Math.min(10, Math.round(value)));
}

function autoJournalRatingFromSession(session) {
  if (Number.isFinite(session?.sessionAvg)) {
    return {
      value: clampJournalRating(session.sessionAvg * 10),
      reason: `${displayPct(session.sessionAvg)}% average symmetry`,
    };
  }
  const progress = preferredMovementProgress(session) ?? preferredBaselineProgress(session);
  const ratio = progress?.affectedProgressRatio ?? progress?.ratio;
  if (Number.isFinite(ratio)) {
    const cappedRatio = Math.min(1.25, Math.max(0, ratio));
    return {
      value: clampJournalRating((cappedRatio / 1.25) * 10),
      reason: `${Math.round(ratio * 100)}% movement from baseline`,
    };
  }
  return { value: 5, reason: "today's completed session" };
}

function moodFromRating(rating) {
  if (rating >= 8) return "hopeful";
  if (rating >= 6) return "okay";
  if (rating >= 4) return "tired";
  return "frustrated";
}

// Modal alert with explicit Cancel/Confirm. Closes on Escape or backdrop click.
// Auto-focuses Cancel so a stray Enter keeps the plan instead of wiping it.
function ConfirmAlert({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", danger = true, onConfirm, onCancel }) {
  const cancelRef = useRef(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e) => { if (e.key === "Escape") onCancel?.(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="confirm-alert-title" className="fixed inset-0 z-[80] flex items-center justify-center p-5" style={{ background: "rgba(12,10,8,0.65)" }} onClick={onCancel}>
      <div onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl p-6" style={{ background: "#F4EFE6", color: "#1F1B16", boxShadow: "0 24px 60px rgba(0,0,0,0.35)" }}>
        <div className="flex items-start gap-3 mb-5">
          <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: danger ? "rgba(184,84,58,0.16)" : "rgba(31,27,22,0.08)", color: danger ? "#B8543A" : "#1F1B16" }}>
            <AlertCircle className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            <div id="confirm-alert-title" className="text-lg leading-tight" style={{ fontFamily: "Fraunces", fontWeight: 600, letterSpacing: "-0.01em" }}>{title}</div>
            {message && <div className="text-sm text-stone-600 mt-2 leading-relaxed">{message}</div>}
          </div>
        </div>
        <div className="flex gap-2 justify-end">
          <button ref={cancelRef} onClick={onCancel} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "rgba(31,27,22,0.08)", color: "#1F1B16" }}>{cancelLabel}</button>
          <button onClick={onConfirm} className="rounded-full px-4 py-2 text-sm font-semibold" style={{ background: danger ? "#B8543A" : "#1F1B16", color: "#F4EFE6" }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function ConfirmResetButton({ onConfirm, label, confirmTitle = "Reset to recommended plan?", confirmMessage = "This replaces your saved exercise selection with the algorithm's current recommendation. Your custom picks will be lost — you can rebuild them in the Practice library.", confirmActionLabel = "Reset plan", cancelLabel = "Keep my plan", baseStyle, showIcon = true, className = "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} className={className} style={baseStyle} aria-label={label}>
        {showIcon && <RotateCcw className="w-3.5 h-3.5" />}
        {label}
      </button>
      {open && (
        <ConfirmAlert
          title={confirmTitle}
          message={confirmMessage}
          confirmLabel={confirmActionLabel}
          cancelLabel={cancelLabel}
          onConfirm={() => { setOpen(false); onConfirm?.(); }}
          onCancel={() => setOpen(false)}
        />
      )}
    </>
  );
}

function BaselineManagerPanel({ profile, onRedo, onReset }) {
  const [selectedIds, setSelectedIds] = useState([]);
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const items = PROFILE_ASSESSMENT_EXERCISES
    .map((exerciseId) => ({
      exerciseId,
      exercise: EXERCISES.find((item) => item.id === exerciseId),
      profileExercise: profile?.exercises?.[exerciseId] ?? null,
    }))
    .filter((item) => item.exercise);
  const selectedExistingIds = selectedIds.filter((id) => profile?.exercises?.[id]);
  const selectedMissingIds = selectedIds.filter((id) => !profile?.exercises?.[id]);
  const redoLabel = selectedIds.length > 0 && selectedMissingIds.length === selectedIds.length
    ? "Capture selected"
    : selectedMissingIds.length > 0
      ? "Redo/add selected"
      : "Redo selected";
  const toggleSelected = (exerciseId) => {
    setSelectedIds((current) => current.includes(exerciseId)
      ? current.filter((id) => id !== exerciseId)
      : [...current, exerciseId]);
  };
  const resetSelected = () => {
    onReset?.(selectedExistingIds);
    setSelectedIds((current) => current.filter((id) => !selectedExistingIds.includes(id)));
    setConfirmResetOpen(false);
  };

  return (
    <div className="mt-4 rounded-2xl p-3" style={{ background: "rgba(244,239,230,0.06)", border: "1px solid rgba(244,239,230,0.1)" }}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider opacity-55">Baseline manager</div>
          <div className="text-[11px] opacity-55 mt-0.5">{selectedIds.length ? `${selectedIds.length} selected` : `${items.filter((item) => item.profileExercise).length}/${items.length} captured`}</div>
        </div>
        <div className="flex gap-1.5">
          <button onClick={() => setSelectedIds(items.filter((item) => item.profileExercise).map((item) => item.exerciseId))} className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: "rgba(244,239,230,0.1)", color: "#F4EFE6" }}>Captured</button>
          <button onClick={() => setSelectedIds([])} className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: "rgba(244,239,230,0.06)", color: "#F4EFE6", border: "1px solid rgba(244,239,230,0.12)" }}>Clear</button>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
        {items.map(({ exerciseId, exercise, profileExercise }) => {
          const selected = selectedIds.includes(exerciseId);
          const quality = profileExercise?.quality;
          const pct = displayPct(profileExercise?.initialSymmetry);
          return (
            <button key={exerciseId} onClick={() => toggleSelected(exerciseId)} aria-pressed={selected} className="text-left rounded-xl px-3 py-2.5 flex items-center gap-2" style={{ background: selected ? "rgba(184,84,58,0.24)" : "rgba(244,239,230,0.06)", border: selected ? "1px solid rgba(255,180,143,0.45)" : "1px solid rgba(244,239,230,0.08)", color: "#F4EFE6" }}>
              <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0" style={{ background: selected ? "#B8543A" : "rgba(244,239,230,0.08)", border: selected ? "none" : "1px solid rgba(244,239,230,0.16)" }}>
                {selected && <Check className="w-3 h-3" />}
              </div>
              <ExerciseGlyph exercise={exercise} size="xs" tone="dark" />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-semibold truncate">{exercise.name}</div>
                <div className="text-[10px] opacity-60 truncate">
                  {profileExercise
                    ? `${pct == null ? "Baseline saved" : `${pct}% baseline`}${quality?.label ? ` · ${quality.label}` : ""}`
                    : "Needs baseline"}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2 mt-3">
        <button disabled={!selectedIds.length} onClick={() => onRedo?.(selectedIds)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-40" style={{ background: "#B8543A", color: "#F4EFE6" }}>
          <RotateCcw className="w-3.5 h-3.5" />{redoLabel}
        </button>
        <button disabled={!selectedExistingIds.length} onClick={() => setConfirmResetOpen(true)} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-40" style={{ background: "rgba(244,239,230,0.08)", color: "#FFD3C1", border: "1px solid rgba(184,84,58,0.3)" }}>
          <Trash2 className="w-3.5 h-3.5" />Reset selected
        </button>
      </div>
      {confirmResetOpen && (
        <ConfirmAlert
          title={`Reset ${selectedExistingIds.length} baseline${selectedExistingIds.length === 1 ? "" : "s"}?`}
          message="The selected movement baselines will be cleared from the current and first-baseline profiles. Mirror will treat them as missing until you capture them again."
          confirmLabel="Reset baselines"
          cancelLabel="Keep baselines"
          onConfirm={resetSelected}
          onCancel={() => setConfirmResetOpen(false)}
        />
      )}
    </div>
  );
}

function HomeView({ data, streak, personalizedPlanIds, recommendedPlanIds, onStartProfile, onStartSession, onStartAssessment, onGo, onResetPersonalPlan }) {
  // Home is a derived dashboard: it summarizes today's stored records and maps the
  // configured daily goal into the next practice prompt.
  const today = todayISO();
  const todaysSessions = data.sessions.filter((s) => recordDateISO(s) === today);
  const todaysCountedSessions = todaysSessions.filter(isCountedSession);
  const todaysJournal = data.journal.find((j) => recordDateISO(j) === today);
  const dailyGoal = data.prefs.dailyGoal ?? 3;
  const todaysPlan = useMemo(() => personalizedPlanIds?.length ? personalizedPlanIds : (recommendedPlanIds ?? []), [personalizedPlanIds, recommendedPlanIds]);
  const planRepeatCounts = data.prefs.personalPlan?.repeatCounts ?? EMPTY_COUNTS;
  const planRepCounts = data.prefs.personalPlan?.repCounts ?? EMPTY_COUNTS;
  const hasCustomPlan = !sameExerciseIds(todaysPlan, recommendedPlanIds ?? [])
    || Object.keys(planRepeatCounts).length > 0
    || Object.keys(planRepCounts).length > 0;
  const focusItems = getAdaptiveFocusItems(data.movementProfile, data.sessions, 3);
  const planExercises = todaysPlan.map((id) => EXERCISES.find((e) => e.id === id)).filter(Boolean);
  const planStartIds = useMemo(() => spreadRepeatedExercises(todaysPlan, planRepeatCounts), [todaysPlan, planRepeatCounts]);
  const planMissingBaselineIds = data.movementProfile
    ? todaysPlan.filter((id) => !data.movementProfile.exercises?.[id])
    : [];
  const planSessionExercises = useMemo(() => buildSessionExercises(planStartIds, data.movementProfile, planRepCounts), [planStartIds, data.movementProfile, planRepCounts]);
  const planDurationSec = useMemo(
    () => planSessionExercises.reduce((sum, ex) => sum + exercisePlannedSec(ex), 0)
      + Math.max(0, planSessionExercises.length - 1) * INTERSTITIAL_SEC,
    [planSessionExercises]
  );
  const planTargetRepCount = planSessionExercises.reduce((sum, ex) => sum + (ex.reps ?? 0), 0);
  const assessmentExercises = STANDARD_ASSESSMENT_EXERCISE_IDS.map((id) => EXERCISES.find((exercise) => exercise.id === id)).filter(Boolean);
  const assessmentDurationSec = assessmentExercises.reduce((sum, exercise) => sum + STANDARD_ASSESSMENT_REPS * exercise.holdSec + (STANDARD_ASSESSMENT_REPS + 1) * STANDARD_ASSESSMENT_REST_SEC, 0)
    + Math.max(0, assessmentExercises.length - 1) * INTERSTITIAL_SEC;
  const latestAssessmentRaw = [...(data.assessments ?? [])].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))[0] ?? null;
  const latestAssessment = assessmentWithClinicalScaleFallback(latestAssessmentRaw, sourceSessionForAssessment(latestAssessmentRaw, data.sessions));
  const latestAssessmentDate = latestAssessment?.date ? formatSessionDate(latestAssessment) : null;
  const showClinicalScaleEstimates = data.prefs?.clinicalScaleEstimatesEnabled !== false;
  const latestClinicalScales = showClinicalScaleEstimates && latestAssessment?.clinicalScales?.status === "estimated" ? latestAssessment.clinicalScales.scales : null;
  const clinicalScalePolicy = clinicalScalePresentationPolicy();
  const latestClinicalLabel = compactClinicalScaleValueLabel(latestClinicalScales, clinicalScalePolicy);
  const latestMovement = latestSessionMovementProgress(data.sessions);
  const baselineStatus = profileStatus(data.movementProfile);
  const weakBaselineIds = baselineStatus?.retakeExercises?.map((ex) => ex.exerciseId) ?? [];
  const missingBaselineIds = data.movementProfile
    ? PROFILE_ASSESSMENT_EXERCISES.filter((id) => !data.movementProfile.exercises?.[id])
    : [];
  const completed = todaysCountedSessions.length;
  const remaining = Math.max(0, dailyGoal - completed);
  const nextSlot = nextSessionAt(dailyGoal, completed);
  const todaysAvgSymmetry = (() => {
    const valid = todaysSessions.map((s) => s.sessionAvg).filter((v) => v != null);
    return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  })();
  const nextLabel = nextSlot
    ? (nextSlot.getTime() <= new Date().getTime() ? "Now" : formatClock(nextSlot))
    : null;
  const greeting = (() => { const h = new Date().getHours(); if (h < 12) return "Good morning"; if (h < 18) return "Good afternoon"; return "Good evening"; })();

  return (
    <div className="space-y-6">
      <div>
        <div className="text-sm text-stone-500">{greeting}</div>
        <h1 className="text-4xl mt-1 leading-tight" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>
          {streak > 0 ? <><em style={{ fontStyle: "italic", fontWeight: 400 }}>Day {streak}</em> of your practice.</> : "Ready when you are."}
        </h1>
      </div>
      <div className="rounded-3xl p-6 relative overflow-hidden" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
        <div className="absolute -bottom-12 -right-12 w-48 h-48 rounded-full opacity-15" style={{ background: "#D4A574" }} />
        <div className="relative">
          <div className="text-xs uppercase tracking-wider opacity-60 mb-3">Today's progress</div>
          <div className="flex items-center gap-1.5 mb-4">
            {Array.from({ length: dailyGoal }).map((_, i) => {
              const done = i < completed;
              return (
                <div key={i} className="w-7 h-7 rounded-full flex items-center justify-center transition-all"
                  style={{ background: done ? "#B8543A" : "rgba(244,239,230,0.08)", border: done ? "none" : "1px solid rgba(244,239,230,0.2)" }}>
                  {done && <Check className="w-3.5 h-3.5" style={{ color: "#F4EFE6" }} />}
                </div>
              );
            })}
            <div className="ml-2 text-sm opacity-80 tabular-nums">{completed} of {dailyGoal}</div>
          </div>
          <div className="text-2xl mb-1" style={{ fontFamily: "Fraunces", fontWeight: 500 }}>
            {remaining > 0 ? `Session ${completed + 1} of ${dailyGoal}` : "Done for today"}
          </div>
          <div className="text-sm opacity-70 mb-5">
            {remaining > 0
              ? (nextLabel === "Now" ? "Time for your next session" : `Next at ${nextLabel}`)
              : "Beautifully done. Rest and return tomorrow."}
          </div>
          <button onClick={() => onStartSession(planStartIds, planRepCounts)} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-full text-sm font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>
            <Play className="w-4 h-4 fill-current" />{remaining > 0 ? "Start session" : "Practice again"}
          </button>
        </div>
      </div>
      {data.movementProfile && (
        <div className="rounded-2xl p-4" style={{ background: "rgba(31, 27, 22, 0.92)", color: "#F4EFE6" }}>
          <div className="flex items-center justify-between gap-3 mb-3">
            <div>
              <div className="text-sm font-semibold">Personalized plan</div>
              <div className="text-xs opacity-60">Ordered forehead to mouth from your saved selection</div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              {baselineStatus && <div className="text-xs rounded-full px-2.5 py-1" style={{ background: `${baselineStatus.quality.color}26`, color: baselineStatus.quality.color }}>{baselineStatus.quality.label}</div>}
              <div className="text-xs rounded-full px-2.5 py-1 tabular-nums" style={{ background: "rgba(244,239,230,0.08)" }} title="Estimated session length">{planSessionExercises.length} moves · {planTargetRepCount} reps · ~{formatDuration(planDurationSec)}</div>
            </div>
          </div>
          {(() => {
            const PLAN_PREVIEW_CAP = 8;
            const overflow = planExercises.length - PLAN_PREVIEW_CAP;
            const visible = overflow > 0 ? planExercises.slice(0, PLAN_PREVIEW_CAP - 1) : planExercises;
            return (
              <div className="grid grid-cols-4 gap-1.5">
	                {visible.map((ex) => {
	                  const needsBaseline = planMissingBaselineIds.includes(ex.id);
	                  const reps = planRepCounts[ex.id];
	                  return (
	                    <div key={ex.id} title={needsBaseline ? `${ex.name} · needs baseline` : ex.name} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 min-w-0" style={{ background: "rgba(244,239,230,0.08)", border: needsBaseline ? "1px solid rgba(212,165,116,0.45)" : "1px solid rgba(244,239,230,0.08)" }}>
	                      <ExerciseGlyph exercise={ex} size="xs" tone="dark" />
	                      <div className="text-[11px] font-semibold truncate min-w-0">{ex.name}{reps ? ` · ${reps} reps` : ""}</div>
	                    </div>
	                  );
	                })}
                {overflow > 0 && (
                  <button onClick={() => onGo("practice")} title={`${overflow + 1} more in your plan`} className="inline-flex items-center justify-center rounded-lg px-2 py-1.5 text-[11px] font-semibold" style={{ background: "rgba(244,239,230,0.06)", border: "1px dashed rgba(244,239,230,0.22)", color: "#F4EFE6" }}>
                    +{overflow + 1} more
                  </button>
                )}
              </div>
            );
          })()}
          <div className="flex flex-wrap gap-2 mt-3">
            <button onClick={() => onGo("practice")} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>Edit plan<ArrowRight className="w-3.5 h-3.5" /></button>
            <button onClick={() => onGo("baseline")} className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "rgba(244,239,230,0.1)", color: "#F4EFE6", border: "1px solid rgba(244,239,230,0.16)" }}>
              <RotateCcw className="w-3.5 h-3.5" />Baselines
            </button>
            {hasCustomPlan && (
              <ConfirmResetButton onConfirm={onResetPersonalPlan} label="Reset to recommended" baseStyle={{ background: "rgba(244,239,230,0.1)", color: "#F4EFE6", border: "1px solid rgba(244,239,230,0.16)" }} />
            )}
          </div>
          <div className="grid grid-cols-1 gap-2 mt-4">
            {focusItems.map((item) => (
              <div key={item.id} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: "rgba(244,239,230,0.06)" }}>
                <ExerciseGlyph exercise={item.exercise} size="xs" tone="dark" />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate">{item.exercise?.name}</div>
                  <div className="text-[11px] opacity-55">{focusReason(item)} · limited side {item.profileExercise.limitedSide}</div>
                </div>
              </div>
            ))}
          </div>
          {latestMovement && (
            <div className="mt-3 text-xs rounded-xl px-3 py-2" style={{ background: "rgba(122,143,115,0.18)", color: "#D9E5D2" }}>
              Latest recovery progress: {progressSideLabel(latestMovement)} side · {progressSummaryLabel(latestMovement)}
            </div>
          )}
          {missingBaselineIds.length > 0 && (
            <div className="mt-3 flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: "rgba(212,165,116,0.14)", color: "#F6D8B2" }}>
              <div className="flex-1 text-xs">{missingBaselineIds.length} movement baseline{missingBaselineIds.length === 1 ? "" : "s"} left to add.</div>
              <button onClick={() => onStartProfile(missingBaselineIds)} className="rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap" style={{ background: "#D4A574", color: "#1F1B16" }}>Add remaining</button>
            </div>
          )}
          {baselineStatus?.shouldRetake && (
            <div className="mt-3 flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: "rgba(184,84,58,0.16)", color: "#FFD3C1" }}>
              <div className="flex-1 text-xs">Retake baseline: {baselineStatus.reason}</div>
              <button onClick={() => onStartProfile(weakBaselineIds.length ? weakBaselineIds : null)} className="rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap" style={{ background: "#B8543A", color: "#F4EFE6" }}>{weakBaselineIds.length ? "Retake weak" : "Retake"}</button>
            </div>
          )}
        </div>
      )}
      <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.56)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
        <div className="flex items-start justify-between gap-3 mb-3">
          <div>
            <div className="text-sm font-semibold">Standard assessment</div>
            <div className="text-xs text-stone-500 mt-0.5">{assessmentExercises.length} movements · {STANDARD_ASSESSMENT_REPS} reps each · ~{formatDuration(assessmentDurationSec)}</div>
          </div>
          {latestAssessment && (
            <div className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider shrink-0" style={{ background: "rgba(122,143,115,0.16)", color: "#4A6B47" }}>
              {latestClinicalLabel ?? (latestAssessment.averageVoluntaryMovement != null ? `${Math.round(latestAssessment.averageVoluntaryMovement * 100)}%` : "saved")}
            </div>
          )}
        </div>
        <div className="grid grid-cols-5 gap-1.5 mb-3">
          {assessmentExercises.map((exercise) => (
            <div key={exercise.id} title={exercise.name} className="rounded-xl py-2 flex items-center justify-center" style={{ background: "rgba(31,27,22,0.04)" }}>
              <ExerciseGlyph exercise={exercise} size="xs" />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onStartAssessment} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
            <Play className="w-3.5 h-3.5 fill-current" />Start assessment
          </button>
          {latestAssessmentDate && <div className="text-xs text-stone-500">Last: {latestAssessmentDate}</div>}
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Streak" value={streak} unit={streak === 1 ? "day" : "days"} />
        <StatCard label="Today's symmetry" value={todaysAvgSymmetry != null ? `${displayPct(todaysAvgSymmetry)}` : "—"} unit={todaysAvgSymmetry != null ? "%" : "no data"} />
        <StatCard label="Self-rated" value={todaysJournal ? `${todaysJournal.symmetry}` : "—"} unit={todaysJournal ? "/ 10" : "log"} />
      </div>
      <div className="rounded-2xl p-5" style={{ background: "rgba(122, 143, 115, 0.12)", border: "1px solid rgba(122, 143, 115, 0.2)" }}>
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: "#7A8F73", color: "#F4EFE6" }}><Heart className="w-4 h-4" /></div>
          <div>
            <div className="text-sm mb-1" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>Gentle reminder</div>
            <p className="text-sm text-stone-700 leading-relaxed">Quality over force. Slow, controlled movement in front of the mirror is what teaches your nerves to fire symmetrically — not repetitions or strain.</p>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <SecondaryButton onClick={() => onGo("practice")}>Browse exercises<ArrowRight className="w-4 h-4" /></SecondaryButton>
        <SecondaryButton onClick={() => onGo("journal")}>{todaysJournal ? "Update journal" : "Log today"}<ArrowRight className="w-4 h-4" /></SecondaryButton>
      </div>
    </div>
  );
}

function StatCard({ label, value, unit }) {
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
      <div className="text-xs text-stone-500 mb-1">{label}</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-3xl" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>{value}</span>
        <span className="text-xs text-stone-500">{unit}</span>
      </div>
    </div>
  );
}

function SecondaryButton({ children, onClick }) {
  return <button onClick={onClick} className="rounded-2xl p-4 text-left text-sm font-medium flex items-center justify-between transition hover:bg-white" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>{children}</button>;
}

function drawArrow(ctx, x, y, kind, label, dpr, color, pulse = 1, side) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5 * dpr;
  ctx.font = `600 ${11 * dpr}px system-ui, -apple-system, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  if (kind === "ring" || kind === "ringDashed") {
    if (kind === "ringDashed") ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.arc(x, y, (18 + 4 * pulse) * dpr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    if (label) ctx.fillText(label, x, y - 28 * dpr);
  } else if (kind === "up" || kind === "down") {
    const sign = kind === "up" ? -1 : 1;
    const tailY = y + sign * 22 * dpr;
    const headY = y + sign * (38 + 6 * pulse) * dpr;
    ctx.beginPath();
    ctx.moveTo(x, tailY);
    ctx.lineTo(x, headY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 6 * dpr, headY - sign * 9 * dpr);
    ctx.lineTo(x, headY);
    ctx.lineTo(x + 6 * dpr, headY - sign * 9 * dpr);
    ctx.stroke();
    if (label) {
      const labelY = kind === "up" ? headY - 6 * dpr : headY + 14 * dpr;
      ctx.fillText(label, x, labelY);
    }
  } else if (kind === "out" || kind === "in") {
    const sign = kind === "out"
      ? (side === "left" ? -1 : 1)
      : (side === "left" ? 1 : -1);
    const tailX = x + sign * 18 * dpr;
    const headX = x + sign * (38 + 6 * pulse) * dpr;
    ctx.beginPath();
    ctx.moveTo(tailX, y);
    ctx.lineTo(headX, y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(headX - sign * 9 * dpr, y - 6 * dpr);
    ctx.lineTo(headX, y);
    ctx.lineTo(headX - sign * 9 * dpr, y + 6 * dpr);
    ctx.stroke();
    if (label) {
      ctx.textAlign = sign < 0 ? "right" : "left";
      ctx.fillText(label, headX + sign * 4 * dpr, y - 8 * dpr);
    }
  }
  ctx.restore();
}

function drawArrowMarkers(canvas, video, lm, mirrorEnabled, exerciseId) {
  if (!canvas || !video) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(rect.width * dpr), h = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, w, h);
  if (!lm || lm.length < 478) return;
  const t = objectCoverTransform(canvas, video);
  if (!t) return;

  const px = (p) => mirrorEnabled ? t.cw - (p.x * t.dw + t.ox) : (p.x * t.dw + t.ox);
  const py = (p) => p.y * t.dh + t.oy;
  const avg = (...idxs) => {
    let sx = 0, sy = 0;
    for (const i of idxs) { sx += px(lm[i]); sy += py(lm[i]); }
    return { x: sx / idxs.length, y: sy / idxs.length };
  };
  const pair = (a, b) => (a.x < b.x ? [a, b] : [b, a]);

  // Anchors are screen-space and ordered by screen position so "*L" is always
  // on the screen-left regardless of whether the video is mirrored.
  const [eyeL, eyeR] = pair(avg(33, 133), avg(263, 362));
  const [browL, browR] = pair(avg(70, 63, 105, 66, 107), avg(336, 296, 334, 293, 300));
  const [cheekL, cheekR] = pair({ x: px(lm[50]), y: py(lm[50]) }, { x: px(lm[280]), y: py(lm[280]) });
  const [nostrilL, nostrilR] = pair({ x: px(lm[64]), y: py(lm[64]) }, { x: px(lm[294]), y: py(lm[294]) });
  const [mouthL, mouthR] = pair({ x: px(lm[61]), y: py(lm[61]) }, { x: px(lm[291]), y: py(lm[291]) });
  const mouthC = avg(13, 14);

  const now = Date.now();
  const pulse = 0.5 + 0.5 * Math.sin(now / 240);
  const alt = Math.floor(now / 2400) % 2 === 0;

  const PRIMARY = `rgba(184, 84, 58, ${0.78 + 0.22 * pulse})`;
  const SECONDARY = "rgba(122, 143, 115, 0.85)";

  switch (exerciseId) {
    case "eyebrow-raise":
      drawArrow(ctx, browL.x, browL.y, "up", "Lift", dpr, PRIMARY, pulse);
      drawArrow(ctx, browR.x, browR.y, "up", "Lift", dpr, PRIMARY, pulse);
      break;
    case "gentle-frown":
      drawArrow(ctx, browL.x, browL.y, "down", "Pull", dpr, PRIMARY, pulse);
      drawArrow(ctx, browR.x, browR.y, "down", "Pull", dpr, PRIMARY, pulse);
      break;
    case "emoji-raised-brow": {
      const active = alt ? browL : browR;
      const quiet = alt ? browR : browL;
      drawArrow(ctx, active.x, active.y, "up", "Raise", dpr, PRIMARY, pulse);
      drawArrow(ctx, quiet.x, quiet.y, "ringDashed", "Relax", dpr, SECONDARY, 1);
      break;
    }
    case "blink":
      drawArrow(ctx, eyeL.x, eyeL.y, "ring", "Blink softly", dpr, PRIMARY, pulse);
      drawArrow(ctx, eyeR.x, eyeR.y, "ring", null, dpr, PRIMARY, pulse);
      break;
    case "eye-close":
      drawArrow(ctx, eyeL.x, eyeL.y, "ring", "Close softly", dpr, PRIMARY, pulse);
      drawArrow(ctx, eyeR.x, eyeR.y, "ring", null, dpr, PRIMARY, pulse);
      break;
    case "wink":
    case "emoji-wink": {
      const closed = alt ? eyeL : eyeR;
      const open = alt ? eyeR : eyeL;
      drawArrow(ctx, closed.x, closed.y, "ring", "Close", dpr, PRIMARY, pulse);
      drawArrow(ctx, open.x, open.y, "ringDashed", "Keep open", dpr, SECONDARY, 1);
      break;
    }
    case "nose-wrinkle":
      drawArrow(ctx, nostrilL.x, nostrilL.y, "out", "Flare", dpr, PRIMARY, pulse, "left");
      drawArrow(ctx, nostrilR.x, nostrilR.y, "out", null, dpr, PRIMARY, pulse, "right");
      break;
    case "emoji-nose-scrunch":
      drawArrow(ctx, nostrilL.x, nostrilL.y, "up", "Scrunch", dpr, PRIMARY, pulse);
      drawArrow(ctx, nostrilR.x, nostrilR.y, "up", null, dpr, PRIMARY, pulse);
      break;
    case "cheek-puff":
      drawArrow(ctx, cheekL.x, cheekL.y, "out", "Puff", dpr, PRIMARY, pulse, "left");
      drawArrow(ctx, cheekR.x, cheekR.y, "out", null, dpr, PRIMARY, pulse, "right");
      break;
    case "water-swish":
      drawArrow(ctx, cheekL.x, cheekL.y, alt ? "out" : "in", "Move water", dpr, PRIMARY, pulse, "left");
      drawArrow(ctx, cheekR.x, cheekR.y, alt ? "in" : "out", null, dpr, PRIMARY, pulse, "right");
      break;
    case "water-hold-left":
      drawArrow(ctx, cheekL.x, cheekL.y, "out", "Hold left", dpr, PRIMARY, pulse, "left");
      drawArrow(ctx, cheekR.x, cheekR.y, "ringDashed", "Quiet", dpr, SECONDARY, 1);
      break;
    case "water-hold-right":
      drawArrow(ctx, cheekR.x, cheekR.y, "out", "Hold right", dpr, PRIMARY, pulse, "right");
      drawArrow(ctx, cheekL.x, cheekL.y, "ringDashed", "Quiet", dpr, SECONDARY, 1);
      break;
    case "cheek-suck":
      drawArrow(ctx, cheekL.x, cheekL.y, "in", "Pull in", dpr, PRIMARY, pulse, "left");
      drawArrow(ctx, cheekR.x, cheekR.y, "in", null, dpr, PRIMARY, pulse, "right");
      break;
    case "closed-smile":
    case "emoji-smile":
      drawArrow(ctx, mouthL.x, mouthL.y, "up", "Lift", dpr, PRIMARY, pulse);
      drawArrow(ctx, mouthR.x, mouthR.y, "up", "Lift", dpr, PRIMARY, pulse);
      break;
    case "open-smile":
    case "emoji-big-smile":
      drawArrow(ctx, mouthL.x, mouthL.y, "up", "Smile wide", dpr, PRIMARY, pulse);
      drawArrow(ctx, mouthR.x, mouthR.y, "up", null, dpr, PRIMARY, pulse);
      break;
    case "emoji-sad-frown":
      drawArrow(ctx, mouthL.x, mouthL.y, "down", "Lower", dpr, PRIMARY, pulse);
      drawArrow(ctx, mouthR.x, mouthR.y, "down", null, dpr, PRIMARY, pulse);
      break;
    case "emoji-smirk": {
      const active = alt ? mouthL : mouthR;
      const quiet = alt ? mouthR : mouthL;
      drawArrow(ctx, active.x, active.y, "up", "Lift one side", dpr, PRIMARY, pulse);
      drawArrow(ctx, quiet.x, quiet.y, "ringDashed", "Soft", dpr, SECONDARY, 1);
      break;
    }
    case "pucker":
    case "emoji-pucker":
    case "emoji-kiss":
      drawArrow(ctx, mouthC.x, mouthC.y, "ring", "Pucker forward", dpr, PRIMARY, pulse);
      break;
    case "lip-press":
      drawArrow(ctx, mouthC.x, mouthC.y, "ringDashed", "Press lips", dpr, PRIMARY, pulse);
      break;
    case "vowel-a":
      drawArrow(ctx, mouthC.x, mouthC.y, "ring", "Open: ah", dpr, PRIMARY, pulse);
      break;
    case "vowel-e":
      drawArrow(ctx, mouthL.x, mouthL.y, "out", "Wide: ee", dpr, PRIMARY, pulse, "left");
      drawArrow(ctx, mouthR.x, mouthR.y, "out", null, dpr, PRIMARY, pulse, "right");
      break;
    case "vowel-i":
      drawArrow(ctx, mouthC.x, mouthC.y, "ring", "Soft: ih", dpr, PRIMARY, pulse);
      break;
    case "vowel-o":
      drawArrow(ctx, mouthC.x, mouthC.y, "ring", "Round: oh", dpr, PRIMARY, pulse);
      break;
    case "vowel-u":
      drawArrow(ctx, mouthC.x, mouthC.y, "ring", "Forward: oo", dpr, PRIMARY, pulse);
      break;
    case "emoji-surprise":
      drawArrow(ctx, browL.x, browL.y, "up", "Lift", dpr, PRIMARY, pulse);
      drawArrow(ctx, browR.x, browR.y, "up", null, dpr, PRIMARY, pulse);
      drawArrow(ctx, mouthC.x, mouthC.y, "ring", "O-shape", dpr, PRIMARY, pulse);
      break;
    default:
      drawArrow(ctx, mouthC.x, mouthC.y, "ring", "Follow along", dpr, PRIMARY, pulse);
  }
}

function LiveExercisePreview({ exerciseId, stream, faceLandmarker, mirrorEnabled, className = "" }) {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const [hasFace, setHasFace] = useState(false);

  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  useEffect(() => {
    if (!faceLandmarker) return;
    let raf = 0;
    let alive = true;
    let lastTs = 0;
    const tick = async () => {
      if (!alive) return;
      const v = videoRef.current;
      const c = canvasRef.current;
      if (v && c && v.readyState >= 2 && !v.paused && v.videoWidth > 0) {
        let lm = null;
        try {
          const ts = Math.max(lastTs + 1, performance.now());
          lastTs = ts;
          const result = await faceLandmarker.detectForVideo(v, ts);
          if (!alive) return;
          lm = result?.faceLandmarks?.[0] ?? null;
        } catch {
          // Detection is best-effort; transient frame errors should not break preview.
        }
        drawArrowMarkers(c, v, lm, mirrorEnabled, exerciseId);
        if (lm && !hasFace) setHasFace(true);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [faceLandmarker, mirrorEnabled, hasFace, exerciseId]);

  return (
    <div className={`relative w-full max-w-[16rem] aspect-[3/4] rounded-3xl overflow-hidden ${className}`} style={{ background: "rgba(0,0,0,0.4)", border: "1px solid rgba(244, 239, 230, 0.1)" }}>
      <video ref={videoRef} autoPlay playsInline muted className="w-full h-full object-cover" style={{ transform: mirrorEnabled ? "scaleX(-1)" : "none" }} />
      <canvas ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />
      {!hasFace && (
        <div className="absolute inset-0 flex items-center justify-center text-xs opacity-70 pointer-events-none">Detecting face…</div>
      )}
    </div>
  );
}

function ExerciseAnimation({ region, size = "lg", className = "" }) {
  const sizeClass = { md: "w-28 h-28", lg: "w-40 h-40", xl: "w-44 h-44" }[size] ?? "w-40 h-40";
  const accent = "#D4A574";
  return (
    <div className={`${sizeClass} ${className} rounded-3xl flex items-center justify-center`} style={{ background: "rgba(244, 239, 230, 0.06)", border: "1px solid rgba(244, 239, 230, 0.1)", color: "#F4EFE6" }} aria-hidden>
      <svg viewBox="0 0 48 48" className="w-[78%] h-[78%]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24 5.5c-9.2 0-15.5 7.6-15.5 18.4 0 11 6.8 18.6 15.5 18.6s15.5-7.6 15.5-18.6C39.5 13.1 33.2 5.5 24 5.5Z" opacity="0.26" />
        <path d="M24 14.5v17" opacity="0.16" />

        {region === "forehead" && (
          <g className="bp-anim-forehead">
            <path d="M16 15.8c2.8-1.4 5.1-1.4 7.2-.2" stroke={accent} />
            <path d="M24.8 15.6c2.1-1.2 4.4-1.2 7.2.2" stroke={accent} />
            <path d="M17.5 11.2c4.2-1.7 8.8-1.7 13 0" opacity="0.58" />
          </g>
        )}

        {region === "eyes" && (
          <g className="bp-anim-eyes">
            <path d="M14.5 21.2c2.3-2.2 5.1-2.2 7.4 0" stroke={accent} />
            <path d="M26.1 21.2c2.3-2.2 5.1-2.2 7.4 0" stroke={accent} />
            <path d="M15.8 24.2c1.5.9 3.1.9 4.8 0" opacity="0.58" />
            <path d="M27.4 24.2c1.7.9 3.3.9 4.8 0" opacity="0.58" />
          </g>
        )}

        {region === "nose" && (
          <g className="bp-anim-nose">
            <path d="M24 18.5c-.5 3.8-1.5 7.2-3.4 10.3" stroke={accent} />
            <path d="M24 18.5c.5 3.8 1.5 7.2 3.4 10.3" stroke={accent} />
            <path className="bp-anim-nostril" d="M18.2 31.3c1.4-1.1 2.8-1.1 4.1 0" opacity="0.58" />
            <path className="bp-anim-nostril" d="M25.7 31.3c1.3-1.1 2.7-1.1 4.1 0" opacity="0.58" />
          </g>
        )}

        {region === "cheeks" && (
          <g className="bp-anim-cheeks">
            <path d="M14.4 27.3c2.4 2.1 5.2 2.1 7.5 0" stroke={accent} />
            <path d="M26.1 27.3c2.3 2.1 5.1 2.1 7.5 0" stroke={accent} />
            <path d="M16.4 23.1c1.1-.6 2.3-.6 3.4 0" opacity="0.5" />
            <path d="M28.2 23.1c1.1-.6 2.3-.6 3.4 0" opacity="0.5" />
          </g>
        )}

        {region === "mouth" && (
          <g>
            <path d="M19.6 27.8h8.8" opacity="0.58" />
            <path className="bp-anim-mouth-neutral" d="M17 31.2 L31 31.2" stroke={accent} />
            <path className="bp-anim-mouth-smile" d="M17 31.2c4.5 3.4 9.5 3.4 14 0" stroke={accent} />
          </g>
        )}

        {region === "emoji" && (
          <g className="bp-anim-emoji">
            <path d="M15.5 18.4c2.2-1.3 4.3-1.3 6.2 0" stroke={accent} />
            <path d="M26.3 18.4c1.9-1.3 4-1.3 6.2 0" stroke={accent} />
            <path d="M16.6 23.2c1.4 1 3 1 4.4 0" opacity="0.58" />
            <path d="M27 23.2c1.4 1 3 1 4.4 0" opacity="0.58" />
            <path d="M17 31.4c4.6 4 9.4 4 14 0" stroke={accent} />
            <path d="M33.2 12.4l.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3.9-1.8Z" fill={accent} stroke="none" />
          </g>
        )}
      </svg>
      <style>{`
        .bp-anim-forehead { animation: bpForehead 2.4s ease-in-out infinite; }
        .bp-anim-eyes path { animation: bpEyes 2.4s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
        .bp-anim-nose .bp-anim-nostril { animation: bpNose 2.4s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
        .bp-anim-cheeks path { animation: bpCheeks 2.4s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
        .bp-anim-mouth-neutral { animation: bpMouthNeutral 2.4s ease-in-out infinite; }
        .bp-anim-mouth-smile { animation: bpMouthSmile 2.4s ease-in-out infinite; opacity: 0; }
        .bp-anim-emoji { animation: bpEmoji 2.4s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
        @keyframes bpForehead { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-2.4px); } }
        @keyframes bpEyes { 0%, 100% { transform: scaleY(1); } 45%, 55% { transform: scaleY(0.18); } }
        @keyframes bpNose { 0%, 100% { transform: scaleX(1); } 50% { transform: scaleX(1.5); } }
        @keyframes bpCheeks { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.16); } }
        @keyframes bpMouthNeutral { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
        @keyframes bpMouthSmile { 0%, 100% { opacity: 0; } 50% { opacity: 1; } }
        @keyframes bpEmoji { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.06); } }
        @media (prefers-reduced-motion: reduce) {
          .bp-anim-forehead, .bp-anim-eyes path, .bp-anim-nose .bp-anim-nostril, .bp-anim-cheeks path, .bp-anim-mouth-neutral, .bp-anim-mouth-smile, .bp-anim-emoji { animation: none; }
          .bp-anim-mouth-smile { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function ExerciseGlyph({ exercise, exerciseId, region, size = "sm", tone = "light", className = "" }) {
  const resolved = exercise ?? EXERCISES.find((e) => e.id === exerciseId) ?? {};
  const regionKey = resolved.region ?? region ?? "mouth";
  const sizeClass = { xs: "w-8 h-8 rounded-xl", sm: "w-10 h-10 rounded-2xl", md: "w-14 h-14 rounded-2xl", lg: "w-20 h-20 rounded-3xl" }[size] ?? "w-10 h-10 rounded-2xl";
  const dark = tone === "dark";
  const background = dark ? "rgba(244, 239, 230, 0.08)" : "rgba(122, 143, 115, 0.1)";
  const border = dark ? "1px solid rgba(244, 239, 230, 0.1)" : "1px solid rgba(122, 143, 115, 0.18)";
  const color = dark ? "#F4EFE6" : "#1F1B16";
  const accent = dark ? "#D4A574" : "#7A8F73";

  return (
    <div className={`${sizeClass} ${className} shrink-0 flex items-center justify-center`} style={{ background, border, color }} aria-hidden>
      <svg viewBox="0 0 48 48" className="w-[72%] h-[72%]" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M24 5.5c-9.2 0-15.5 7.6-15.5 18.4 0 11 6.8 18.6 15.5 18.6s15.5-7.6 15.5-18.6C39.5 13.1 33.2 5.5 24 5.5Z" opacity="0.26" />
        <path d="M24 14.5v17" opacity="0.16" />

        {regionKey === "forehead" && (
          <>
            <path d="M16 15.8c2.8-1.4 5.1-1.4 7.2-.2" stroke={accent} />
            <path d="M24.8 15.6c2.1-1.2 4.4-1.2 7.2.2" stroke={accent} />
            <path d="M17.5 11.2c4.2-1.7 8.8-1.7 13 0" opacity="0.58" />
          </>
        )}

        {regionKey === "eyes" && (
          <>
            <path d="M14.5 21.2c2.3-2.2 5.1-2.2 7.4 0" stroke={accent} />
            <path d="M26.1 21.2c2.3-2.2 5.1-2.2 7.4 0" stroke={accent} />
            <path d="M15.8 24.2c1.5.9 3.1.9 4.8 0" opacity="0.58" />
            <path d="M27.4 24.2c1.7.9 3.3.9 4.8 0" opacity="0.58" />
          </>
        )}

        {regionKey === "nose" && (
          <>
            <path d="M24 18.5c-.5 3.8-1.5 7.2-3.4 10.3" stroke={accent} />
            <path d="M24 18.5c.5 3.8 1.5 7.2 3.4 10.3" stroke={accent} />
            <path d="M18.2 31.3c1.4-1.1 2.8-1.1 4.1 0" opacity="0.58" />
            <path d="M25.7 31.3c1.3-1.1 2.7-1.1 4.1 0" opacity="0.58" />
          </>
        )}

        {regionKey === "cheeks" && (
          <>
            <path d="M14.4 27.3c2.4 2.1 5.2 2.1 7.5 0" stroke={accent} />
            <path d="M26.1 27.3c2.3 2.1 5.1 2.1 7.5 0" stroke={accent} />
            <path d="M16.4 23.1c1.1-.6 2.3-.6 3.4 0" opacity="0.5" />
            <path d="M28.2 23.1c1.1-.6 2.3-.6 3.4 0" opacity="0.5" />
          </>
        )}

        {regionKey === "mouth" && (
          <>
            <path d="M17 31.2c4.5 3.4 9.5 3.4 14 0" stroke={accent} />
            <path d="M19.6 27.8h8.8" opacity="0.58" />
          </>
        )}

        {regionKey === "emoji" && (
          <>
            <path d="M15.5 18.4c2.2-1.3 4.3-1.3 6.2 0" stroke={accent} />
            <path d="M26.3 18.4c1.9-1.3 4-1.3 6.2 0" stroke={accent} />
            <path d="M16.6 23.2c1.4 1 3 1 4.4 0" opacity="0.58" />
            <path d="M27 23.2c1.4 1 3 1 4.4 0" opacity="0.58" />
            <path d="M17 31.4c4.6 4 9.4 4 14 0" stroke={accent} />
            <path d="M33.2 12.4l.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3.9-1.8Z" fill={accent} stroke="none" />
          </>
        )}
      </svg>
    </div>
  );
}

function PracticeView({ movementProfile, sessions, personalizedPlanIds, recommendedPlanIds, savedRepeatCounts, savedRepCounts, onStartSession, onShowDetail, onSavePersonalPlan, onResetPersonalPlan }) {
  // Library state stays local until the user starts or explicitly saves, keeping
  // one-off custom routines separate from the persisted daily plan.
  const profilePlan = useMemo(() => personalizedPlanIds?.length ? personalizedPlanIds : (recommendedPlanIds ?? []), [personalizedPlanIds, recommendedPlanIds]);
  const recommendedPlan = useMemo(() => recommendedPlanIds ?? profilePlan, [recommendedPlanIds, profilePlan]);
  const focusItems = useMemo(() => getAdaptiveFocusItems(movementProfile, sessions, 3), [movementProfile, sessions]);
  const dosing = getComfortDosing(movementProfile);
  // Repeat counts saved with the plan, narrowed to ids still in it. Seeds the editable
  // state so a saved routine reopens with its rep multipliers intact.
  const planRepeatCounts = useMemo(() => {
    if (!savedRepeatCounts) return {};
    const planSet = new Set(profilePlan);
    const result = {};
    for (const [id, count] of Object.entries(savedRepeatCounts)) {
      if (planSet.has(id) && count > 1) result[id] = count;
    }
    return result;
  }, [savedRepeatCounts, profilePlan]);
  const planRepCounts = useMemo(() => {
    if (!savedRepCounts) return {};
    const planSet = new Set(profilePlan);
    const result = {};
    for (const [id, count] of Object.entries(savedRepCounts)) {
      if (planSet.has(id) && count >= MIN_EXERCISE_REPS) result[id] = clampNumber(Math.round(count), MIN_EXERCISE_REPS, MAX_EXERCISE_REPS);
    }
    return result;
  }, [savedRepCounts, profilePlan]);
  const defaultRepCounts = useMemo(() => {
    const result = {};
    for (const exercise of EXERCISES) result[exercise.id] = applySessionDose(exercise, movementProfile).reps;
    return result;
  }, [movementProfile]);
  const [region, setRegion] = useState("all");
  const [selected, setSelected] = useState(() => new Set(profilePlan));
  // Per-exercise repeat count for one-off routines — lets the same exercise be queued
  // multiple times in a single session. Counts of 1 are omitted; the saved plan stays
  // de-duplicated (savePersonalPlan collapses ids through a Set) but keeps each count.
  const [repeatCounts, setRepeatCounts] = useState(planRepeatCounts);
  const [repCounts, setRepCounts] = useState(planRepCounts);
  const [hasDraftSelection, setHasDraftSelection] = useState(false);
  const selectionMatchesSavedPlan = (ids, counts = repeatCounts, reps = repCounts) => {
    const idList = Array.isArray(ids) ? ids : [...ids];
    if (!sameExerciseSet(idList, profilePlan)) return false;
    const countIds = new Set([...Object.keys(counts ?? {}), ...Object.keys(planRepeatCounts)]);
    for (const id of countIds) {
      if ((counts?.[id] ?? 1) !== (planRepeatCounts[id] ?? 1)) return false;
    }
    const repIds = new Set([...Object.keys(reps ?? {}), ...Object.keys(planRepCounts)]);
    for (const id of repIds) {
      if ((reps?.[id] ?? null) !== (planRepCounts[id] ?? null)) return false;
    }
    return true;
  };
  useEffect(() => {
    if (hasDraftSelection) return;
    setSelected(new Set(profilePlan));
    setRepeatCounts(planRepeatCounts);
    setRepCounts(planRepCounts);
  }, [profilePlan, planRepeatCounts, planRepCounts, hasDraftSelection]);
  const filtered = region === "all" ? EXERCISES : EXERCISES.filter((e) => e.region === region);
  const repeatOf = (id) => repeatCounts[id] ?? 1;
  const repOf = (id) => repCounts[id] ?? defaultRepCounts[id] ?? 1;
  const toggle = (id) => {
    const next = new Set(selected);
    let nextRepeatCounts = repeatCounts;
    let nextRepCounts = repCounts;
    if (next.has(id)) {
      next.delete(id);
      nextRepeatCounts = { ...repeatCounts };
      delete nextRepeatCounts[id];
      nextRepCounts = { ...repCounts };
      delete nextRepCounts[id];
      setRepeatCounts(nextRepeatCounts);
      setRepCounts(nextRepCounts);
    } else {
      next.add(id);
    }
    setSelected(next);
    setHasDraftSelection(!selectionMatchesSavedPlan(next, nextRepeatCounts, nextRepCounts));
  };
  const setRepeat = (id, count) => {
    const clamped = clampNumber(Math.round(count), 1, MAX_EXERCISE_REPEATS);
    const nextRepeatCounts = { ...repeatCounts };
    if (clamped <= 1) delete nextRepeatCounts[id];
    else nextRepeatCounts[id] = clamped;
    setRepeatCounts(nextRepeatCounts);
    setHasDraftSelection(!selectionMatchesSavedPlan(selected, nextRepeatCounts, repCounts));
  };
  const setExerciseReps = (id, count) => {
    const clamped = clampNumber(Math.round(count), MIN_EXERCISE_REPS, MAX_EXERCISE_REPS);
    const defaultReps = defaultRepCounts[id] ?? 1;
    const nextRepCounts = { ...repCounts };
    if (clamped === defaultReps) delete nextRepCounts[id];
    else nextRepCounts[id] = clamped;
    setRepCounts(nextRepCounts);
    setHasDraftSelection(!selectionMatchesSavedPlan(selected, repeatCounts, nextRepCounts));
  };
  const shownIds = filtered.map((exercise) => exercise.id);
  const orderedSelectedIds = useMemo(() => orderExerciseIdsByRegion([...selected], recommendedPlan), [selected, recommendedPlan]);
  // Expand ordered selection by repeat count, spacing repeats out so the same exercise
  // isn't queued back-to-back.
  const startIds = useMemo(
    () => spreadRepeatedExercises(orderedSelectedIds, repeatCounts),
    [orderedSelectedIds, repeatCounts]
  );
  const selectedMissingBaselineIds = movementProfile
    ? orderedSelectedIds.filter((id) => !movementProfile.exercises?.[id])
    : [];
  const selectedShownCount = shownIds.filter((id) => selected.has(id)).length;
  const allShownSelected = shownIds.length > 0 && selectedShownCount === shownIds.length;
  const startSessionExercises = useMemo(() => buildSessionExercises(startIds, movementProfile, repCounts), [startIds, movementProfile, repCounts]);
  const selectedDurationSec = useMemo(
    () => startSessionExercises.reduce((sum, ex) => sum + exercisePlannedSec(ex), 0)
      + Math.max(0, startSessionExercises.length - 1) * INTERSTITIAL_SEC,
    [startSessionExercises]
  );
  // The saved plan matches only when both the exercise set AND the per-exercise repeat
  // counts line up — changing just a rep multiplier should still offer to re-save.
  const repeatCountsMatchSaved = useMemo(() => {
    const ids = new Set([...Object.keys(repeatCounts), ...Object.keys(planRepeatCounts)]);
    for (const id of ids) {
      if ((repeatCounts[id] ?? 1) !== (planRepeatCounts[id] ?? 1)) return false;
    }
    return true;
  }, [repeatCounts, planRepeatCounts]);
  const repCountsMatchSaved = useMemo(() => {
    const ids = new Set([...Object.keys(repCounts), ...Object.keys(planRepCounts)]);
    for (const id of ids) {
      if ((repCounts[id] ?? null) !== (planRepCounts[id] ?? null)) return false;
    }
    return true;
  }, [repCounts, planRepCounts]);
  const savedPlanSelected = sameExerciseSet(orderedSelectedIds, profilePlan) && repeatCountsMatchSaved && repCountsMatchSaved;
  const recommendedSelected = sameExerciseSet(orderedSelectedIds, recommendedPlan) && Object.keys(repeatCounts).length === 0 && Object.keys(repCounts).length === 0;
  const hasCustomPlan = !sameExerciseIds(profilePlan, recommendedPlan) || Object.keys(planRepeatCounts).length > 0 || Object.keys(planRepCounts).length > 0;
  const canSavePlan = selected.size > 0 && !savedPlanSelected;
  const selectSavedPlan = () => { setSelected(new Set(profilePlan)); setRepeatCounts(planRepeatCounts); setRepCounts(planRepCounts); setHasDraftSelection(false); };
  const selectRecommended = () => {
    setSelected(new Set(recommendedPlan));
    setRepeatCounts({});
    setRepCounts({});
    setHasDraftSelection(!selectionMatchesSavedPlan(recommendedPlan, {}, {}));
  };
  const selectAllShown = () => {
    const next = new Set([...selected, ...shownIds]);
    setSelected(next);
    setHasDraftSelection(!selectionMatchesSavedPlan(next, repeatCounts, repCounts));
  };
  const clearSelection = () => {
    setSelected(new Set());
    setRepeatCounts({});
    setRepCounts({});
    setHasDraftSelection(!selectionMatchesSavedPlan([], {}, {}));
  };
  const routineExerciseCount = startIds.length;
  const totalReps = startSessionExercises.reduce((sum, exercise) => sum + (exercise.reps ?? 0), 0);
  const handleSavePlan = () => {
    if (!canSavePlan) return;
    const saved = onSavePersonalPlan?.(orderedSelectedIds, repeatCounts, repCounts);
    if (saved) setHasDraftSelection(false);
  };
  const handleResetPlan = () => {
    onResetPersonalPlan?.();
    setSelected(new Set(recommendedPlan));
    setRepeatCounts({});
    setRepCounts({});
    setHasDraftSelection(false);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-3xl" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>Practice library</h2>
        <p className="text-sm text-stone-600 mt-1">Select exercises for today, then start once or save them to your plan.</p>
      </div>
      {movementProfile && (
        <div className="rounded-2xl p-4" style={{ background: "rgba(122, 143, 115, 0.12)", border: "1px solid rgba(122, 143, 115, 0.2)" }}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="text-sm font-semibold">Saved personalized plan</div>
              <div className="text-xs text-stone-600">{dosing.label} dose · ordered forehead to mouth.</div>
            </div>
            {hasCustomPlan
              ? <ConfirmResetButton onConfirm={handleResetPlan} label="Reset" baseStyle={{ background: "#1F1B16", color: "#F4EFE6" }} />
              : <button onClick={selectRecommended} className="rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "#1F1B16", color: "#F4EFE6" }}>Recommended</button>}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1">
	            {profilePlan.map((id) => {
	              const exercise = EXERCISES.find((item) => item.id === id);
	              if (!exercise) return null;
	              const needsBaseline = !movementProfile.exercises?.[id];
	              const repeat = planRepeatCounts[id] ?? 1;
	              const reps = planRepCounts[id];
	              return (
	                <div key={id} className="shrink-0 inline-flex items-center gap-2 rounded-xl px-2.5 py-2 max-w-[14rem]" style={{ background: "rgba(255,255,255,0.42)", border: needsBaseline ? "1px solid rgba(154,106,50,0.35)" : "1px solid rgba(122,143,115,0.16)" }}>
	                  <ExerciseGlyph exercise={exercise} size="xs" />
	                  <div className="min-w-0">
	                    <div className="text-xs font-semibold truncate">{exercise.name}{repeat > 1 ? ` ×${repeat}` : ""}{reps ? ` · ${reps} reps` : ""}</div>
	                    {needsBaseline && <div className="text-[10px] mt-0.5" style={{ color: "#8B5A1E" }}>Needs baseline</div>}
	                  </div>
	                </div>
	              );
	            })}
          </div>
          {focusItems.length > 0 && (
            <div className="space-y-2 mt-3">
              {focusItems.map((item) => (
                <div key={item.id} className="flex items-center gap-3">
                  <ExerciseGlyph exercise={item.exercise} size="xs" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate">{item.exercise?.name}</div>
                    <div className="text-[11px] text-stone-600">{focusReason(item)} · limited side {item.profileExercise.limitedSide}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {REGIONS.map((r) => (
          <button key={r.key} onClick={() => setRegion(r.key)} className="px-3.5 py-1.5 rounded-full text-sm whitespace-nowrap" style={{ background: region === r.key ? "#1F1B16" : "rgba(255,255,255,0.6)", color: region === r.key ? "#F4EFE6" : "#1F1B16", border: region === r.key ? "none" : "1px solid rgba(31, 27, 22, 0.08)" }}>{r.label}</button>
        ))}
      </div>
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-2xl px-4 py-3" style={{ background: "rgba(255,255,255,0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
        <div className="text-xs text-stone-600">
          <div>{selectedShownCount} of {filtered.length} shown selected{selected.size !== selectedShownCount ? ` · ${selected.size} total` : ""}{routineExerciseCount !== selected.size ? ` · ${routineExerciseCount} in routine` : ""}{selected.size > 0 ? ` · ${totalReps} reps · ~${formatDuration(selectedDurationSec)}` : ""}</div>
          {selectedMissingBaselineIds.length > 0 && <div className="mt-0.5" style={{ color: "#9A6A32" }}>{selectedMissingBaselineIds.length} selected need baseline</div>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={selectSavedPlan} disabled={savedPlanSelected} className="rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-45" style={{ background: "rgba(184,84,58,0.12)", color: "#8F3C2A" }}>{savedPlanSelected ? "Saved plan selected" : "Saved plan"}</button>
          <button onClick={selectRecommended} disabled={recommendedSelected} className="rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-45" style={{ background: "rgba(122, 143, 115, 0.16)", color: "#3E5F3B" }}>{recommendedSelected ? "Recommended selected" : "Recommended"}</button>
          <button onClick={selectAllShown} disabled={allShownSelected} className="rounded-full px-3 py-1.5 text-xs font-semibold disabled:opacity-45" style={{ background: "#1F1B16", color: "#F4EFE6" }}>{allShownSelected ? "Shown selected" : "Select all shown"}</button>
          {hasCustomPlan && <ConfirmResetButton onConfirm={handleResetPlan} label="Reset to recommended" showIcon={false} baseStyle={{ background: "rgba(31, 27, 22, 0.06)", color: "#1F1B16" }} />}
          {selected.size > 0 && <button onClick={clearSelection} className="rounded-full px-3 py-1.5 text-xs font-semibold" style={{ background: "rgba(31, 27, 22, 0.06)", color: "#1F1B16" }}>Clear</button>}
        </div>
      </div>
      <div className="space-y-2.5">
        {filtered.map((ex) => (
          <ExerciseRow
            key={ex.id}
            exercise={ex}
            sessionExercise={applySessionDose(ex, movementProfile)}
            selected={selected.has(ex.id)}
            needsBaseline={Boolean(movementProfile && selected.has(ex.id) && !movementProfile.exercises?.[ex.id])}
            repeat={repeatOf(ex.id)}
            reps={repOf(ex.id)}
            defaultReps={defaultRepCounts[ex.id]}
            maxRepeat={MAX_EXERCISE_REPEATS}
            onToggle={() => toggle(ex.id)}
            onRepeatChange={(count) => setRepeat(ex.id, count)}
            onRepsChange={(count) => setExerciseReps(ex.id, count)}
            onShow={() => onShowDetail(ex)}
          />
        ))}
      </div>
      {selected.size > 0 && (
        <div className="fixed bottom-24 left-0 right-0 px-5 z-30 lg:bottom-6 lg:left-20">
          <div className="max-w-2xl mx-auto flex gap-2">
            {canSavePlan && (
              <button onClick={handleSavePlan} className="rounded-full py-3.5 px-5 flex items-center justify-center gap-2 font-semibold shadow-lg shrink-0" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
                <Save className="w-4 h-4" />Save plan
              </button>
            )}
            <button onClick={() => onStartSession(startIds, repCounts)} className="flex-1 rounded-full py-3.5 px-6 flex items-center justify-center gap-2 font-semibold shadow-lg" style={{ background: "#B8543A", color: "#F4EFE6" }}>
              <Play className="w-4 h-4 fill-current" />Start with {routineExerciseCount} exercise{routineExerciseCount > 1 ? "s" : ""}<span className="opacity-70 font-normal tabular-nums">· {totalReps} reps · ~{formatDuration(selectedDurationSec)}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CountStepper({ label, value, min, max, onChange, ariaLabel }) {
  return (
    <div className="flex items-center gap-1.5" role="group" aria-label={ariaLabel ?? label}>
      <span className="w-8 text-[10px] uppercase tracking-wider text-stone-500 text-right">{label}</span>
      <button
        onClick={() => onChange?.(value - 1)}
        disabled={value <= min}
        className="w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-35"
        style={{ background: "rgba(31, 27, 22, 0.06)", color: "#1F1B16" }}
        aria-label={`Decrease ${label.toLowerCase()}`}
      >
        <Minus className="w-3.5 h-3.5" />
      </button>
      <span className="w-5 text-center text-sm font-semibold tabular-nums" aria-label={`${value} ${label.toLowerCase()}`}>{value}</span>
      <button
        onClick={() => onChange?.(value + 1)}
        disabled={value >= max}
        className="w-7 h-7 rounded-full flex items-center justify-center disabled:opacity-35"
        style={{ background: "rgba(184, 84, 58, 0.16)", color: "#8F3C2A" }}
        aria-label={`Increase ${label.toLowerCase()}`}
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function ExerciseRow({ exercise, sessionExercise, selected, needsBaseline, repeat = 1, reps = null, defaultReps = null, maxRepeat = 5, onToggle, onRepeatChange, onRepsChange, onShow }) {
  const dose = sessionExercise ?? exercise;
  const displayReps = selected ? (reps ?? dose.reps) : dose.reps;
  const hasCustomReps = selected && defaultReps != null && displayReps !== defaultReps;
  return (
    <div className="rounded-2xl p-4 flex items-center gap-3" style={{ background: selected ? "rgba(184, 84, 58, 0.08)" : "rgba(255,255,255,0.5)", border: selected ? "1px solid rgba(184, 84, 58, 0.3)" : "1px solid rgba(31, 27, 22, 0.06)" }}>
      <button onClick={onToggle} className="w-6 h-6 rounded-full flex items-center justify-center shrink-0" style={{ background: selected ? "#B8543A" : "transparent", border: selected ? "none" : "1.5px solid rgba(31, 27, 22, 0.2)" }} aria-label={selected ? "Deselect" : "Select"}>
        {selected && <Check className="w-3.5 h-3.5 text-white" />}
      </button>
      <button onClick={onShow} className="flex-1 flex items-center gap-3 text-left min-w-0">
        <ExerciseGlyph exercise={exercise} size="sm" />
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[15px] truncate">{exercise.name}{repeat > 1 ? <span className="text-stone-400 font-normal"> ×{repeat}</span> : null}</div>
          <div className="text-xs text-stone-500 mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1">
            <span>{displayReps} reps · {dose.holdSec}s hold · <span className="capitalize">{exercise.region}</span></span>
            {hasCustomReps && <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(122,143,115,0.14)", color: "#4A6B47" }}>Custom reps</span>}
            {needsBaseline && <span className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: "rgba(212,165,116,0.18)", color: "#8B5A1E" }}>Needs baseline</span>}
          </div>
        </div>
        {!selected && <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />}
      </button>
      {selected && (
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <CountStepper label="Reps" value={displayReps} min={MIN_EXERCISE_REPS} max={MAX_EXERCISE_REPS} onChange={onRepsChange} ariaLabel={`${exercise.name} reps`} />
          <CountStepper label="Sets" value={repeat} min={1} max={maxRepeat} onChange={onRepeatChange} ariaLabel={`${exercise.name} times in routine`} />
        </div>
      )}
    </div>
  );
}

function ExerciseDetail({ exercise, movementProfile, onClose, onStart }) {
  const dose = applySessionDose(exercise, movementProfile);
  const dosing = getComfortDosing(movementProfile);
  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center p-4" style={{ background: "rgba(31, 27, 22, 0.5)" }} onClick={onClose}>
      <div className="w-full max-w-md rounded-3xl p-6 relative" style={{ background: "#F4EFE6" }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} className="absolute top-4 right-4 w-9 h-9 rounded-full flex items-center justify-center" style={{ background: "rgba(31, 27, 22, 0.06)" }} aria-label="Close"><X className="w-4 h-4" /></button>
        <ExerciseGlyph exercise={exercise} size="lg" className="mb-3" />
        <h3 className="text-2xl mb-1" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>{exercise.name}</h3>
        <div className="text-xs text-stone-500 mb-5 capitalize">{exercise.region} · {dose.reps} reps · {dose.holdSec}s hold · {dosing.label.toLowerCase()} dose</div>
        <div className="space-y-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-stone-500 mb-1.5">How to do it</div>
            <p className="text-[15px] leading-relaxed text-stone-800">{exercise.instruction}</p>
          </div>
          <div className="rounded-2xl p-4" style={{ background: "rgba(122, 143, 115, 0.12)" }}>
            <div className="flex items-start gap-2"><Info className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "#5C7055" }} /><p className="text-sm text-stone-700 leading-relaxed">{exercise.tip}</p></div>
          </div>
        </div>
        <button onClick={() => onStart(exercise.id)} className="mt-6 w-full rounded-full py-3 flex items-center justify-center gap-2 font-semibold" style={{ background: "#1F1B16", color: "#F4EFE6" }}><Play className="w-4 h-4 fill-current" />Practice this one</button>
      </div>
    </div>
  );
}

function TrackerStatusPill({ status, liveScore, phase, trackingIssue }) {
  let icon, label, color;
  if (status === "loading") { icon = <Loader2 className="w-3 h-3 animate-spin" />; label = "Loading symmetry tracker…"; color = "#D4A574"; }
  else if (status === "error") { icon = <AlertCircle className="w-3 h-3" />; label = "Tracker unavailable — session continues without scoring"; color = "#A8A29E"; }
  else if (status === "ready" && phase === "calibrate") {
    icon = <Loader2 className="w-3 h-3 animate-spin" />;
    label = "Calibrating neutral pose";
    color = "#D4A574";
  }
  else if (status === "ready" && phase === "hold") {
    if (trackingIssue) {
      icon = <AlertCircle className="w-3 h-3" />;
      label = trackingIssue;
      color = "#D4A574";
    } else {
      icon = <div className="w-2 h-2 rounded-full" style={{ background: "#7A8F73", boxShadow: "0 0 8px #7A8F73" }} />;
      label = liveScore != null ? "Tracking" : "Tracking · waiting for movement";
      color = "#7A8F73";
    }
  }
  else if (status === "ready") { icon = <div className="w-2 h-2 rounded-full" style={{ background: "#7A8F73" }} />; label = "Tracker ready"; color = "#7A8F73"; }
  else { icon = <Loader2 className="w-3 h-3 animate-spin" />; label = "Initializing…"; color = "#D4A574"; }

  return (
    <div className="flex items-center justify-center gap-2 px-3 py-1.5 rounded-full text-xs" style={{ background: "rgba(244, 239, 230, 0.08)", color, border: `1px solid ${color}40` }}>
      {icon}<span>{label}</span>
    </div>
  );
}

function RealtimeFeedback({ symmetry, balance, baseline }) {
  if (symmetry == null) return null;
  const pct = displayPct(symmetry);
  const color = scoreColor(symmetry);
  const left = balance?.left ?? 0;
  const right = balance?.right ?? 0;
  const max = Math.max(left, right, 0.0001); // avoid div/0
  const leftFrac = Math.min(left / max, 1);
  const rightFrac = Math.min(right / max, 1);
  // Which side is lagging — if the difference is meaningful
  const diff = Math.abs(left - right) / max;
  const lagging = diff > 0.15 ? (left < right ? "L" : "R") : null;

  return (
    <div className="px-3 py-2.5 rounded-2xl"
      style={{
        background: "rgba(31, 27, 22, 0.65)",
        backdropFilter: "blur(10px)",
        WebkitBackdropFilter: "blur(10px)",
        border: `1px solid ${color}`,
        minWidth: 140,
      }}>
      <div className="text-center">
        <div className="text-3xl tabular-nums leading-none" style={{ fontFamily: "Fraunces", fontWeight: 600, color, letterSpacing: "-0.02em" }}>{pct}%</div>
        <div className="text-[9px] uppercase tracking-wider mt-0.5" style={{ color: "#F4EFE6", opacity: 0.6 }}>symmetry</div>
      </div>
      <div className="mt-2.5 space-y-1.5">
        <BalanceBar label="L" frac={leftFrac} highlight={lagging === "L"} color={color} />
        <BalanceBar label="R" frac={rightFrac} highlight={lagging === "R"} color={color} />
      </div>
      <div className="text-[9px] mt-1.5 text-center h-3" style={{ color: "#F4EFE6", opacity: lagging ? 0.75 : 0 }}>
        {lagging === "L" ? "← lagging" : lagging === "R" ? "lagging →" : ""}
      </div>
      {baseline && (
        <div className="text-[9px] mt-1.5 text-center pt-1.5" style={{ color: "#F4EFE6", borderTop: "1px solid rgba(244,239,230,0.12)", opacity: 0.78 }}>
          {baseline.side} · {baselineProgressLabel(baseline)}
        </div>
      )}
    </div>
  );
}

function BalanceBar({ label, frac, highlight, color }) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="text-[10px] font-semibold w-3 text-center" style={{ color: "#F4EFE6", opacity: highlight ? 1 : 0.7 }}>{label}</div>
      <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(244, 239, 230, 0.15)" }}>
        <div className="h-full rounded-full" style={{ width: `${frac * 100}%`, background: highlight ? color : "#F4EFE6", transition: "width 150ms ease-out, background 200ms" }} />
      </div>
    </div>
  );
}

function PreviewView({ exercise, exIdx, totalExercises, onStart, onCancel, stream, faceLandmarker, mirrorEnabled, cameraError }) {
  if (!exercise) return null;
  const useLivePreview = stream && faceLandmarker && !cameraError && mirrorEnabled;
  return (
    <div className="fixed inset-0 z-50 flex items-stretch lg:items-center lg:justify-center lg:p-6" style={{ background: "rgba(12,10,8,0.92)" }}>
      <div className="flex flex-col w-full h-full lg:w-[440px] lg:h-[860px] lg:max-h-[92vh] lg:rounded-3xl lg:overflow-hidden lg:shadow-2xl" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
        <div className="flex items-center justify-between p-4 shrink-0">
          <button onClick={onCancel} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="End"><X className="w-5 h-5" /></button>
          <div className="text-xs opacity-70">Exercise {exIdx} of {totalExercises}</div>
          <div className="w-10" />
        </div>
        <div className="flex-1 overflow-y-auto px-6 pb-2 flex flex-col items-center text-center">
          <div className="text-xs uppercase tracking-widest opacity-60 mt-2 mb-4">Up next</div>
          {useLivePreview
            ? <LiveExercisePreview exerciseId={exercise.id} stream={stream} faceLandmarker={faceLandmarker} mirrorEnabled={mirrorEnabled} className="mb-5" />
            : <ExerciseAnimation region={exercise.region} size="lg" className="mb-5" />}
          <div className="text-3xl mb-1" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.01em" }}>{exercise.name}</div>
          <div className="text-xs opacity-60 mb-5 tracking-wide">{exercise.reps} reps · {exerciseHoldSec(exercise)}s hold</div>
          <div className="text-sm leading-relaxed mb-4 max-w-xs" style={{ color: "#F4EFE6" }}>{exercise.instruction}</div>
          {exercise.tip && (
            <div className="text-xs leading-relaxed opacity-60 max-w-xs mb-4" style={{ fontStyle: "italic" }}>{exercise.tip}</div>
          )}
        </div>
        <div className="p-4 shrink-0" style={{ borderTop: "1px solid rgba(244,239,230,0.08)" }}>
          <button onClick={onStart} className="w-full rounded-full px-6 py-4 font-semibold flex items-center justify-center gap-2 text-base" style={{ background: "#B8543A", color: "#F4EFE6" }}>
            I'm ready<ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function InterstitialView({ just, nextExercise, secondsLeft, exIdx, totalExercises, onNext, onCancel }) {
  if (!just) return null;
  const progress = just.initialMovementProgress ?? just.movementProgress ?? just.baselineProgress;
  return (
    <div className="fixed inset-0 z-50 flex items-stretch lg:items-center lg:justify-center lg:p-6" style={{ background: "rgba(12,10,8,0.92)" }}>
      <div className="flex flex-col w-full h-full lg:w-[440px] lg:h-[860px] lg:max-h-[92vh] lg:rounded-3xl lg:overflow-hidden lg:shadow-2xl" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
      <div className="flex items-center justify-between p-4 shrink-0">
        <button onClick={onCancel} className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="End"><X className="w-5 h-5" /></button>
        <div className="text-xs opacity-70">Exercise {exIdx} of {totalExercises} complete</div>
        <div className="w-10" />
      </div>
      <div className="flex-1 overflow-y-auto px-6 pb-2">
        <div className="text-center mb-5">
          <div className="text-xs uppercase tracking-widest opacity-60 mb-2">Just done</div>
          <ExerciseGlyph exerciseId={just.exerciseId} region={just.region} size="lg" tone="dark" className="mx-auto mb-3" />
          <div className="text-xl mb-2" style={{ fontFamily: "Fraunces", fontWeight: 500 }}>{just.name}</div>
          {just.avg != null && (
            <div className="text-5xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: scoreColor(just.avg), letterSpacing: "-0.02em" }}>{displayPct(just.avg)}%</div>
          )}
          {just.avg != null && <div className="text-xs opacity-60 mt-1">avg symmetry</div>}
          {progress && (
            <div className="inline-flex items-center gap-1.5 mt-3 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(244,239,230,0.08)", color: "#D4A574" }}>
              <TrendingUp className="w-3 h-3" />{progressSideLabel(progress)} side · {progressSummaryLabel(progress)}
            </div>
          )}
        </div>
        {just.snapshots?.length > 0 && (
          <div className="flex gap-2 mb-6 overflow-x-auto pb-1 px-2 justify-center" style={{ scrollbarWidth: "thin" }}>
            {just.snapshots.map((snap, i) => (
              <div key={i} className="shrink-0 rounded-lg overflow-hidden relative" style={{ border: `2px solid ${scoreColor(snap.score)}`, animation: `fadeInRep 0.35s ease-out ${i * 0.08}s both` }}>
                <img src={snap.dataUrl} alt="" style={{ width: 56, height: 80, objectFit: "cover", display: "block" }} />
                <div className="absolute bottom-0 inset-x-0 text-[9px] tabular-nums text-center py-0.5" style={{ background: "rgba(31,27,22,0.7)", color: "#F4EFE6" }}>
                  {snap.score != null ? displayPct(snap.score) + "%" : `#${i + 1}`}
                </div>
              </div>
            ))}
          </div>
        )}
        {nextExercise && (
          <div className="text-center pt-3 mt-4 border-t" style={{ borderColor: "rgba(244,239,230,0.08)" }}>
            <div className="text-[11px] uppercase tracking-widest opacity-50">{nextExercise.name} comes next</div>
          </div>
        )}
      </div>
      <div className="p-4 shrink-0 flex items-center gap-3" style={{ borderTop: "1px solid rgba(244,239,230,0.08)" }}>
        <div className="flex-1">
          <div className="text-5xl tabular-nums leading-none" style={{ fontFamily: "Fraunces", fontWeight: 600, color: "#D4A574" }}>{secondsLeft || "·"}</div>
          <div className="text-[10px] opacity-60 uppercase tracking-wider mt-0.5">break</div>
        </div>
        <button onClick={onNext} className="rounded-full px-6 py-3 font-semibold flex items-center gap-2" style={{ background: "#B8543A", color: "#F4EFE6" }}>
          Next<ChevronRight className="w-4 h-4" />
        </button>
      </div>
      <style>{`@keyframes fadeInRep { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
      </div>
    </div>
  );
}

function qualityColor(key) {
  if (key === "strong") return "#A8C39F";
  if (key === "usable") return "#D4A574";
  if (key === "weak") return "#FFB48F";
  return "#A8A29E";
}

function coactivationColor(risk) {
  if (risk === "high") return "#FFB48F";
  if (risk === "medium") return "#D4A574";
  return "#A8C39F";
}

function trendStatusLabel(status) {
  const labels = {
    collecting: "collecting",
    "low-confidence": "low confidence",
    stable: "stable",
    improving: "improving",
    "worse-capture-quality": "worse capture quality",
  };
  return labels[status] ?? status ?? "collecting";
}

function percentLabel(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : null;
}

function JournalSafetyPromptCard({ prompts }) {
  if (!prompts?.length) return null;
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgba(184, 84, 58, 0.08)", border: "1px solid rgba(184, 84, 58, 0.16)" }}>
      <div className="flex items-start gap-2 mb-3">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" style={{ color: "#B8543A" }} />
        <div>
          <div className="text-sm font-semibold">Safety notes</div>
          <div className="text-xs text-stone-600">From recent journal entries</div>
        </div>
      </div>
      <div className="space-y-2">
        {prompts.map((item) => (
          <div key={item.id} className="text-xs leading-relaxed flex items-start gap-2" style={{ color: item.severity === "urgent" ? "#8F3A25" : "#5E4A39" }}>
            <span className="mt-1 h-1.5 w-1.5 rounded-full shrink-0" style={{ background: item.severity === "urgent" ? "#B8543A" : "#D4A574" }} />
            <span>{item.prompt}{item.entryCount > 1 ? ` (${item.entryCount} entries)` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function SessionDiagnosticsPanel({ diagnostics }) {
  if (!diagnostics?.hasDiagnostics) return null;
  const quality = diagnostics.captureQuality;
  const setupQuality = diagnostics.setupQuality;
  const validRatio = percentLabel(quality?.validFrameRatio);
  const rejectedRatio = percentLabel(quality?.rejectionRatio);
  const coactivation = diagnostics.coactivation;
  const showCoactivation = coactivation && coactivation.risk !== "low";
  return (
    <div className="rounded-2xl p-4 mb-6" style={{ background: "rgba(244, 239, 230, 0.06)", border: "1px solid rgba(244, 239, 230, 0.1)" }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider opacity-55">Scoring diagnostics</div>
          {diagnostics.scoringModelVersion && <div className="text-[10px] opacity-45 mt-0.5">Model v{diagnostics.scoringModelVersion}</div>}
        </div>
        {quality && (
          <div className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider shrink-0" style={{ background: `${qualityColor(quality.key)}22`, color: qualityColor(quality.key) }}>
            {quality.label ?? quality.key}
          </div>
        )}
      </div>
      {quality && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          <div>
            <div className="text-xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>{validRatio ?? "--"}</div>
            <div className="text-[10px] uppercase tracking-wider opacity-50">valid frames</div>
          </div>
          <div>
            <div className="text-xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>{quality.rejectedFrameCount ?? 0}</div>
            <div className="text-[10px] uppercase tracking-wider opacity-50">{rejectedRatio ? `${rejectedRatio} rejected` : "rejected"}</div>
          </div>
          <div>
            <div className="text-xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>{quality.observedFrameCount ?? 0}</div>
            <div className="text-[10px] uppercase tracking-wider opacity-50">observed</div>
          </div>
        </div>
      )}
      {diagnostics.captureQualityNote && <div className="text-xs leading-relaxed opacity-70 mb-3">{diagnostics.captureQualityNote}</div>}
      {setupQuality && (
        <div className="rounded-xl px-3 py-2 mb-3" style={{ background: `${qualityColor(setupQuality.key)}1F`, color: qualityColor(setupQuality.key) }}>
          <div className="text-xs font-semibold">Setup: {setupQuality.label ?? setupQuality.key}</div>
          {setupQuality.actionItems?.length > 0 && <div className="text-[11px] opacity-75 mt-0.5">{setupQuality.actionItems[0]}</div>}
        </div>
      )}
      {diagnostics.topDropReasons.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-3">
          {diagnostics.topDropReasons.map((item) => (
            <span key={item.reason} className="rounded-full px-2 py-1 text-[10px] font-semibold" style={{ background: "rgba(244,239,230,0.08)", color: "#F4EFE6" }}>
              {item.label} x{item.count}
            </span>
          ))}
        </div>
      )}
      {showCoactivation && (
        <div className="rounded-xl px-3 py-2 mb-3" style={{ background: "rgba(212, 165, 116, 0.12)", color: coactivationColor(coactivation.risk) }}>
          <div className="text-xs font-semibold">Quiet-region movement: {coactivation.risk}</div>
          {coactivation.regions?.length > 0 && <div className="text-[11px] opacity-75 mt-0.5">{coactivation.regions.slice(0, 2).map((item) => item.region).join(", ")}</div>}
        </div>
      )}
      {diagnostics.safetyPrompts.length > 0 && (
        <div className="space-y-1.5">
          {diagnostics.safetyPrompts.map((prompt) => (
            <div key={prompt} className="flex items-start gap-2 text-xs leading-relaxed" style={{ color: "#FFD3C1" }}>
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{prompt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExerciseDiagnosticsLine({ diagnostics }) {
  if (!diagnostics) return null;
  const quality = diagnostics.captureQuality;
  const coactivation = diagnostics.coactivation;
  const coactivationPenalty = diagnostics.coactivationPenalty;
  const chips = [];
  if (quality) chips.push({ key: "quality", label: `Quality ${quality.label ?? quality.key}`, color: qualityColor(quality.key) });
  if (diagnostics.topDropReasons?.[0]) chips.push({ key: "drop", label: `${diagnostics.topDropReasons[0].label} x${diagnostics.topDropReasons[0].count}`, color: "#D4A574" });
  if (coactivation && coactivation.risk !== "low") chips.push({ key: "coactivation", label: `Quiet movement ${coactivation.risk}`, color: coactivationColor(coactivation.risk) });
  if (coactivationPenalty) chips.push({ key: "coactivation-penalty", label: `Practice score -${coactivationPenalty.penaltyPct}%`, color: coactivationColor(coactivationPenalty.risk) });
  if (!chips.length) return null;
  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {chips.map((chip) => (
        <span key={chip.key} className="rounded-full px-2 py-0.5 text-[10px] font-semibold" style={{ background: `${chip.color}1F`, color: chip.color }}>
          {chip.label}
        </span>
      ))}
    </div>
  );
}

function ClinicalScaleEstimatePanel({ clinicalScales }) {
  if (!clinicalScales) return null;
  const presentation = clinicalScalePresentationPolicy();
  const estimated = clinicalScales.status === "estimated";
  const inputCompletenessSummaries = estimated ? clinicalScaleInputCompletenessSummaries(clinicalScales) : [];
  const inputNotesByScale = Object.fromEntries(inputCompletenessSummaries.map((summary) => [summary.scaleKey, summary.shortLabel]));
  const cards = estimated ? clinicalScaleEstimateCards(clinicalScales.scales, presentation, inputNotesByScale) : [];
  const coverage = clinicalScales.coverage;
  const omittedMovements = omittedClinicalScaleMovementLabels(clinicalScales);
  const inputGaps = clinicalScaleInputGapSummaries(clinicalScales);
  const restingEvidence = clinicalScaleRestingEvidenceSummary(clinicalScales);
  return (
    <div className="rounded-2xl p-4 mb-6" style={{ background: "rgba(122,143,115,0.12)", border: "1px solid rgba(122,143,115,0.24)" }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-xs uppercase tracking-wider opacity-55">{presentation.panelTitle}</div>
          <div className="text-sm font-semibold mt-1">{estimated ? presentation.availableLabel : presentation.unavailableLabel}</div>
        </div>
        <div className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider" style={{ background: estimated ? "rgba(122,143,115,0.24)" : "rgba(212,165,116,0.16)", color: estimated ? "#D9E5D2" : "#F6D8B2" }}>
          {estimated ? presentation.badgeLabel : "No scale"}
        </div>
      </div>
      {estimated ? (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {cards.map((card) => (
            <div key={card.key} className="rounded-xl p-3" style={{ background: "rgba(244,239,230,0.06)", border: "1px solid rgba(244,239,230,0.08)" }}>
              <div className="mb-2 min-w-0">
                <div className="text-[10px] uppercase tracking-wider opacity-50 leading-snug" style={{ overflowWrap: "anywhere", hyphens: "auto" }}>{card.label}</div>
                <div className="text-[9px] uppercase tracking-wider opacity-50 leading-snug mt-1" style={{ overflowWrap: "anywhere", hyphens: "auto" }}>{card.statusLabel}</div>
              </div>
              <div className="text-xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>{card.value}</div>
              <div className="text-[11px] opacity-62 mt-1 leading-snug">{card.sublabel}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {(clinicalScales.reasons ?? ["insufficient assessment data"]).map((reason) => (
            <div key={reason} className="flex items-start gap-2 text-xs leading-relaxed" style={{ color: "#F6D8B2" }}>
              <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />{reason}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 text-[11px] leading-relaxed opacity-62">
        {coverage ? `${coverage.usableMovementCount}/${coverage.requiredMovementCount} standard movements usable. ` : ""}
        {restingEvidence ? `${restingEvidence.availableCount}/${restingEvidence.requiredCount} required resting metrics available. ` : ""}
        {restingEvidence && !restingEvidence.complete ? `Missing resting metrics: ${restingEvidence.missingMetricLabels.join(", ")}. ` : ""}
        {inputGaps.length ? `${inputGaps.map((gap) => gap.message).join(" ")} ` : ""}
        {inputCompletenessSummaries.length ? `${inputCompletenessSummaries.map((summary) => summary.message).join(" ")} ` : ""}
        {omittedMovements.length ? `Omitted from scale formulas: ${omittedMovements.join(", ")}. ` : ""}
        {clinicalScales.evidence?.label ? `${clinicalScales.evidence.label}. ` : ""}
        {presentation.shortNotice}
      </div>
    </div>
  );
}

// Dual-mode: live mode receives `scores` (in-progress array) + `onFinish`; view mode
// receives a saved `session` record + `onClose`. Both render the same comprehensive report.
function SessionSummary({ scores, sessionsToday, dailyGoal, baselineProgress, initialBaselineProgress, movementProgress, initialMovementProgress, restingMetrics, kind, startedAt, comfortLevel, prefs = {}, onFinish, session, onClose }) {
  const isView = !!session;
  const scoresArr = isView ? (session.scores || []) : scores;
  const usableProgress = (progress) => progressUsesLegacySideConvention(progress) ? null : progress;
  const sessionBaseline = isView ? usableProgress(session.baselineProgress) : baselineProgress;
  const sessionInitialBaseline = isView ? usableProgress(session.initialBaselineProgress) : initialBaselineProgress;
  const sessionMovement = isView ? usableProgress(session.movementProgress) : movementProgress;
  const sessionInitialMovement = isView ? usableProgress(session.initialMovementProgress) : initialMovementProgress;
  const effectiveKind = isView ? session.kind : kind;
  const isPractice = effectiveKind === "practice";
  const isAssessment = effectiveKind === "assessment";
  const nextFocus = isAssessment ? null : sessionFocusRecommendation(scoresArr);
  const nextFocusProgress = preferredMovementProgress(nextFocus) ?? preferredBaselineProgress(nextFocus);
  const overall = isView
    ? session.sessionAvg
    : (() => {
        const valid = scoresArr.map((e) => e.avg).filter((v) => v != null);
        return valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
      })();
  const reportSession = isView ? { ...session, sessionAvg: overall } : {
    date: todayISO(),
    ts: Date.now(),
    duration: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
    sessionAvg: overall,
    baselineProgress: sessionBaseline,
    initialBaselineProgress: sessionInitialBaseline,
    movementProgress: sessionMovement,
    initialMovementProgress: sessionInitialMovement,
    ...(restingMetrics ? { restingMetrics } : {}),
    scores: scoresArr,
    comfortLevel,
    kind: effectiveKind,
  };
  const assessmentSummary = isAssessment ? summarizeAssessmentSession(reportSession) : null;
  const showClinicalScaleEstimates = prefs.clinicalScaleEstimatesEnabled !== false;
  const diagnostics = summarizeSessionDiagnostics(reportSession);
  const overallPct = displayPct(overall);
  const [timelapse, setTimelapse] = useState(null); // { exerciseIdx, startIdx }
  const sessionN = (sessionsToday ?? 0) + 1;
  const goal = dailyGoal ?? 3;
  const remainingAfter = Math.max(0, goal - sessionN);
  const nextSlot = remainingAfter > 0 ? nextSessionAt(goal, sessionN) : null;
  const message = (() => {
    if (isAssessment) return "Assessment saved for comparison.";
    if (overall == null) return isView ? "Session recorded." : "Session done. Nicely steady work.";
    if (overall >= 0.85) return "Beautifully even today.";
    if (overall >= 0.7) return "Strong symmetric work.";
    if (overall >= 0.55) return "Good practice — the affected side is engaging.";
    return "Every session helps. Keep showing up.";
  })();

  return (
    <div className="fixed inset-0 z-50 flex items-stretch lg:items-center lg:justify-center lg:p-6" style={{ background: "rgba(12,10,8,0.92)" }}>
      <div className="flex flex-col w-full h-full lg:w-[440px] lg:h-[860px] lg:max-h-[92vh] lg:rounded-3xl lg:shadow-2xl overflow-y-auto" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
      <div className="max-w-md mx-auto w-full px-6 py-10 flex-1 flex flex-col">
        {isView && (
          <button onClick={onClose} className="self-start mb-4 w-10 h-10 rounded-full flex items-center justify-center" style={{ background: "rgba(244, 239, 230, 0.1)" }} aria-label="Close report"><X className="w-5 h-5" /></button>
        )}
        <div className="text-center mb-8">
          <div className="text-xs uppercase tracking-widest opacity-60 mb-2">{isView ? formatSessionDate(session) : isAssessment ? "Assessment complete" : isPractice ? "Practice complete" : "Session complete"}</div>
          <h2 className="text-3xl mb-3" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>
            <em style={{ fontStyle: "italic", fontWeight: 400 }}>{message}</em>
          </h2>
          {!isView && !isPractice && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(244,239,230,0.08)" }}>
              <span className="opacity-80">Session <span className="font-semibold" style={{ color: "#F4EFE6" }}>{sessionN}</span> of {goal} today</span>
              {nextSlot && <span className="opacity-60">· next at {formatClock(nextSlot)}</span>}
              {remainingAfter === 0 && <span className="opacity-60">· done for the day</span>}
            </div>
          )}
          {!isView && isPractice && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(244,239,230,0.08)" }}>
              <span className="opacity-80">Practice run · doesn't count toward daily goal</span>
            </div>
          )}
          {!isView && isAssessment && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(244,239,230,0.08)" }}>
              <span className="opacity-80">Standard assessment · separate from daily practice</span>
            </div>
          )}
          {isView && session.duration != null && (
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(244,239,230,0.08)" }}>
              <span className="opacity-80">{scoresArr.length} exercise{scoresArr.length !== 1 ? "s" : ""} · {formatDuration(session.duration)}</span>
            </div>
          )}
        </div>
        {overallPct != null && (
          <div className="text-center mb-8">
            <div className="text-7xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: scoreColor(overall), letterSpacing: "-0.03em" }}>{overallPct}%</div>
            <div className="text-sm opacity-70 mt-1">average symmetry</div>
            {sessionInitialMovement && (
              <div className="inline-flex items-center gap-1.5 mt-3 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(122,143,115,0.12)", color: "#A8C39F" }}>
                <TrendingUp className="w-3 h-3" />affected side · first baseline · {movementProgressLabel(sessionInitialMovement)}
              </div>
            )}
            {sessionInitialMovement && movementBalanceLabel(sessionInitialMovement) && (
              <div className="text-xs mt-2" style={{ color: "#A8C39F", opacity: 0.9 }}>{movementBalanceLabel(sessionInitialMovement)}</div>
            )}
            {!sessionInitialMovement && sessionInitialBaseline && (
              <div className="inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(122,143,115,0.12)", color: "#A8C39F" }}>
                <TrendingUp className="w-3 h-3" />first baseline · {sessionInitialBaseline.side} side · {baselineProgressLabel(sessionInitialBaseline)}
              </div>
            )}
            {sessionMovement && (!sessionInitialMovement || sessionMovement.affectedProgressRatio !== sessionInitialMovement.affectedProgressRatio || sessionMovement.baselineAffectedMovement !== sessionInitialMovement.baselineAffectedMovement) && (
              <div className="inline-flex items-center gap-1.5 mt-2 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(244,239,230,0.08)", color: "#D4A574" }}>
                <TrendingUp className="w-3 h-3" />current baseline · affected side · {movementProgressLabel(sessionMovement)}
              </div>
            )}
            {!sessionMovement && sessionBaseline && (
              <div className="inline-flex items-center gap-1.5 mt-3 px-3 py-1 rounded-full text-xs" style={{ background: "rgba(244,239,230,0.08)", color: "#D4A574" }}>
                <TrendingUp className="w-3 h-3" />current baseline · {sessionBaseline.side} side · {baselineProgressLabel(sessionBaseline)}
              </div>
            )}
          </div>
        )}
        <SessionDiagnosticsPanel diagnostics={diagnostics} />
        {isAssessment && showClinicalScaleEstimates && <ClinicalScaleEstimatePanel clinicalScales={assessmentSummary?.clinicalScales} />}
        {nextFocus && (
          <div className="rounded-2xl p-4 mb-6" style={{ background: "rgba(122,143,115,0.12)", border: "1px solid rgba(122,143,115,0.2)" }}>
            <div className="text-xs uppercase tracking-wider opacity-55 mb-2">Next focus</div>
            <div className="flex items-center gap-3">
              <ExerciseGlyph exerciseId={nextFocus.exerciseId} region={nextFocus.region} size="xs" tone="dark" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">{nextFocus.name}</div>
                <div className="text-xs opacity-65 mt-0.5">{nextFocus.avg != null ? `${displayPct(nextFocus.avg)}% symmetry` : "unscored"}{nextFocusProgress ? ` · ${progressSummaryLabel(nextFocusProgress)}` : ""}</div>
              </div>
            </div>
          </div>
        )}
        <div className="space-y-3 mb-8">
          <div className="text-xs uppercase tracking-wider opacity-60 mb-2">By exercise</div>
          {scoresArr.map((s, exIdx) => {
            const scoreMovement = usableProgress(s.movementProgress);
            const scoreInitialMovement = usableProgress(s.initialMovementProgress);
            const scoreBaseline = usableProgress(s.baselineProgress);
            const scoreInitialBaseline = usableProgress(s.initialBaselineProgress);
            const scoreDiagnostics = diagnostics.exercises[exIdx];
            return (
              <div key={`${s.exerciseId}-${exIdx}`} className="rounded-2xl p-4" style={{ background: "rgba(244, 239, 230, 0.06)" }}>
              <div className="flex items-center gap-3">
                <ExerciseGlyph exerciseId={s.exerciseId} region={s.region} size="xs" tone="dark" />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{s.name}</div>
                  <div className="text-xs opacity-60 mt-0.5">{s.scores.length} rep{s.scores.length !== 1 ? "s" : ""} scored{s.snapshots?.length ? ` · ${s.snapshots.length} shot${s.snapshots.length !== 1 ? "s" : ""}` : ""}</div>
                  {scoreMovement && <div className="text-xs mt-1" style={{ color: "#D4A574" }}>current · affected side · {movementProgressLabel(scoreMovement)}</div>}
                  {!scoreMovement && scoreBaseline && <div className="text-xs mt-1" style={{ color: "#D4A574" }}>current · {scoreBaseline.side} side · {baselineProgressLabel(scoreBaseline)}</div>}
                  {scoreInitialMovement && <div className="text-xs mt-0.5" style={{ color: "#A8C39F" }}>first · affected side · {movementProgressLabel(scoreInitialMovement)}</div>}
                  {scoreInitialMovement && movementBalanceLabel(scoreInitialMovement) && <div className="text-xs mt-0.5 opacity-70">{movementBalanceLabel(scoreInitialMovement)}</div>}
                  {!scoreInitialMovement && scoreInitialBaseline && <div className="text-xs mt-0.5" style={{ color: "#A8C39F" }}>first · {scoreInitialBaseline.side} side · {baselineProgressLabel(scoreInitialBaseline)}</div>}
                  <ExerciseDiagnosticsLine diagnostics={scoreDiagnostics} />
                </div>
                {s.avg != null ? <div className="text-xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: scoreColor(s.avg) }}>{displayPct(s.avg)}%</div> : <div className="text-xs opacity-50">—</div>}
              </div>
              {s.snapshots?.length > 0 && (
                <div className="flex gap-2 mt-3 overflow-x-auto pb-1" style={{ scrollbarWidth: "thin" }}>
                  {s.snapshots.map((snap, i) => (
                    <button key={i} onClick={() => setTimelapse({ exerciseIdx: exIdx, startIdx: i })} className="shrink-0 rounded-lg overflow-hidden relative" style={{ border: `2px solid ${scoreColor(snap.score)}` }} aria-label={`Rep ${i + 1}`}>
                      <img src={snap.dataUrl} alt="" style={{ width: 56, height: 80, objectFit: "cover", display: "block" }} />
                      <div className="absolute bottom-0 inset-x-0 text-[9px] tabular-nums text-center py-0.5" style={{ background: "rgba(31,27,22,0.7)", color: "#F4EFE6" }}>
                        {snap.score != null ? displayPct(snap.score) + "%" : `#${i + 1}`}
                      </div>
                    </button>
                  ))}
                </div>
              )}
              </div>
            );
          })}
        </div>
        {timelapse && (
          <TimelapseModal exercise={scoresArr[timelapse.exerciseIdx]} startIdx={timelapse.startIdx} onClose={() => setTimelapse(null)} />
        )}
        <div className="text-xs opacity-60 leading-relaxed mb-6 px-2 text-center">Symmetry is auto-detected from facial landmarks. Some movement variation is normal even in healthy faces.</div>
        <div className="mt-auto space-y-3">
          <button
            onClick={() => shareSessionReport(reportSession, { includeClinicalScaleEstimates: showClinicalScaleEstimates })}
            className="w-full rounded-full py-3 font-medium flex items-center justify-center gap-2"
            style={{ background: "rgba(244, 239, 230, 0.1)", color: "#F4EFE6", border: "1px solid rgba(244, 239, 230, 0.18)" }}
          >
            <Share2 className="w-4 h-4" /> Save PDF for physio
          </button>
          <button onClick={isView ? onClose : onFinish} className="w-full rounded-full py-3.5 font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>{isView ? "Close" : "Done"}</button>
        </div>
      </div>
      </div>
    </div>
  );
}

function PastSessionRow({ session, onOpen, onDelete }) {
  const [confirming, setConfirming] = useState(false);
  const exCount = (session.exercises ?? session.scores ?? []).length;
  const progress = preferredMovementProgress(session) ?? preferredBaselineProgress(session);
  const diagnostics = summarizeSessionDiagnostics(session);
  const quality = diagnostics.captureQuality;
  const canDelete = typeof onDelete === "function";
  return (
    <div className="rounded-xl px-3 py-2.5 flex items-center gap-3 transition hover:bg-white" style={{ background: "rgba(255,255,255,0.4)", border: "1px solid rgba(31, 27, 22, 0.04)" }}>
      <button onClick={() => onOpen(session)} disabled={confirming} className="flex-1 min-w-0 flex items-center gap-3 text-left disabled:opacity-50">
        <div className="text-xs text-stone-500 tabular-nums w-28 shrink-0">{formatSessionDate(session)}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm flex items-center gap-2">
            <span>{exCount} exercise{exCount !== 1 ? "s" : ""}</span>
            {session.kind === "practice" && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: "rgba(184, 84, 58, 0.12)", color: "#B8543A" }}>Practice</span>}
            {quality && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: `${qualityColor(quality.key)}22`, color: qualityColor(quality.key) }}>{quality.label}</span>}
          </div>
          <div className="text-xs text-stone-500 tabular-nums">{formatDuration(session.duration)}{progress ? ` · ${progressSummaryLabel(progress)}` : ""}</div>
        </div>
        {session.sessionAvg != null
          ? <div className="tabular-nums font-semibold text-base" style={{ fontFamily: "Fraunces", color: scoreColor(session.sessionAvg) }}>{displayPct(session.sessionAvg)}%</div>
          : <div className="text-xs text-stone-400">—</div>}
      </button>
      {confirming ? (
        <div className="flex items-center gap-1 shrink-0">
          <button onClick={() => setConfirming(false)} className="text-xs px-2 py-1 rounded-lg text-stone-600 hover:bg-white">Cancel</button>
          <button onClick={() => { setConfirming(false); onDelete(session); }} className="text-xs px-2 py-1 rounded-lg font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>Delete</button>
        </div>
      ) : canDelete ? (
        <button onClick={() => setConfirming(true)} aria-label="Delete session" className="shrink-0 p-1.5 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-white transition">
          <Trash2 className="w-4 h-4" />
        </button>
      ) : (
        <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" />
      )}
    </div>
  );
}

function PastSessionsList({ sessions, onOpen, onDelete }) {
  const [page, setPage] = useState(0);
  const sorted = useMemo(() => [...sessions].sort((a, b) => (b.ts || 0) - (a.ts || 0)), [sessions]);
  const pageCount = Math.ceil(sorted.length / PAST_SESSIONS_PAGE_SIZE);
  const lastPage = Math.max(0, pageCount - 1);
  const currentPage = Math.min(page, lastPage);
  const start = currentPage * PAST_SESSIONS_PAGE_SIZE;
  const visible = sorted.slice(start, start + PAST_SESSIONS_PAGE_SIZE);

  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(0, pageCount - 1)));
  }, [pageCount]);

  if (sorted.length === 0) return null;
  return (
    <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-semibold">Past sessions</div>
          {pageCount > 1 && (
            <div className="text-xs text-stone-500 tabular-nums mt-0.5">{start + 1}-{Math.min(start + PAST_SESSIONS_PAGE_SIZE, sorted.length)} of {sorted.length}</div>
          )}
        </div>
        {pageCount > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={() => setPage((value) => Math.max(0, value - 1))}
              disabled={currentPage === 0}
              aria-label="Show newer sessions"
              className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-stone-600 disabled:opacity-35 disabled:pointer-events-none hover:bg-white"
              style={{ background: "rgba(255,255,255,0.45)", border: "1px solid rgba(31, 27, 22, 0.06)" }}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <div className="text-xs text-stone-500 tabular-nums px-1.5">{currentPage + 1}/{pageCount}</div>
            <button
              onClick={() => setPage((value) => Math.min(lastPage, value + 1))}
              disabled={currentPage === lastPage}
              aria-label="Show older sessions"
              className="w-8 h-8 rounded-lg inline-flex items-center justify-center text-stone-600 disabled:opacity-35 disabled:pointer-events-none hover:bg-white"
              style={{ background: "rgba(255,255,255,0.45)", border: "1px solid rgba(31, 27, 22, 0.06)" }}
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
      <div className="space-y-1.5">
        {visible.map((s) => {
          const exCount = (s.exercises ?? s.scores ?? []).length;
          return <PastSessionRow key={s.id || s.ts || `${s.date}-${exCount}`} session={s} onOpen={onOpen} onDelete={onDelete} />;
        })}
      </div>
    </div>
  );
}

function PastAssessmentRow({ assessment, sourceSession, onOpen, showClinicalScaleEstimates = true }) {
  const displayAssessment = assessmentWithClinicalScaleFallback(assessment, sourceSession);
  const zones = displayAssessment.zones ?? [];
  const quality = displayAssessment.captureQuality;
  const coactivation = displayAssessment.coactivationRisk;
  const restingAsymmetry = displayAssessment.resting?.averageAsymmetryRatio;
  const clinicalScales = showClinicalScaleEstimates && displayAssessment.clinicalScales?.status === "estimated" ? displayAssessment.clinicalScales.scales : null;
  const clinicalLabel = compactClinicalScaleValueLabel(clinicalScales, clinicalScalePresentationPolicy());
  return (
    <button
      onClick={() => sourceSession && onOpen?.(sourceSession)}
      disabled={!sourceSession}
      className="w-full rounded-xl px-3 py-2.5 flex items-center gap-3 text-left disabled:opacity-70"
      style={{ background: "rgba(255,255,255,0.4)", border: "1px solid rgba(31, 27, 22, 0.04)" }}
    >
      <div className="text-xs text-stone-500 tabular-nums w-28 shrink-0">{formatSessionDate(assessment)}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm flex items-center gap-2">
          <span>{zones.length} zone{zones.length !== 1 ? "s" : ""}</span>
          {quality && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: `${qualityColor(quality.key)}22`, color: qualityColor(quality.key) }}>{quality.label ?? quality.key}</span>}
          {coactivation && coactivation !== "low" && <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: `${coactivationColor(coactivation)}22`, color: coactivationColor(coactivation) }}>quiet {coactivation}</span>}
        </div>
        <div className="text-xs text-stone-500">
          {[
            displayAssessment.averageVoluntaryMovement != null ? `${Math.round(displayAssessment.averageVoluntaryMovement * 100)}% voluntary movement` : "assessment saved",
            Number.isFinite(restingAsymmetry) ? `${Math.round(restingAsymmetry * 100)}% rest asymmetry` : null,
            clinicalLabel,
          ].filter(Boolean).join(" · ")}
        </div>
      </div>
      {sourceSession ? <ChevronRight className="w-4 h-4 text-stone-400 shrink-0" /> : <div className="text-xs text-stone-400 shrink-0">record only</div>}
    </button>
  );
}

function PastAssessmentsList({ assessments, sessions, onOpen, showClinicalScaleEstimates = true }) {
  const sorted = [...(assessments ?? [])].sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 12);
  if (!sorted.length) return null;
  return (
    <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
      <div className="text-sm font-semibold mb-3">Past assessments</div>
      <div className="space-y-1.5">
        {sorted.map((assessment) => {
          const sourceSession = sourceSessionForAssessment(assessment, sessions);
          return <PastAssessmentRow key={assessment.sourceSessionId ?? assessment.sourceSessionTs ?? assessment.ts} assessment={assessment} sourceSession={sourceSession} onOpen={onOpen} showClinicalScaleEstimates={showClinicalScaleEstimates} />;
        })}
      </div>
    </div>
  );
}

function TimelapseModal({ exercise, startIdx, onClose }) {
  const [idx, setIdx] = useState(startIdx);
  const [playing, setPlaying] = useState(false);
  const total = exercise.snapshots.length;
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setIdx((i) => {
        if (i + 1 >= total) { setPlaying(false); return i; }
        return i + 1;
      });
    }, 500);
    return () => clearInterval(id);
  }, [playing, total]);
  const snap = exercise.snapshots[idx];
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.85)" }} onClick={onClose}>
      <div className="rounded-3xl p-4 max-w-sm w-full mx-4" style={{ background: "#1F1B16", color: "#F4EFE6", border: "1px solid rgba(244,239,230,0.08)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-sm"><ExerciseGlyph exerciseId={exercise.exerciseId} region={exercise.region} size="xs" tone="dark" />{exercise.name}</div>
          <button onClick={onClose} className="text-xs opacity-60 hover:opacity-100">Close</button>
        </div>
        <img src={snap.dataUrl} alt={`Rep ${idx + 1}`} className="w-full rounded-2xl block" />
        <div className="flex items-center gap-3 mt-3">
          <button onClick={() => { if (idx >= total - 1) setIdx(0); setPlaying((p) => !p); }} className="rounded-full px-3 py-1.5 text-sm font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>
            {playing ? "Pause" : "Play timelapse"}
          </button>
          <div className="text-xs opacity-70 flex-1 text-right tabular-nums">
            Rep {idx + 1} / {total}{snap.score != null ? ` · ${displayPct(snap.score)}%` : ""}
          </div>
        </div>
        <input type="range" min="0" max={total - 1} value={idx} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} className="w-full mt-3" style={{ accentColor: "#B8543A" }} />
      </div>
    </div>
  );
}

function JournalView({ entries, onSave }) {
  const today = todayISO();
  const todayEntry = entries.find((e) => recordDateISO(e) === today);
  const [symmetry, setSymmetry] = useState(todayEntry?.symmetry ?? 5);
  const [mood, setMood] = useState(todayEntry?.mood ?? "okay");
  const [notes, setNotes] = useState(todayEntry?.notes ?? "");
  const [saved, setSaved] = useState(false);
  const handleSave = () => { onSave({ date: today, symmetry, mood, notes, ts: Date.now() }); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  const past = [...entries].filter((e) => recordDateISO(e) !== today).reverse();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>How are you today?</h2>
        <p className="text-sm text-stone-600 mt-1">A short check-in helps you see your trend over time.</p>
      </div>
      <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
        <div className="flex justify-between items-baseline mb-3">
          <div className="text-sm font-semibold">Symmetry rating</div>
          <div className="text-3xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: "#B8543A" }}>{symmetry}<span className="text-sm text-stone-500 ml-1">/ 10</span></div>
        </div>
        <input type="range" min="1" max="10" value={symmetry} onChange={(e) => setSymmetry(Number(e.target.value))} className="w-full" style={{ accentColor: "#B8543A" }} />
        <div className="flex justify-between text-xs text-stone-500 mt-2"><span>Significant droop</span><span>Full symmetry</span></div>
      </div>
      <div>
        <div className="text-sm font-semibold mb-3">Mood</div>
        <div className="grid grid-cols-4 gap-2">
          {MOOD_OPTIONS.map((m) => (
            <button key={m.key} onClick={() => setMood(m.key)} className="rounded-2xl p-3 text-center" style={{ background: mood === m.key ? "#1F1B16" : "rgba(255,255,255,0.5)", color: mood === m.key ? "#F4EFE6" : "#1F1B16", border: mood === m.key ? "none" : "1px solid rgba(31, 27, 22, 0.06)" }}>
              <div className="text-2xl mb-1">{m.emoji}</div>
              <div className="text-xs font-medium">{m.label}</div>
            </button>
          ))}
        </div>
      </div>
      <div>
        <div className="text-sm font-semibold mb-2">Notes</div>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything you noticed today — taste, dryness, fatigue, small wins…" rows="4" className="w-full rounded-2xl p-4 text-sm resize-none focus:outline-none focus:ring-2" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)", fontFamily: "Manrope" }} />
      </div>
      <button onClick={handleSave} className="w-full rounded-full py-3 font-semibold" style={{ background: saved ? "#7A8F73" : "#1F1B16", color: "#F4EFE6" }}>{saved ? "✓ Saved" : todayEntry ? "Update entry" : "Save entry"}</button>
      {past.length > 0 && (
        <div>
          <div className="text-sm uppercase tracking-wider text-stone-500 mb-3">Past entries</div>
          <div className="space-y-2">{past.slice(0, 14).map((e) => <PastEntryRow key={e.date} entry={e} />)}</div>
        </div>
      )}
    </div>
  );
}

function JournalPrompt({ session, onSave, onSkip }) {
  const autoRating = useMemo(() => autoJournalRatingFromSession(session), [session]);
  const [symmetry, setSymmetry] = useState(autoRating.value);
  const [mood, setMood] = useState(moodFromRating(autoRating.value));
  const [notes, setNotes] = useState("");
  const date = recordDateISO(session) ?? todayISO();
  const save = () => {
    onSave({
      date,
      symmetry,
      mood,
      notes,
      ts: Date.now(),
      autoRated: true,
      autoRatingReason: autoRating.reason,
      sourceSessionTs: session?.ts ?? null,
      sourceSessionAvg: session?.sessionAvg ?? null,
    });
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="journal-prompt-title" className="fixed inset-0 z-[70] flex items-center justify-center p-5" style={{ background: "rgba(12,10,8,0.72)" }}>
      <div className="w-full max-w-md max-h-[92vh] overflow-y-auto rounded-3xl p-5" style={{ background: "#F4EFE6", color: "#1F1B16", boxShadow: "0 24px 80px rgba(0,0,0,0.35)" }}>
        <div className="flex items-start justify-between gap-3 mb-5">
          <div>
            <div className="text-xs uppercase tracking-wider text-stone-500 mb-2">Daily journal</div>
            <h2 id="journal-prompt-title" className="text-3xl" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>Log today's progress</h2>
            <p className="text-sm text-stone-600 mt-2 leading-relaxed">Mirror auto-rated this from {autoRating.reason}. Adjust it if your face feels different than the camera score.</p>
          </div>
          <button onClick={onSkip} className="w-10 h-10 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(31,27,22,0.08)" }} aria-label="Skip journal"><X className="w-5 h-5" /></button>
        </div>

        <div className="rounded-2xl p-4 mb-4" style={{ background: "rgba(255,255,255,0.55)", border: "1px solid rgba(31,27,22,0.06)" }}>
          <div className="flex justify-between items-baseline mb-3">
            <div className="text-sm font-semibold">Daily progress rating</div>
            <div className="text-4xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: "#B8543A" }}>{symmetry}<span className="text-sm text-stone-500 ml-1">/ 10</span></div>
          </div>
          <input type="range" min="1" max="10" value={symmetry} onChange={(e) => setSymmetry(Number(e.target.value))} className="w-full" style={{ accentColor: "#B8543A" }} />
        </div>

        <div className="mb-4">
          <div className="text-sm font-semibold mb-3">Mood</div>
          <div className="grid grid-cols-4 gap-2">
            {MOOD_OPTIONS.map((m) => (
              <button key={m.key} onClick={() => setMood(m.key)} className="rounded-2xl p-3 text-center" style={{ background: mood === m.key ? "#1F1B16" : "rgba(255,255,255,0.55)", color: mood === m.key ? "#F4EFE6" : "#1F1B16", border: mood === m.key ? "none" : "1px solid rgba(31,27,22,0.06)" }}>
                <div className="text-2xl mb-1">{m.emoji}</div>
                <div className="text-xs font-medium">{m.label}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="mb-5">
          <div className="text-sm font-semibold mb-2">Notes</div>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anything you noticed today — dryness, fatigue, taste, small wins…" rows="3" className="w-full rounded-2xl p-4 text-sm resize-none focus:outline-none focus:ring-2" style={{ background: "rgba(255,255,255,0.55)", border: "1px solid rgba(31,27,22,0.06)", fontFamily: "Manrope" }} />
        </div>

        <div className="flex gap-2">
          <button onClick={onSkip} className="rounded-full px-4 py-3 text-sm font-semibold" style={{ background: "rgba(31,27,22,0.08)", color: "#1F1B16" }}>Skip</button>
          <button onClick={save} className="flex-1 rounded-full px-4 py-3 text-sm font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>Save journal entry</button>
        </div>
      </div>
    </div>
  );
}

function PastEntryRow({ entry }) {
  const mood = MOOD_OPTIONS.find((m) => m.key === entry.mood);
  const label = formatCalendarDate(recordDateISO(entry), { weekday: "short", month: "short", day: "numeric" });
  return (
    <div className="rounded-2xl p-3 flex items-center gap-3" style={{ background: "rgba(255, 255, 255, 0.4)", border: "1px solid rgba(31, 27, 22, 0.04)" }}>
      <div className="text-xl">{mood?.emoji ?? "·"}</div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {entry.notes && <div className="text-xs text-stone-600 truncate">{entry.notes}</div>}
      </div>
      <div className="text-sm tabular-nums shrink-0" style={{ fontFamily: "Fraunces", fontWeight: 600, color: "#B8543A" }}>{entry.symmetry}<span className="text-xs text-stone-500">/10</span></div>
    </div>
  );
}

function MovementProfileCard({ profile, initialProfile, history, sessions, progressByExercise, onStart, onReset }) {
  const exercises = profileExerciseEntries(profile);
  const [managerOpen, setManagerOpen] = useState(false);
  const focusItems = getAdaptiveFocusItems(profile, sessions, 3);
  const created = profile?.createdAt ? new Date(profile.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  const status = profileStatus(profile);
  const retakeExerciseIds = status?.retakeExercises?.map((ex) => ex.exerciseId) ?? [];
  const missingBaselineIds = profile
    ? PROFILE_ASSESSMENT_EXERCISES.filter((id) => !profile.exercises?.[id])
    : [];
  const firstProfile = initialProfile && initialProfile.createdAt !== profile?.createdAt ? initialProfile : null;
  const previousProfile = history?.[0] ?? null;
  const comparison = compareMovementProfiles(profile, previousProfile);
  const firstComparison = compareMovementProfiles(profile, firstProfile);
  const historyRows = (history ?? []).slice(0, 3);
  if (!profile) {
    return (
      <div className="rounded-2xl p-5" style={{ background: "rgba(31, 27, 22, 0.92)", color: "#F4EFE6" }}>
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(244,239,230,0.1)" }}><Zap className="w-4 h-4" style={{ color: "#D4A574" }} /></div>
          <div className="flex-1">
            <div className="text-sm font-semibold mb-1">Personal movement baseline</div>
            <p className="text-xs opacity-70 leading-relaxed mb-4">Capture a short first-use profile so Mirror can compare future sessions against your own starting point.</p>
            <button onClick={onStart} className="rounded-full px-4 py-2 text-xs font-semibold" style={{ background: "#B8543A", color: "#F4EFE6" }}>Create baseline</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl p-5" style={{ background: "rgba(31, 27, 22, 0.92)", color: "#F4EFE6" }}>
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <div className="text-sm font-semibold">Personal movement baseline</div>
          <div className="text-xs opacity-60 mt-0.5 leading-relaxed">Created {created ?? "unknown"} · affected side: {formatProfileSide(profile.affectedSide)} · {getComfortDosing(profile).label.toLowerCase()} dose · {exercises.length}/{PROFILE_ASSESSMENT_EXERCISES.length} baselines</div>
        </div>
        <div className="text-right">
          {profile.initialAvgSymmetry != null && (
            <div className="text-2xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: scoreColor(profile.initialAvgSymmetry) }}>{displayPct(profile.initialAvgSymmetry)}%</div>
          )}
          {status && <div className="inline-flex mt-1 text-[10px] rounded-full px-2 py-0.5" style={{ background: `${status.quality.color}26`, color: status.quality.color }}>{status.quality.label}</div>}
        </div>
      </div>
      {missingBaselineIds.length > 0 && (
        <div className="rounded-2xl p-3 mb-4 flex flex-wrap items-center gap-3" style={{ background: "rgba(212,165,116,0.14)", color: "#F6D8B2", border: "1px solid rgba(212,165,116,0.2)" }}>
          <div className="flex-1 text-xs">Starter baseline saved. Add the remaining {missingBaselineIds.length} movement baseline{missingBaselineIds.length === 1 ? "" : "s"} when you have a few minutes.</div>
          <button onClick={() => onStart(missingBaselineIds)} className="rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap" style={{ background: "#D4A574", color: "#1F1B16" }}>Add remaining</button>
        </div>
      )}
      {status?.shouldRetake && (
        <div className="rounded-2xl p-3 mb-4 flex flex-wrap items-center gap-3" style={{ background: "rgba(184,84,58,0.16)", color: "#FFD3C1" }}>
          <div className="flex-1 text-xs">Retake recommended: {status.reason}</div>
          {retakeExerciseIds.length > 0 && (
            <button onClick={() => onStart(retakeExerciseIds)} className="rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap" style={{ background: "#B8543A", color: "#F4EFE6" }}>Retake weak only</button>
          )}
          {(status.noisy || status.stale || retakeExerciseIds.length === 0) && (
            <button onClick={() => onStart()} className="rounded-full px-3 py-1.5 text-xs font-semibold whitespace-nowrap" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6", border: "1px solid rgba(244,239,230,0.18)" }}>Full retake</button>
          )}
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
        <div className="rounded-2xl p-3" style={{ background: "rgba(244,239,230,0.06)" }}>
          <div className="text-[10px] uppercase tracking-wider opacity-45 mb-1">Profile</div>
          <div className="text-sm font-semibold tabular-nums">v{profile.version ?? "—"}</div>
        </div>
        <div className="rounded-2xl p-3" style={{ background: "rgba(244,239,230,0.06)" }}>
          <div className="text-[10px] uppercase tracking-wider opacity-45 mb-1">Setup</div>
          <div className="text-sm font-semibold truncate" style={{ color: qualityColor(profile.setupQuality?.key) }}>{profile.setupQuality?.label ?? profile.setupQuality?.key ?? "—"}</div>
        </div>
        <div className="rounded-2xl p-3" style={{ background: "rgba(244,239,230,0.06)" }}>
          <div className="text-[10px] uppercase tracking-wider opacity-45 mb-1">Noise</div>
          <div className="text-sm font-semibold tabular-nums">{profile.calibrationQuality?.coreAvgNoise ?? profile.calibrationQuality?.avgNoise ?? "—"}</div>
        </div>
        <div className="rounded-2xl p-3" style={{ background: "rgba(244,239,230,0.06)" }}>
          <div className="text-[10px] uppercase tracking-wider opacity-45 mb-1">Retakes</div>
          <div className="text-sm font-semibold tabular-nums">{history?.length ?? 0}</div>
        </div>
      </div>
      {firstComparison && (
        <div className="rounded-2xl p-3 mb-4" style={{ background: "rgba(212,165,116,0.12)", border: "1px solid rgba(212,165,116,0.18)" }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs uppercase tracking-wider opacity-55">First vs current</div>
              <div className="text-xs opacity-60 mt-0.5">First saved baseline {firstComparison.previousDate ?? "available"}</div>
            </div>
            {firstComparison.avgSymmetryDelta != null && (
              <div className="text-sm font-semibold tabular-nums" style={{ color: firstComparison.avgSymmetryDelta >= 0 ? "#A8C39F" : "#FFB48F" }}>{signedPointDelta(firstComparison.avgSymmetryDelta)}</div>
            )}
          </div>
        </div>
      )}
      {comparison && (
        <div className="rounded-2xl p-3 mb-4" style={{ background: "rgba(122,143,115,0.14)", border: "1px solid rgba(122,143,115,0.2)" }}>
          <div className="flex items-start justify-between gap-3 mb-3">
            <div>
              <div className="text-xs uppercase tracking-wider opacity-55">Retake comparison</div>
              <div className="text-xs opacity-60 mt-0.5">Compared with {comparison.previousDate ?? "previous baseline"}</div>
            </div>
            {comparison.avgSymmetryDelta != null && (
              <div className="text-sm font-semibold tabular-nums" style={{ color: comparison.avgSymmetryDelta >= 0 ? "#A8C39F" : "#FFB48F" }}>{signedPointDelta(comparison.avgSymmetryDelta)}</div>
            )}
          </div>
          <div className="space-y-2">
            {comparison.exerciseDeltas.slice(0, 2).map((item) => (
              <div key={item.exerciseId} className="flex items-center gap-2 text-xs">
                <ExerciseGlyph exerciseId={item.exerciseId} region={item.region} size="xs" tone="dark" />
                <div className="flex-1 min-w-0 truncate">{item.name}</div>
                <div className="tabular-nums" style={{ color: item.symmetryDelta >= 0 ? "#A8C39F" : "#FFB48F" }}>{signedPointDelta(item.symmetryDelta)}</div>
              </div>
            ))}
            {comparison.noiseDelta != null && (
              <div className="text-[11px] opacity-60">{comparison.noiseLabel ?? "Calibration noise"} {comparison.noiseDelta <= 0 ? "decreased" : "increased"} by {Math.abs(comparison.noiseDelta).toFixed(5)}</div>
            )}
          </div>
        </div>
      )}
      {focusItems.length > 0 && (
        <div className="rounded-2xl p-3 mb-4" style={{ background: "rgba(244,239,230,0.06)" }}>
          <div className="text-xs uppercase tracking-wider opacity-55 mb-2">Current focus</div>
          <div className="space-y-2">
            {focusItems.map((item) => (
              <div key={item.id} className="flex items-center gap-2 text-xs">
                <ExerciseGlyph exercise={item.exercise} size="xs" tone="dark" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium truncate">{item.exercise?.name}</div>
                  <div className="opacity-55">{focusReason(item)}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-2 mb-4">
        {exercises.map((ex) => (
          <div key={ex.exerciseId} className="flex items-center gap-3 text-xs">
            <ExerciseGlyph exerciseId={ex.exerciseId} region={ex.region} size="xs" tone="dark" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{ex.name}</div>
              <div className="opacity-55">
                limited side: {ex.limitedSide} · reliable {ex.thresholdBands?.reliableMovement ?? ex.activationThreshold ?? "—"} · target {ex.thresholdBands?.baselineTarget ?? "—"}
              </div>
              {ex.quality && <div className="opacity-55">quality: {ex.quality.label}{ex.quality.issues?.length ? ` · ${ex.quality.issues.join(", ")}` : ""}</div>}
              {progressByExercise?.[ex.exerciseId] && <div className="mt-0.5" style={{ color: "#D4A574" }}>{progressSummaryLabel(progressByExercise[ex.exerciseId])}</div>}
            </div>
            {ex.quality?.key === "retake" && (
              <button onClick={() => onStart([ex.exerciseId])} className="rounded-full px-2.5 py-1 text-[11px] font-semibold shrink-0" style={{ background: "rgba(184,84,58,0.2)", color: "#FFD3C1" }}>Retake</button>
            )}
            {ex.initialSymmetry != null && <div className="tabular-nums shrink-0" style={{ color: scoreColor(ex.initialSymmetry) }}>{displayPct(ex.initialSymmetry)}%</div>}
          </div>
        ))}
      </div>
      {historyRows.length > 0 && (
        <div className="rounded-2xl p-3 mb-4" style={{ background: "rgba(244,239,230,0.06)" }}>
          <div className="text-xs uppercase tracking-wider opacity-55 mb-2">Baseline history</div>
          <div className="space-y-2">
            {historyRows.map((item, index) => {
              const archivedStatus = profileStatus(item);
              return (
                <div key={item.archivedAt ?? `${item.createdAt}-${index}`} className="flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium">{formatProfileDate(item.createdAt) ?? "Previous baseline"}</div>
                    <div className="opacity-50">affected side {formatProfileSide(item.affectedSide)} · {archivedStatus?.quality.label ?? "Unknown"}</div>
                  </div>
                  {item.initialAvgSymmetry != null && <div className="tabular-nums" style={{ color: scoreColor(item.initialAvgSymmetry) }}>{displayPct(item.initialAvgSymmetry)}%</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button onClick={onStart} className="rounded-full px-4 py-2 text-xs font-semibold" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6" }}>Redo full baseline</button>
        <button onClick={() => setManagerOpen((open) => !open)} className="inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-semibold" style={{ background: managerOpen ? "#B8543A" : "rgba(244,239,230,0.12)", color: "#F4EFE6", border: managerOpen ? "none" : "1px solid rgba(244,239,230,0.16)" }}>
          <RotateCcw className="w-3.5 h-3.5" />Individual baselines
        </button>
      </div>
      {managerOpen && <BaselineManagerPanel profile={profile} onRedo={onStart} onReset={onReset} />}
    </div>
  );
}

function BaselineView({ data, onStartProfile, onResetBaselines }) {
  const progressByExercise = useMemo(() => latestExerciseProgressById(data.sessions), [data.sessions]);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>Baseline</h2>
        <p className="text-sm text-stone-600 mt-1">Manage the movement baselines that drive progress, focus, and activation thresholds.</p>
      </div>
      <MovementProfileCard
        profile={data.movementProfile}
        initialProfile={data.initialMovementProfile}
        history={data.movementProfileHistory}
        sessions={data.sessions}
        progressByExercise={progressByExercise}
        onStart={onStartProfile}
        onReset={onResetBaselines}
      />
    </div>
  );
}

function ProgressView({ data, streak, prefs, dataTransferStatus, onTogglePref, onSetPref, onOpenReport, onDeleteSession, onExportData, onExportClinicianBundle, onExportValidationDataset, onImportData }) {
  // Progress charts are projections of journal/session history. Keeping them derived
  // avoids migration work when scoring or display rules change.
  const practiceSessions = useMemo(() => data.sessions.filter((session) => session.kind !== "assessment"), [data.sessions]);
  const assessments = useMemo(() => data.assessments ?? [], [data.assessments]);
  const totalSessions = practiceSessions.length;
  const today = todayISO();
  const last7DaysSessions = practiceSessions.filter((s) => {
    const date = recordDateISO(s);
    if (!date) return false;
    const days = daysBetween(date, today);
    return days >= 0 && days < 7;
  }).length;
  const personalModelDisabled = prefs.personalModelEnabled === false;
  const showClinicalScaleEstimates = prefs.clinicalScaleEstimatesEnabled !== false;
  const personalModel = personalModelDisabled ? null : data.personalRecoveryModel;
  const personalModelEntries = Object.values(personalModel?.exercises ?? {}).filter((entry) => entry.currentRatio != null);
  const trainedEntries = personalModelEntries.filter((entry) => entry.confidence !== "collecting");
  const personalCurrentRatio = trainedEntries.length
    ? trainedEntries.reduce((sum, entry) => sum + entry.currentRatio, 0) / trainedEntries.length
    : null;
  const personalFocusItems = useMemo(() => personalRecoveryFocusItems(personalModel, 3), [personalModel]);
  const modelStatus = personalModelDisabled ? "disabled" : personalModel?.status ?? "collecting";
  const modelStatusColor = modelStatus === "high" ? "#7A8F73" : modelStatus === "medium" ? "#6E7F59" : modelStatus === "low" ? "#D4A574" : modelStatus === "disabled" ? "#A8A29E" : "#A8A29E";
  const journalChartData = useMemo(() => data.journal.length === 0 ? [] : data.journal.slice(-21).map((j) => ({ date: formatShortRecordDate(j), symmetry: j.symmetry })), [data.journal]);
  const aiSymmetryData = useMemo(() => practiceSessions.filter((s) => s.sessionAvg != null).slice(-21).map((s) => ({ date: formatShortRecordDate(s), score: displayPct(s.sessionAvg) })), [practiceSessions]);
  const assessmentTrendData = useMemo(() => assessments.filter((assessment) => assessment.averageVoluntaryMovement != null).slice(-21).map((assessment) => ({ date: formatShortRecordDate(assessment), score: Math.round(assessment.averageVoluntaryMovement * 100) })), [assessments]);
  const journalSafetyPrompts = useMemo(() => summarizeJournalSafetyPrompts(data.journal), [data.journal]);
  const baselineProgressData = useMemo(() => practiceSessions.map((s) => {
    const progress = preferredMovementProgress(s) ?? preferredBaselineProgress(s);
    const ratio = progress?.affectedProgressRatio ?? progress?.ratio;
    return ratio == null ? null : { date: formatShortRecordDate(s), progress: Math.round(ratio * 100) };
  }).filter(Boolean).slice(-21), [practiceSessions]);
  const activityGrid = useMemo(() => {
    const grid = [];
    for (let i = 13; i >= 0; i--) {
      const iso = addDaysISO(today, -i);
      const daySessions = practiceSessions.filter((s) => recordDateISO(s) === iso);
      // Recovery, not symmetry: color by how much the affected side moves vs the frozen
      // baseline (affectedProgressRatio). A per-rep min/max symmetry average can fall on a
      // day the affected side actually moved MORE — it tracks instantaneous balance, not
      // recovery. Movement-vs-baseline is the signal that rises as the patient improves.
      const ratios = daySessions
        .map((s) => preferredMovementProgress(s)?.affectedProgressRatio)
        .filter((v) => v != null);
      const dayRecovery = ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
      grid.push({ date: iso, count: daySessions.length, recovery: dayRecovery });
    }
    return grid;
  }, [practiceSessions, today]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>Your progress</h2>
        <p className="text-sm text-stone-600 mt-1">Recovery is rarely linear. Look for the trend, not the day.</p>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Streak" value={streak} unit={streak === 1 ? "day" : "days"} />
        <StatCard label="Last 7 days" value={last7DaysSessions} unit="sessions" />
        <StatCard label="All time" value={totalSessions} unit="sessions" />
      </div>
      <JournalSafetyPromptCard prompts={journalSafetyPrompts} />
      <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <div className="flex items-center gap-2 mb-1"><TrendingUp className="w-3.5 h-3.5" style={{ color: "#7A8F73" }} /><div className="text-sm font-semibold">Personal recovery model</div></div>
            <div className="text-xs text-stone-500">{personalModelDisabled ? "Enable it in preferences to train local recovery trends." : "Local trend model from your own affected-side movement history."}</div>
          </div>
          <div className="rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider shrink-0" style={{ background: `${modelStatusColor}22`, color: modelStatusColor }}>
            {modelStatus}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <div className="text-2xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600, color: "#7A8F73" }}>{personalCurrentRatio != null ? Math.round(personalCurrentRatio * 100) : "—"}</div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500">{personalCurrentRatio != null ? "% baseline" : "collecting"}</div>
          </div>
          <div>
            <div className="text-2xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>{trainedEntries.length}</div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500">/{personalModelEntries.length || 0} ready</div>
          </div>
          <div>
            <div className="text-2xl tabular-nums" style={{ fontFamily: "Fraunces", fontWeight: 600 }}>{personalModelEntries.reduce((sum, entry) => sum + (entry.sampleCount ?? 0), 0)}</div>
            <div className="text-[10px] uppercase tracking-wider text-stone-500">scored</div>
          </div>
        </div>
        {!personalModelDisabled && personalFocusItems.length > 0 ? (
          <div className="space-y-2">
            {personalFocusItems.map((item) => {
              const exercise = EXERCISES.find((ex) => ex.id === item.exerciseId);
              const trend = item.trendSlopePctPerWeek;
              const trendLabel = trend == null ? "trend collecting" : `${trend >= 0 ? "+" : ""}${Math.round(trend)} pts/week`;
              const detailParts = [`${Math.round((item.currentRatio ?? 0) * 100)}% of first baseline`];
              if (item.currentRatioLow != null && item.currentRatioHigh != null) detailParts.push(`range ${Math.round(item.currentRatioLow * 100)}-${Math.round(item.currentRatioHigh * 100)}%`);
              if (item.currentBalanceRatio != null) detailParts.push(`balance ${Math.round(item.currentBalanceRatio * 100)}%`);
              detailParts.push(trendLabel);
              if (item.isCurrentStale && item.currentRatioAsOf) detailParts.push(`as of ${item.currentRatioAsOf}`);
              return (
                <div key={item.exerciseId} className="rounded-xl px-3 py-2 flex items-center justify-between gap-3" style={{ background: "rgba(31, 27, 22, 0.04)" }}>
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{exercise?.name ?? item.exerciseId}</div>
                    <div className="text-xs text-stone-500">{detailParts.join(" · ")}</div>
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-stone-500 shrink-0">{trendStatusLabel(item.trendStatus ?? item.confidence)}</div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-xs text-stone-500">
            {personalModelDisabled
              ? "Personal recovery modeling is turned off."
              : personalModelEntries.length === 0 && (personalModel?.legacyExcludedSampleCount ?? 0) > 0
                ? "Your older sessions used a previous movement format and can't train the model yet. New sessions will build it."
                : "Complete at least 5 scored sessions across 3 different dates for an exercise to train its recovery trend."}
          </div>
        )}
      </div>
      {aiSymmetryData.length > 1 ? (
        <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
          <div className="flex items-center gap-2 mb-1"><Zap className="w-3.5 h-3.5" style={{ color: "#B8543A" }} /><div className="text-sm font-semibold">Measured symmetry</div></div>
          <div className="text-xs text-stone-500 mb-4">From your session recordings · auto-detected</div>
          <div style={{ width: "100%", height: 180 }}>
            <ResponsiveContainer>
              <AreaChart data={aiSymmetryData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                <defs><linearGradient id="aiGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#B8543A" stopOpacity={0.4} /><stop offset="100%" stopColor="#B8543A" stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#7C7066" }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: "#7C7066" }} axisLine={false} tickLine={false} ticks={[0, 50, 100]} />
                <Tooltip contentStyle={{ background: "#1F1B16", border: "none", borderRadius: 8, color: "#F4EFE6", fontSize: 12 }} formatter={(v) => [`${v}%`, "Symmetry"]} />
                <Area type="monotone" dataKey="score" stroke="#B8543A" strokeWidth={2} fill="url(#aiGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : (
        <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
          <div className="flex items-center gap-2 mb-1"><Zap className="w-3.5 h-3.5" style={{ color: "#B8543A" }} /><div className="text-sm font-semibold">Measured symmetry</div></div>
          <div className="text-xs text-stone-500 mt-1">Complete a couple of sessions with the camera on to see your measured symmetry trend over time.</div>
        </div>
      )}
      {assessmentTrendData.length > 1 && (
        <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
          <div className="flex items-center gap-2 mb-1"><Check className="w-3.5 h-3.5" style={{ color: "#7A8F73" }} /><div className="text-sm font-semibold">Standard assessment trend</div></div>
          <div className="text-xs text-stone-500 mb-4">Separate from daily practice sessions</div>
          <div style={{ width: "100%", height: 160 }}>
            <ResponsiveContainer>
              <AreaChart data={assessmentTrendData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                <defs><linearGradient id="assessmentGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7A8F73" stopOpacity={0.4} /><stop offset="100%" stopColor="#7A8F73" stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#7C7066" }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, "dataMax + 20"]} tick={{ fontSize: 10, fill: "#7C7066" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "#1F1B16", border: "none", borderRadius: 8, color: "#F4EFE6", fontSize: 12 }} formatter={(v) => [`${v}%`, "Assessment"]} />
                <Area type="monotone" dataKey="score" stroke="#7A8F73" strokeWidth={2} fill="url(#assessmentGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {baselineProgressData.length > 0 && (
        <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
          <div className="flex items-center gap-2 mb-1"><TrendingUp className="w-3.5 h-3.5" style={{ color: "#7A8F73" }} /><div className="text-sm font-semibold">Affected-side movement from first baseline</div></div>
          <div className="text-xs text-stone-500 mb-4">100% = first saved movement baseline</div>
          <div style={{ width: "100%", height: 160 }}>
            <ResponsiveContainer>
              <AreaChart data={baselineProgressData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                <defs><linearGradient id="baselineGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7A8F73" stopOpacity={0.4} /><stop offset="100%" stopColor="#7A8F73" stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#7C7066" }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, "dataMax + 20"]} tick={{ fontSize: 10, fill: "#7C7066" }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: "#1F1B16", border: "none", borderRadius: 8, color: "#F4EFE6", fontSize: 12 }} formatter={(v) => [`${v}%`, "Movement"]} />
                <Area type="monotone" dataKey="progress" stroke="#7A8F73" strokeWidth={2} fill="url(#baselineGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
        <div className="flex items-center justify-between mb-3">
          <div className="text-sm font-semibold">Last 14 days</div>
          <div className="text-xs text-stone-500">color = movement vs baseline</div>
        </div>
        <div className="grid gap-1.5" style={{ gridTemplateColumns: "repeat(14, 1fr)" }}>
          {activityGrid.map((day) => {
            // No sessions: muted gray. Sessions but no movement-progress data: amber dot.
            // With data: color by affected-side movement vs the frozen baseline (red < 85%,
            // amber 85–115%, green ≥ 115% of baseline) — rises as the affected side recovers.
            const bg = day.count === 0
              ? "rgba(31, 27, 22, 0.06)"
              : day.recovery == null
                ? "rgba(212, 165, 116, 0.5)"
                : recoveryColor(day.recovery);
            const recoveryPct = day.recovery != null ? Math.round(day.recovery * 100) : null;
            const tooltip = day.count === 0
              ? `${day.date}: no sessions`
              : recoveryPct != null
                ? `${day.date}: ${day.count} session${day.count !== 1 ? "s" : ""} · affected side ${recoveryPct}% of baseline`
                : `${day.date}: ${day.count} session${day.count !== 1 ? "s" : ""}`;
            return <div key={day.date} className="aspect-square rounded-md" style={{ background: bg }} title={tooltip} />;
          })}
        </div>
        <div className="flex items-center gap-2 mt-3 text-xs text-stone-500">
          <span>Below baseline</span>
          <div className="w-3 h-3 rounded-sm" style={{ background: "rgba(31, 27, 22, 0.06)" }} title="no sessions" />
          <div className="w-3 h-3 rounded-sm" style={{ background: "#B8543A" }} title="< 85% of baseline" />
          <div className="w-3 h-3 rounded-sm" style={{ background: "#D4A574" }} title="85–115% of baseline" />
          <div className="w-3 h-3 rounded-sm" style={{ background: "#7A8F73" }} title="≥ 115% of baseline" />
          <span>Improving</span>
        </div>
      </div>
      <PastAssessmentsList assessments={assessments} sessions={data.sessions} onOpen={onOpenReport} showClinicalScaleEstimates={showClinicalScaleEstimates} />
      <PastSessionsList sessions={practiceSessions} onOpen={onOpenReport} onDelete={onDeleteSession} />
      {journalChartData.length > 1 && (
        <div className="rounded-2xl p-5" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
          <div className="text-sm font-semibold mb-1">Self-rated symmetry</div>
          <div className="text-xs text-stone-500 mb-4">From your journal entries</div>
          <div style={{ width: "100%", height: 160 }}>
            <ResponsiveContainer>
              <AreaChart data={journalChartData} margin={{ top: 5, right: 5, left: -25, bottom: 5 }}>
                <defs><linearGradient id="journalGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7A8F73" stopOpacity={0.4} /><stop offset="100%" stopColor="#7A8F73" stopOpacity={0} /></linearGradient></defs>
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#7C7066" }} axisLine={false} tickLine={false} />
                <YAxis domain={[1, 10]} tick={{ fontSize: 10, fill: "#7C7066" }} axisLine={false} tickLine={false} ticks={[1, 5, 10]} />
                <Tooltip contentStyle={{ background: "#1F1B16", border: "none", borderRadius: 8, color: "#F4EFE6", fontSize: 12 }} />
                <Area type="monotone" dataKey="symmetry" stroke="#7A8F73" strokeWidth={2} fill="url(#journalGradient)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      <BrowserDataControls status={dataTransferStatus} onExport={onExportData} onExportClinicianBundle={onExportClinicianBundle} onExportValidationDataset={onExportValidationDataset} onImport={onImportData} />
      <div>
        <div className="text-sm uppercase tracking-wider text-stone-500 mb-3">Preferences</div>
        <div className="space-y-2">
          <DailyGoalSelector value={prefs.dailyGoal ?? 3} onChange={(v) => onSetPref("dailyGoal", v)} />
          <ToggleRow label="Symmetry tracking" description="Auto-measure symmetry during exercises" value={prefs.symmetryEnabled} onToggle={() => onTogglePref("symmetryEnabled")} />
          <ToggleRow label="Personal recovery model" description="Train local trend estimates from your saved sessions" value={prefs.personalModelEnabled !== false} onToggle={() => onTogglePref("personalModelEnabled")} />
          <ToggleRow label="Scale-inspired estimates" description="Show optional HB-inspired, Sunnybrook-style, and eFACE-style self-tracking estimates after assessments" value={showClinicalScaleEstimates} onToggle={() => onTogglePref("clinicalScaleEstimatesEnabled")} />
          <ToggleRow label="Local data capture" description="Store sampled landmarks for debugging and future model work" value={prefs.dataCaptureEnabled === true} onToggle={() => onTogglePref("dataCaptureEnabled")} />
          <ScoringNoiseModeSelector value={prefs.scoringNoiseMode ?? "normal"} onChange={(mode) => onSetPref("scoringNoiseMode", mode)} />
          <ToggleRow label="Scoring diagnostics" description="Log scoring signals in the browser console" value={prefs.scoringDiagnosticsEnabled === true} onToggle={() => onSetPref("scoringDiagnosticsEnabled", !(prefs.scoringDiagnosticsEnabled === true))} />
          <ToggleRow label="Voice cues during practice" description="Spoken prompts for each rep" value={prefs.voiceEnabled} onToggle={() => { if (prefs.voiceEnabled) flushSpeech(); else primeSpeech(true, { text: "Voice cues on." }); onTogglePref("voiceEnabled"); }} />
          <ToggleRow label="Mirror camera" description="Front camera during sessions" value={prefs.mirrorEnabled} onToggle={() => onTogglePref("mirrorEnabled")} />
        </div>
      </div>
      <div className="rounded-2xl p-4 text-xs text-stone-600 leading-relaxed" style={{ background: "rgba(122, 143, 115, 0.1)" }}>
        Mirror is a practice companion, not medical care. Always work with your neurologist and physical therapist on your specific recovery plan. Discontinue any exercise that causes pain.
      </div>
    </div>
  );
}

function BrowserDataControls({ status, onExport, onExportClinicianBundle, onExportValidationDataset, onImport }) {
  const inputRef = useRef(null);
  const [pendingImportFile, setPendingImportFile] = useState(null);
  const busy = status?.kind === "working";
  const statusColor = status?.kind === "error" ? "#B8543A" : status?.kind === "success" ? "#7A8F73" : "#7C7066";
  const handleImportPick = (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) setPendingImportFile(file);
  };
  return (
    <div>
      <div className="text-sm uppercase tracking-wider text-stone-500 mb-3">Browser data</div>
      <div className="rounded-2xl p-4" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
        <div className="text-sm font-medium mb-1">Local backup</div>
        <div className="text-xs text-stone-500 mb-4">Sessions, baselines, journal, preferences, report images, and local capture samples.</div>
        <div className="flex flex-wrap gap-2">
          <button disabled={busy} onClick={onExport} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold disabled:opacity-45" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
            <Download className="w-3.5 h-3.5" />Export data
          </button>
          <button disabled={busy} onClick={onExportClinicianBundle} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold disabled:opacity-45" style={{ background: "rgba(122,143,115,0.16)", color: "#4A6B47", border: "1px solid rgba(122,143,115,0.24)" }}>
            <Download className="w-3.5 h-3.5" />Clinician bundle
          </button>
          <button disabled={busy} onClick={onExportValidationDataset} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold disabled:opacity-45" style={{ background: "rgba(212,165,116,0.16)", color: "#7C5528", border: "1px solid rgba(212,165,116,0.3)" }}>
            <Download className="w-3.5 h-3.5" />Validation set
          </button>
          <button disabled={busy} onClick={() => inputRef.current?.click()} className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold disabled:opacity-45" style={{ background: "rgba(31,27,22,0.08)", color: "#1F1B16", border: "1px solid rgba(31,27,22,0.08)" }}>
            <Upload className="w-3.5 h-3.5" />Import data
          </button>
          <input ref={inputRef} type="file" accept="application/json,application/x-ndjson,.json,.jsonl" className="hidden" onChange={handleImportPick} />
        </div>
        {status?.message && <div className="text-xs mt-3" style={{ color: statusColor }}>{status.message}</div>}
      </div>
      {pendingImportFile && (
        <ConfirmAlert
          title="Import browser data?"
          message={`This replaces the saved browser data on this device with ${pendingImportFile.name}.`}
          confirmLabel="Import data"
          cancelLabel="Keep current data"
          onConfirm={() => {
            const file = pendingImportFile;
            setPendingImportFile(null);
            onImport?.(file);
          }}
          onCancel={() => setPendingImportFile(null)}
        />
      )}
    </div>
  );
}

function DailyGoalSelector({ value, onChange }) {
  const v = value ?? 3;
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
      <div className="text-sm font-medium mb-1">Daily goal</div>
      <div className="text-xs text-stone-500 mb-3">Bell's palsy retraining works best with frequent short sessions. Pick a count that feels sustainable.</div>
      <div className="flex rounded-full p-1 gap-1" style={{ background: "rgba(31, 27, 22, 0.06)" }}>
        {[1, 2, 3, 4, 5, 6].map((n) => {
          const active = v === n;
          return (
            <button key={n} onClick={() => onChange(n)} className="flex-1 py-2 rounded-full text-sm font-semibold tabular-nums" style={{ background: active ? "#1F1B16" : "transparent", color: active ? "#F4EFE6" : "#1F1B16", transition: "background 0.15s, color 0.15s" }}>
              {n}
            </button>
          );
        })}
      </div>
      <div className="text-xs text-stone-500 mt-3">Sessions spread evenly between {DAY_START_HOUR > 12 ? DAY_START_HOUR - 12 : DAY_START_HOUR}{DAY_START_HOUR >= 12 ? " PM" : " AM"} and {DAY_END_HOUR > 12 ? DAY_END_HOUR - 12 : DAY_END_HOUR}{DAY_END_HOUR >= 12 ? " PM" : " AM"}.</div>
    </div>
  );
}

function ScoringNoiseModeSelector({ value, onChange }) {
  const current = SCORING_NOISE_MODES.includes(value) ? value : "normal";
  return (
    <div className="rounded-2xl p-4" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <div className="text-sm font-medium">Scoring noise mode</div>
          <div className="text-xs text-stone-500 mt-0.5">{SCORING_NOISE_MODE_DESCRIPTIONS[current]}</div>
        </div>
        <div className="text-[10px] uppercase tracking-wider text-stone-500 shrink-0">Testing</div>
      </div>
      <div className="grid grid-cols-3 rounded-full p-1 gap-1" style={{ background: "rgba(31, 27, 22, 0.06)" }}>
        {SCORING_NOISE_MODES.map((mode) => {
          const active = current === mode;
          return (
            <button key={mode} onClick={() => onChange(mode)} className="py-2 rounded-full text-xs font-semibold" style={{ background: active ? "#1F1B16" : "transparent", color: active ? "#F4EFE6" : "#1F1B16", transition: "background 0.15s, color 0.15s" }}>
              {SCORING_NOISE_MODE_LABELS[mode]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ToggleRow({ label, description, value, onToggle }) {
  return (
    <button onClick={onToggle} className="w-full rounded-2xl p-4 flex items-center justify-between text-left" style={{ background: "rgba(255, 255, 255, 0.5)", border: "1px solid rgba(31, 27, 22, 0.06)" }}>
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-stone-500 mt-0.5">{description}</div>
      </div>
      <div className="w-11 h-6 rounded-full p-0.5" style={{ background: value ? "#B8543A" : "rgba(31, 27, 22, 0.15)" }}>
        <div className="w-5 h-5 rounded-full bg-white" style={{ transform: value ? "translateX(20px)" : "translateX(0)", transition: "transform 0.15s" }} />
      </div>
    </button>
  );
}

function BottomNav({ view, setView }) {
  return (
    <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-20 px-4 pb-4 pt-2" style={{ background: "linear-gradient(to top, rgba(244,239,230,1) 60%, rgba(244,239,230,0))" }}>
      <div className="max-w-2xl mx-auto rounded-full flex items-center p-1.5 backdrop-blur-md" style={{ background: "rgba(31, 27, 22, 0.92)", boxShadow: "0 8px 32px rgba(31, 27, 22, 0.15)" }}>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = view === item.key;
          return (
            <button key={item.key} onClick={() => setView(item.key)} className="flex-1 flex flex-col items-center gap-0.5 py-2 rounded-full" style={{ background: active ? "#F4EFE6" : "transparent", color: active ? "#1F1B16" : "rgba(244, 239, 230, 0.65)" }}>
              <Icon className="w-4 h-4" strokeWidth={2.2} />
              <span className="text-[10px] font-semibold">{item.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

const ONBOARDING_BASELINE_STEPS = [
  { title: "Allow camera access", body: "Mirror uses your front camera to read facial landmarks. The baseline stays on this device." },
  { title: "Sit centered", body: "Use steady light, keep your full face visible, and start with a natural resting expression." },
  { title: "Capture neutral first", body: "Keep still while the neutral baseline reaches 100%. This is the reference for later movement." },
  { title: "Move softly", body: "Follow each cue with a gentle hold, then relax fully before the next exercise begins." },
];
const ONBOARDING_STARTER_EXERCISES = PROFILE_STARTER_ASSESSMENT_EXERCISES.map((id) => EXERCISES.find((exercise) => exercise.id === id)).filter(Boolean);

const ONBOARDING_STEPS = [
  {
    type: "points",
    tag: "WELCOME",
    title: "Welcome to Mirror",
    body: "A gentle daily companion for facial retraining after Bell's Palsy.",
    accent: "#D4A574",
    points: [
      { icon: Heart, text: "Guided exercises tuned to your symmetry" },
      { icon: BookOpen, text: "Daily mood and recovery journal" },
      { icon: TrendingUp, text: "Progress charts and milestones over time" },
    ],
    author: {
      name: "Ali Mustufa",
      label: "Built by",
      image: "https://iali.in/og-cover.jpg",
      storyUrl: "https://x.com/ialimustufa/status/2052044810173993039?s=20",
      storyLabel: "Read the story",
    },
  },
  {
    type: "points",
    tag: "AI TRACKING",
    title: "Symmetry, measured live",
    body: "Your front camera reads dense facial landmarks on both sides of your face.",
    accent: "#7A8F73",
    points: [
      { icon: Zap, text: "Real-time symmetry score during every movement" },
      { icon: Eye, text: "All processing stays on this device" },
      { icon: Sparkles, text: "Personalized to the baseline you capture" },
    ],
  },
  {
    type: "voice",
    tag: "VOICE CUES",
    title: "Hear every cue",
    body: "Mirror calls out each phase so you can keep your eyes on the camera, not the screen.",
    accent: "#D4A574",
  },
  {
    type: "contrast",
    tag: "APPROACH",
    title: "Slow and intentional wins",
    body: "Forceful contractions can train nerves to fire incorrectly (synkinesis).",
    accent: "#B8543A",
    dont: { label: "Don't", text: "Push for the biggest movement possible — it can reinforce uneven firing." },
    do: { label: "Do", text: "Make small, even movements you can hold without strain. Mirror rewards balance, not size." },
  },
  {
    type: "goal",
    tag: "DAILY GOAL",
    title: "How many sessions a day?",
    body: "Retraining works best with frequent short sessions spread across the day.",
    accent: "#D4A574",
    helper: "You can change this anytime in Progress → Preferences.",
  },
  {
    type: "points",
    tag: "SAFETY",
    title: "Mirror supports, not replaces",
    body: "Mirror is a practice companion — it does not replace medical care.",
    accent: "#7A8F73",
    points: [
      { icon: Heart, text: "Follow your neurologist and physical therapist on your specific protocol" },
      { icon: AlertCircle, text: "Stop any exercise that causes pain or unusual sensation" },
      { icon: Check, text: "Use Mirror to practice between professional sessions" },
    ],
  },
  {
    type: "baseline",
    tag: "BASELINE",
    title: "Capture your starting point",
    body: "Optional but recommended. Mirror uses this to personalize your progress tracking.",
    accent: "#B8543A",
  },
];

function Onboarding({ onDone, dailyGoal, onSetDailyGoal, voiceEnabled, onToggleVoice }) {
  const [step, setStep] = useState(0);
  const s = ONBOARDING_STEPS[step];
  const v = dailyGoal ?? 3;
  const isFirst = step === 0;
  const isLast = step === ONBOARDING_STEPS.length - 1;

  useEffect(() => {
    warmSpeechVoices();
  }, []);

  const playInstructionSound = (text) => {
    primeSpeech(true, { text, volume: 1, preferAudioCue: true });
  };

  const handleVoiceToggle = () => {
    if (voiceEnabled) {
      flushSpeech();
    } else {
      playInstructionSound("Voice cues are on.");
    }
    onToggleVoice?.();
  };
  const handleVoicePreview = () => {
    playInstructionSound("Up next: Eyebrow raise. Raise both eyebrows as if surprised, hold gently, then relax.");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch lg:items-center lg:justify-center lg:p-6" style={{ background: "rgba(12,10,8,0.92)" }}>
      <div className="flex flex-col w-full h-full lg:w-[440px] lg:h-[860px] lg:max-h-[92vh] lg:rounded-3xl lg:overflow-hidden lg:shadow-2xl" style={{ background: "#1F1B16", color: "#F4EFE6" }}>
        <div className="flex items-center justify-between p-4 shrink-0">
          <button
            onClick={() => setStep((n) => Math.max(0, n - 1))}
            disabled={isFirst}
            className="w-10 h-10 rounded-full flex items-center justify-center disabled:opacity-30"
            style={{ background: "rgba(244, 239, 230, 0.1)" }}
            aria-label="Back"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <div className="text-xs opacity-70">Step {step + 1} of {ONBOARDING_STEPS.length}</div>
          <div className="w-10" />
        </div>

        <div className="px-4 pb-3 shrink-0">
          <div className="flex gap-1.5">
            {ONBOARDING_STEPS.map((_, i) => (
              <div key={i} className="h-1 flex-1 rounded-full transition-all duration-300" style={{ background: i <= step ? s.accent : "rgba(244, 239, 230, 0.18)" }} />
            ))}
          </div>
        </div>

        <div className="px-4 pb-3 shrink-0">
          <div className="rounded-2xl p-4 transition-colors duration-300" style={{ background: "rgba(244,239,230,0.06)", borderLeft: `3px solid ${s.accent}` }}>
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] mb-2 inline-block px-2 py-0.5 rounded-full" style={{ background: s.accent, color: "#1F1B16" }}>{s.tag}</div>
            <div className="text-2xl mb-1.5" style={{ fontFamily: "Fraunces", fontWeight: 500, letterSpacing: "-0.02em" }}>{s.title}</div>
            <div className="text-sm leading-relaxed opacity-80">{s.body}</div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {s.type === "points" && (
            <div className="space-y-2.5">
              {s.points.map((p, i) => {
                const Icon = p.icon;
                return (
                  <div key={i} className="rounded-2xl p-3.5 flex items-start gap-3" style={{ background: "rgba(244,239,230,0.04)", border: "1px solid rgba(244,239,230,0.06)" }}>
                    <div className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: `${s.accent}26`, color: s.accent }}>
                      <Icon className="w-4 h-4" />
                    </div>
                    <div className="text-sm leading-relaxed opacity-90 self-center">{p.text}</div>
                  </div>
                );
              })}
              {s.author && (
                <a
                  href={s.author.storyUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="flex items-center gap-3 rounded-2xl p-3 group"
                  style={{ background: "rgba(244,239,230,0.04)", border: "1px solid rgba(244,239,230,0.08)" }}
                >
                  <img
                    src={s.author.image}
                    alt={s.author.name}
                    loading="lazy"
                    className="w-10 h-10 rounded-full object-cover shrink-0"
                    style={{ border: "1px solid rgba(244,239,230,0.15)" }}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-[10px] font-bold uppercase tracking-[0.18em] opacity-55 leading-none mb-0.5">{s.author.label}</div>
                    <div className="text-sm font-semibold truncate">{s.author.name}</div>
                  </div>
                  <div className="text-xs flex items-center gap-1 shrink-0" style={{ color: s.accent }}>
                    {s.author.storyLabel}<ArrowRight className="w-3 h-3" />
                  </div>
                </a>
              )}
            </div>
          )}

          {s.type === "voice" && (
            <div className="space-y-3">
              <div className="rounded-2xl p-4 flex items-center gap-3" style={{ background: "rgba(244,239,230,0.06)", border: `1px solid ${voiceEnabled ? s.accent + "55" : "rgba(244,239,230,0.08)"}` }}>
                <div className="w-11 h-11 rounded-full flex items-center justify-center shrink-0" style={{ background: voiceEnabled ? `${s.accent}33` : "rgba(244,239,230,0.08)", color: voiceEnabled ? s.accent : "#F4EFE6" }}>
                  {voiceEnabled ? <Volume2 className="w-5 h-5" /> : <VolumeX className="w-5 h-5" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold">Voice cues</div>
                  <div className="text-xs opacity-65 mt-0.5">{voiceEnabled ? "Mirror will speak during exercises." : "Mirror will stay silent."}</div>
                </div>
                <button
                  onClick={handleVoiceToggle}
                  className="rounded-full px-3 py-1.5 text-xs font-semibold shrink-0"
                  style={{ background: voiceEnabled ? s.accent : "rgba(244,239,230,0.12)", color: voiceEnabled ? "#1F1B16" : "#F4EFE6" }}
                  aria-pressed={voiceEnabled}
                >
                  {voiceEnabled ? "On" : "Off"}
                </button>
              </div>

              {voiceEnabled && (
                <button onClick={handleVoicePreview} className="w-full rounded-2xl p-3.5 flex items-center justify-center gap-2 text-sm" style={{ background: "rgba(244,239,230,0.04)", border: "1px solid rgba(244,239,230,0.08)", color: "#F4EFE6" }}>
                  <Play className="w-3.5 h-3.5" style={{ color: s.accent }} />
                  Play a sample cue
                </button>
              )}

              <div className="rounded-2xl p-3.5 flex items-start gap-3" style={{ background: "rgba(244,239,230,0.04)", border: "1px solid rgba(244,239,230,0.06)" }}>
                <div className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: "rgba(244,239,230,0.08)" }}>
                  <Info className="w-3.5 h-3.5 opacity-70" />
                </div>
                <div className="text-xs leading-relaxed opacity-75 pt-0.5">
                  You can toggle voice anytime — tap the <Volume2 className="inline w-3 h-3 mx-0.5 align-text-bottom" style={{ color: s.accent }} /> icon in the exercise header.
                </div>
              </div>
            </div>
          )}

          {s.type === "contrast" && (
            <div className="space-y-3">
              <div className="rounded-2xl p-4" style={{ background: "rgba(184,84,58,0.1)", border: "1px solid rgba(184,84,58,0.25)" }}>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] mb-1.5" style={{ color: "#FFB48F" }}>{s.dont.label}</div>
                <div className="text-sm leading-relaxed opacity-90">{s.dont.text}</div>
              </div>
              <div className="rounded-2xl p-4" style={{ background: "rgba(168,195,159,0.12)", border: "1px solid rgba(168,195,159,0.3)" }}>
                <div className="text-[10px] font-bold uppercase tracking-[0.18em] mb-1.5" style={{ color: "#A8C39F" }}>{s.do.label}</div>
                <div className="text-sm leading-relaxed opacity-90">{s.do.text}</div>
              </div>
            </div>
          )}

          {s.type === "goal" && (
            <div>
              <div className="rounded-2xl p-5 mb-3" style={{ background: "rgba(244,239,230,0.04)", border: "1px solid rgba(244,239,230,0.06)" }}>
                <div className="flex flex-wrap justify-center gap-2 mb-3">
                  {[1, 2, 3, 4, 5, 6].map((n) => {
                    const active = v === n;
                    return (
                      <button key={n} onClick={() => onSetDailyGoal(n)} className="w-12 h-12 rounded-full text-lg font-semibold tabular-nums transition-all" style={{ background: active ? s.accent : "rgba(244, 239, 230, 0.08)", color: active ? "#1F1B16" : "#F4EFE6", border: active ? "none" : "1px solid rgba(244, 239, 230, 0.2)" }}>
                        {n}
                      </button>
                    );
                  })}
                </div>
                <div className="text-center text-xs opacity-65">{v} session{v === 1 ? "" : "s"} per day · spread between 9 AM and 9 PM</div>
              </div>
              <div className="text-xs opacity-55 text-center leading-relaxed">{s.helper}</div>
            </div>
          )}

          {s.type === "baseline" && (
            <div className="space-y-3">
              <div className="rounded-2xl p-4" style={{ background: "rgba(244,239,230,0.06)", border: "1px solid rgba(244,239,230,0.08)" }}>
                <div className="flex items-center gap-1.5 mb-3">
                  <div className="text-xs uppercase tracking-wider opacity-60">Starter assessment set</div>
                  <div className="relative group flex items-center" tabIndex={0} aria-label="Starter assessment set explanation">
                    <Info className="w-3.5 h-3.5 opacity-60" />
                    <div className="absolute left-0 bottom-full z-10 mb-2 hidden w-64 rounded-2xl px-3 py-2 text-left text-xs leading-relaxed normal-case tracking-normal shadow-xl group-hover:block group-focus:block" style={{ background: "#F4EFE6", color: "#1F1B16" }}>
                      Mirror captures a shorter starter set now, then prompts for the remaining movement baselines later.
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-7 gap-2">
                  {ONBOARDING_STARTER_EXERCISES.map((exercise) => <ExerciseGlyph key={exercise.id} exercise={exercise} size="xs" tone="dark" className="mx-auto" />)}
                </div>
                <div className="text-xs opacity-55 mt-3">{ONBOARDING_STARTER_EXERCISES.length} movements · about {Math.ceil(ONBOARDING_STARTER_EXERCISES.length * (PROFILE_REST_SEC + PROFILE_HOLD_SEC) / 60)} minutes</div>
              </div>

              <div className="rounded-2xl p-4" style={{ background: "rgba(244,239,230,0.06)", border: "1px solid rgba(244,239,230,0.08)" }}>
                <div className="flex items-center gap-2 mb-3">
                  <Info className="w-4 h-4" style={{ color: s.accent }} />
                  <div className="text-xs uppercase tracking-wider opacity-60">What to expect</div>
                </div>
                <div className="space-y-3">
                  {ONBOARDING_BASELINE_STEPS.map((item, index) => (
                    <div key={item.title} className="flex items-start gap-3">
                      <div className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 text-[10px] font-semibold mt-0.5" style={{ background: "rgba(244,239,230,0.1)", color: "#F4EFE6" }}>{index + 1}</div>
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

        <div className="p-4 shrink-0">
          {isLast ? (
            <div className="flex gap-3">
              <button onClick={() => onDone(false)} className="flex-1 rounded-full py-3.5 font-semibold" style={{ background: "rgba(244,239,230,0.12)", color: "#F4EFE6" }}>Skip for now</button>
              <button onClick={() => onDone(true)} className="flex-1 rounded-full py-3.5 font-semibold" style={{ background: s.accent, color: "#1F1B16" }}>Create baseline</button>
            </div>
          ) : (
            <button onClick={() => setStep((n) => n + 1)} className="w-full rounded-full py-3.5 font-semibold flex items-center justify-center gap-2" style={{ background: s.accent, color: "#1F1B16" }}>
              Continue
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export {
  BottomNav,
  BaselineView,
  ExerciseAnimation,
  ExerciseDetail,
  ExerciseGlyph,
  Header,
  HomeView,
  InterstitialView,
  JournalPrompt,
  JournalView,
  LiveExercisePreview,
  Onboarding,
  PracticeView,
  PreviewView,
  ProgressView,
  RealtimeFeedback,
  SessionSummary,
  Sidebar,
  TrackerStatusPill,
};
