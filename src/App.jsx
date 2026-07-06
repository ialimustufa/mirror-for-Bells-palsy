import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { archiveMovementProfile, mergeMissingMovementProfileBaselines, mergeMovementProfileRetake, needsAppDataMigration, normalizeAppData, resetMovementProfileBaselines } from "./domain/appData";
import { PROFILE_HISTORY_LIMIT } from "./domain/config";
import { ASSESSMENT_SESSION_KIND, appendAssessmentRecord, buildStandardAssessmentExercises, summarizeAssessmentSession } from "./domain/assessment";
import { buildClinicianBundleRecords, createClinicianBundleExportBlob } from "./domain/clinicianBundle";
import { EXERCISE_BY_ID } from "./domain/exercises";
import { trainPersonalRecoveryModel } from "./domain/personalRecoveryModel";
import { buildValidationDatasetRecords, createValidationDatasetExportBlob } from "./domain/validationDataset";
import {
  DEFAULT_DATA,
  DEFAULT_PERSONAL_PLAN,
  appendSessionRecord,
  buildSessionExercises,
  computeStreak,
  getComfortDosing,
  isCountedSession,
  recordDateISO,
  todayISO,
} from "./domain/session";
import { compactAppDataForStorage, createMirrorBrowserDataExportBlob, deleteSessionFrameSamples, deleteSessionImages, exportMirrorBrowserData, hydrateSessionImages, importMirrorBrowserData, loadMirrorData, parseMirrorBrowserDataFile, saveMirrorData } from "./storage";
import { buildPersonalizedDailyPlan, orderExerciseIdsByRegion } from "./ml/faceMetrics";
import { primeSpeech } from "./lib/speech";
import { SessionMode } from "./session/SessionMode";
import { ProfileAssessment } from "./profile/ProfileAssessment";
import { TrialMode } from "./trial/TrialMode";
import { MadeByFooter } from "./components/MadeByFooter";
import {
  BaselineView,
  BottomNav,
  ExerciseDetail,
  Header,
  HomeView,
  JournalPrompt,
  JournalView,
  Onboarding,
  PracticeView,
  ProgressView,
  SessionSummary,
  Sidebar,
} from "./components/appViews";

function withPersonalRecoveryModel(next) {
  if (next?.prefs?.personalModelEnabled === false) return { ...next, personalRecoveryModel: null };
  return {
    ...next,
    personalRecoveryModel: trainPersonalRecoveryModel({
      sessions: next?.sessions ?? [],
      movementProfile: next?.movementProfile ?? null,
    }),
  };
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function App() {
  // Top-level orchestration only: global persistence, view routing, and modal/session ownership.
  // Feature views own their local form/filter state.
  const [view, setView] = useState("home");
  const [data, setData] = useState(DEFAULT_DATA);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [profileAssessment, setProfileAssessment] = useState(null);
  const [exerciseDetail, setExerciseDetail] = useState(null);
  const [viewingReport, setViewingReport] = useState(null);
  const [journalPrompt, setJournalPrompt] = useState(null);
  const [dataTransferStatus, setDataTransferStatus] = useState(null);
  const dataRef = useRef(DEFAULT_DATA);
  const persistQueueRef = useRef(Promise.resolve());
  const persistSeqRef = useRef(0);
  // Path-based route for the public /try demo. Listening to popstate covers the
  // history-driven nav back from the trial page; the rest of the app remains state-routed.
  const [pathname, setPathname] = useState(() => (typeof window !== "undefined" ? window.location.pathname : "/"));
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const stored = await loadMirrorData();
        if (stored) {
          const shouldPersistMigration = needsAppDataMigration(stored);
          const normalized = withPersonalRecoveryModel(normalizeAppData(stored));
          setData(normalized);
          if (shouldPersistMigration) {
            try {
              const saved = await saveMirrorData(normalized);
              setData(withPersonalRecoveryModel(normalizeAppData(saved)));
            } catch (error) {
              console.error("Failed to persist app data migration", error);
            }
          }
          if (!normalized.prefs?.onboarded) setShowOnboarding(true);
        } else { setShowOnboarding(true); }
      } catch { setShowOnboarding(true); }
      finally { setLoading(false); }
    })();
  }, []);

  useEffect(() => {
    const link = document.createElement("link");
    link.href = "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;0,9..144,700;1,9..144,400&family=Manrope:wght@400;500;600;700&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);
    return () => { try { document.head.removeChild(link); } catch { /* font link may have been removed externally */ } };
  }, []);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  const persist = useCallback((nextOrUpdater) => {
    const next = typeof nextOrUpdater === "function" ? nextOrUpdater(dataRef.current) : nextOrUpdater;
    const seq = persistSeqRef.current + 1;
    persistSeqRef.current = seq;
    const compactNext = compactAppDataForStorage(next);
    dataRef.current = compactNext;
    setData(compactNext);

    const write = async () => {
      try {
        const saved = await saveMirrorData(next);
        if (seq === persistSeqRef.current) {
          const normalized = normalizeAppData(saved);
          dataRef.current = normalized;
          setData(normalized);
        }
      } catch (e) {
        console.error("Failed to persist app data", e);
      }
    };
    const queued = persistQueueRef.current.then(write, write);
    persistQueueRef.current = queued;
    return queued;
  }, []);

  const openStoredReport = useCallback(async (sessionRecord) => {
    const hydrated = await hydrateSessionImages(sessionRecord);
    setViewingReport(hydrated);
  }, []);

  const finishOnboarding = (startProfile = false) => {
    persist({ ...data, prefs: { ...data.prefs, onboarded: true } });
    setShowOnboarding(false);
    if (startProfile) setProfileAssessment({});
  };
  const openProfileAssessment = (retakeExerciseIds = null) => {
    setProfileAssessment(retakeExerciseIds?.length ? { retakeExerciseIds } : {});
  };
  const requestProfileRetake = useCallback((retakeExerciseIds, context = {}) => {
    setSession(null);
    setProfileAssessment(retakeExerciseIds?.length ? { retakeExerciseIds, context } : {});
  }, []);
  const saveMovementProfile = (profile, options = {}) => {
    if (options.retakeExerciseIds?.length && data.movementProfile) {
      const movementProfile = mergeMovementProfileRetake(data.movementProfile, profile);
      const initialMovementProfile = mergeMissingMovementProfileBaselines(data.initialMovementProfile ?? data.movementProfile, profile, options.retakeExerciseIds);
      persist(withPersonalRecoveryModel({ ...data, movementProfile, initialMovementProfile, prefs: { ...data.prefs, onboarded: true } }));
      setProfileAssessment(null);
      return;
    }
    const archived = archiveMovementProfile(data.movementProfile);
    const movementProfileHistory = archived
      ? [archived, ...(data.movementProfileHistory ?? [])].slice(0, PROFILE_HISTORY_LIMIT)
      : (data.movementProfileHistory ?? []);
    persist(withPersonalRecoveryModel({ ...data, movementProfile: profile, initialMovementProfile: data.initialMovementProfile ?? profile, movementProfileHistory, prefs: { ...data.prefs, onboarded: true } }));
    setProfileAssessment(null);
  };
  const startSession = (ids, repCounts = {}) => {
    const exercises = buildSessionExercises(ids, data.movementProfile, repCounts);
    const firstExercise = exercises[0];
    const openingCue = data.prefs.symmetryEnabled && data.prefs.mirrorEnabled
      ? "Calibration. Center your face and stay relaxed."
      : firstExercise
        ? `Up next: ${firstExercise.name}. ${firstExercise.instruction}`
        : "Voice guidance ready.";
    primeSpeech(data.prefs.voiceEnabled, { text: openingCue, volume: 1 });
    const kind = ids.length > 1 ? "session" : "practice";
    setSession({ exercises, kind, startedAt: Date.now(), comfortLevel: getComfortDosing(data.movementProfile).key });
  };
  const startAssessment = () => {
    const exercises = buildStandardAssessmentExercises(data.movementProfile);
    const firstExercise = exercises[0];
    primeSpeech(data.prefs.voiceEnabled, {
      text: firstExercise ? `Standard assessment. Up next: ${firstExercise.name}.` : "Standard assessment ready.",
      volume: 1,
    });
    setSession({
      exercises,
      kind: ASSESSMENT_SESSION_KIND,
      assessmentKind: "standard-assessment",
      startedAt: Date.now(),
      comfortLevel: getComfortDosing(data.movementProfile).key,
    });
  };
  const completeSession = (rec) => {
    let shouldPromptJournal = false;
    persist((currentData) => {
      const existingCountedSessionsToday = currentData.sessions.filter((s) => s.date === rec.date && isCountedSession(s)).length;
      shouldPromptJournal = isCountedSession(rec)
        && existingCountedSessionsToday === 0
        && !currentData.journal.some((entry) => entry.date === rec.date);
      const withSession = appendSessionRecord(currentData, rec);
      const withAssessment = rec.kind === ASSESSMENT_SESSION_KIND
        ? appendAssessmentRecord(withSession, summarizeAssessmentSession(rec))
        : withSession;
      return withPersonalRecoveryModel(withAssessment);
    });
    setSession(null);
    if (shouldPromptJournal) setJournalPrompt({ session: rec });
  };
  const deleteSession = useCallback(async (session) => {
    if (!session) return;
    const id = session.id;
    const ts = session.ts;
    const sessions = data.sessions.filter((s) => {
      if (s === session) return false;
      if (id && s.id === id) return false;
      if (!id && ts && s.ts === ts && s.date === session.date) return false;
      return true;
    });
    if (sessions.length === data.sessions.length) return;
    await persist(withPersonalRecoveryModel({ ...data, sessions }));
    if (id) deleteSessionImages(id);
    if (id) deleteSessionFrameSamples(id);
  }, [data, persist]);
  const saveJournal = (entry) => { const filtered = data.journal.filter((j) => j.date !== entry.date); persist({ ...data, journal: [...filtered, entry].sort((a, b) => a.date.localeCompare(b.date)) }); };
  const togglePref = (key) => {
    const next = { ...data, prefs: { ...data.prefs, [key]: !data.prefs[key] } };
    persist(key === "personalModelEnabled" ? withPersonalRecoveryModel(next) : next);
  };
  const setPref = (key, value) => {
    const next = { ...data, prefs: { ...data.prefs, [key]: value } };
    persist(key === "personalModelEnabled" ? withPersonalRecoveryModel(next) : next);
  };

  const streak = useMemo(() => computeStreak(data.sessions), [data.sessions]);
  const recommendedPlanIds = useMemo(
    () => buildPersonalizedDailyPlan(data.movementProfile, data.sessions, undefined, { journal: data.journal, orderByRegion: true }),
    [data.movementProfile, data.sessions, data.journal],
  );
  const personalizedPlanIds = useMemo(
    () => buildPersonalizedDailyPlan(data.movementProfile, data.sessions, undefined, { journal: data.journal, personalPlan: data.prefs.personalPlan, orderByRegion: true }),
    [data.movementProfile, data.sessions, data.journal, data.prefs.personalPlan],
  );
  const savePersonalPlan = useCallback((selectedExerciseIds, repeatCounts = {}, repCounts = {}) => {
    const selected = orderExerciseIdsByRegion([...new Set(selectedExerciseIds ?? [])].filter((id) => EXERCISE_BY_ID.has(id)), recommendedPlanIds);
    if (selected.length === 0) return false;
    const selectedSet = new Set(selected);
    const recommendedSet = new Set(recommendedPlanIds);
    // Keep only repeat counts for exercises still in the plan; normalizePersonalPlan
    // drops counts <= 1 and clamps to the UI ceiling on the next load.
    const planRepeatCounts = {};
    for (const [id, count] of Object.entries(repeatCounts ?? {})) {
      if (selectedSet.has(id) && count > 1) planRepeatCounts[id] = count;
    }
    const planRepCounts = {};
    for (const [id, count] of Object.entries(repCounts ?? {})) {
      const n = Math.round(Number(count));
      if (selectedSet.has(id) && Number.isFinite(n) && n > 0) planRepCounts[id] = n;
    }
    const personalPlan = {
      selectedExerciseIds: selected,
      addedExerciseIds: selected.filter((id) => !recommendedSet.has(id)),
      removedExerciseIds: recommendedPlanIds.filter((id) => !selectedSet.has(id)),
      repeatCounts: planRepeatCounts,
      repCounts: planRepCounts,
    };
    persist((currentData) => ({ ...currentData, prefs: { ...currentData.prefs, personalPlan } }));
    return true;
  }, [persist, recommendedPlanIds]);
  const resetPersonalPlan = useCallback(() => {
    persist((currentData) => ({ ...currentData, prefs: { ...currentData.prefs, personalPlan: DEFAULT_PERSONAL_PLAN } }));
  }, [persist]);
  const resetMovementBaselines = useCallback((exerciseIds) => {
    const ids = [...new Set((exerciseIds ?? []).filter((id) => EXERCISE_BY_ID.has(id)))];
    if (!ids.length || !data.movementProfile) return;
    persist(withPersonalRecoveryModel({
      ...data,
      movementProfile: resetMovementProfileBaselines(data.movementProfile, ids),
      initialMovementProfile: resetMovementProfileBaselines(data.initialMovementProfile, ids),
    }));
  }, [data, persist]);
  const exportBrowserData = useCallback(async () => {
    setDataTransferStatus({ kind: "working", message: "Preparing browser data export..." });
    try {
      await persistQueueRef.current.catch(() => {});
      const payload = await exportMirrorBrowserData();
      const blob = createMirrorBrowserDataExportBlob(payload);
      const filename = `mirror-browser-data-${todayISO()}.jsonl`;
      downloadFile(blob, filename);
      setDataTransferStatus({ kind: "success", message: `Exported ${payload.summary?.sessions ?? 0} sessions.` });
    } catch (error) {
      console.error("Failed to export browser data", error);
      setDataTransferStatus({ kind: "error", message: "Could not export browser data." });
    }
  }, []);
  const exportClinicianBundle = useCallback(async () => {
    setDataTransferStatus({ kind: "working", message: "Preparing clinician bundle..." });
    try {
      await persistQueueRef.current.catch(() => {});
      const payload = await exportMirrorBrowserData();
      const records = buildClinicianBundleRecords(payload);
      const blob = createClinicianBundleExportBlob(records);
      const filename = `mirror-clinician-bundle-${todayISO()}.jsonl`;
      downloadFile(blob, filename);
      setDataTransferStatus({ kind: "success", message: `Exported clinician bundle with ${records[0]?.summary?.sessions ?? 0} sessions.` });
    } catch (error) {
      console.error("Failed to export clinician bundle", error);
      setDataTransferStatus({ kind: "error", message: "Could not export clinician bundle." });
    }
  }, []);
  const exportValidationDataset = useCallback(async () => {
    setDataTransferStatus({ kind: "working", message: "Preparing validation dataset..." });
    try {
      await persistQueueRef.current.catch(() => {});
      const payload = await exportMirrorBrowserData();
      const records = buildValidationDatasetRecords(payload);
      const sampleCount = records[0]?.summary?.frameSamples ?? 0;
      const clinicalScaleAssessmentCount = records[0]?.summary?.assessmentClinicalScaleRecords ?? 0;
      if (!sampleCount && !clinicalScaleAssessmentCount) {
        setDataTransferStatus({ kind: "success", message: "No local frame samples or standard assessment rows to export. Turn on Local data capture before a session, or complete a standard assessment." });
        return;
      }
      const blob = createValidationDatasetExportBlob(records);
      const filename = `mirror-validation-dataset-${todayISO()}.jsonl`;
      downloadFile(blob, filename);
      setDataTransferStatus({ kind: "success", message: `Exported validation dataset with ${sampleCount} frame samples and ${clinicalScaleAssessmentCount} clinical-scale assessment rows.` });
    } catch (error) {
      console.error("Failed to export validation dataset", error);
      setDataTransferStatus({ kind: "error", message: "Could not export validation dataset." });
    }
  }, []);
  const importBrowserData = useCallback(async (file) => {
    if (!file) return;
    setDataTransferStatus({ kind: "working", message: "Importing browser data..." });
    try {
      await persistQueueRef.current.catch(() => {});
      const parsed = await parseMirrorBrowserDataFile(file);
      const imported = await importMirrorBrowserData(parsed);
      const normalized = withPersonalRecoveryModel(normalizeAppData(imported));
      persistSeqRef.current += 1;
      dataRef.current = normalized;
      setData(normalized);
      setSession(null);
      setProfileAssessment(null);
      setExerciseDetail(null);
      setViewingReport(null);
      setJournalPrompt(null);
      setShowOnboarding(!normalized.prefs?.onboarded);
      setDataTransferStatus({ kind: "success", message: `Imported ${normalized.sessions.length} sessions.` });
    } catch (error) {
      console.error("Failed to import browser data", error);
      setDataTransferStatus({
        kind: "error",
        message: error instanceof SyntaxError
          ? "Choose a valid JSON export file."
          : error?.message ?? "Could not import browser data.",
      });
    }
  }, []);

  if (pathname === "/try") return <TrialMode prefs={data.prefs} />;
  if (loading) return <div className="min-h-screen flex items-center justify-center" style={{ background: "#F4EFE6" }}><div className="text-stone-600">Loading…</div></div>;

  return (
    <div className="min-h-screen relative lg:pl-20" style={{ background: "#F4EFE6", fontFamily: "Manrope, system-ui, sans-serif", color: "#1F1B16" }}>
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full blur-3xl opacity-30" style={{ background: "#D4A574" }} />
        <div className="absolute top-1/2 -left-32 w-80 h-80 rounded-full blur-3xl opacity-20" style={{ background: "#7A8F73" }} />
      </div>
      <Sidebar view={view} setView={setView} streak={streak} />
      <div className="relative max-w-2xl mx-auto px-5 pb-28 pt-8 lg:pb-12">
        <Header view={view} streak={streak} />
        <main className="mt-8 lg:mt-2">
          {view === "home" && <HomeView data={data} streak={streak} personalizedPlanIds={personalizedPlanIds} recommendedPlanIds={recommendedPlanIds} onStartProfile={openProfileAssessment} onStartSession={startSession} onStartAssessment={startAssessment} onGo={setView} onResetPersonalPlan={resetPersonalPlan} />}
          {view === "practice" && <PracticeView movementProfile={data.movementProfile} sessions={data.sessions} personalizedPlanIds={personalizedPlanIds} recommendedPlanIds={recommendedPlanIds} savedRepeatCounts={data.prefs.personalPlan?.repeatCounts} savedRepCounts={data.prefs.personalPlan?.repCounts} onStartSession={startSession} onShowDetail={setExerciseDetail} onSavePersonalPlan={savePersonalPlan} onResetPersonalPlan={resetPersonalPlan} />}
          {view === "baseline" && <BaselineView data={data} onStartProfile={openProfileAssessment} onResetBaselines={resetMovementBaselines} />}
          {view === "journal" && <JournalView entries={data.journal} onSave={saveJournal} />}
          {view === "progress" && <ProgressView data={data} streak={streak} prefs={data.prefs} dataTransferStatus={dataTransferStatus} onTogglePref={togglePref} onSetPref={setPref} onOpenReport={openStoredReport} onDeleteSession={deleteSession} onExportData={exportBrowserData} onExportClinicianBundle={exportClinicianBundle} onExportValidationDataset={exportValidationDataset} onImportData={importBrowserData} />}
        </main>
        <footer className="mt-10 text-center text-xs text-stone-500">
          <MadeByFooter />
        </footer>
      </div>
      <BottomNav view={view} setView={setView} />
      {session && <SessionMode session={session} prefs={data.prefs} movementProfile={data.movementProfile} initialMovementProfile={data.initialMovementProfile ?? data.movementProfile} sessionsToday={data.sessions.filter((s) => recordDateISO(s) === todayISO() && isCountedSession(s)).length} onComplete={completeSession} onCancel={() => setSession(null)} onTogglePref={togglePref} onRequestProfileRetake={requestProfileRetake} />}
      {exerciseDetail && <ExerciseDetail exercise={exerciseDetail} movementProfile={data.movementProfile} onClose={() => setExerciseDetail(null)} onStart={(id) => { setExerciseDetail(null); startSession([id]); }} />}
      {showOnboarding && <Onboarding onDone={finishOnboarding} dailyGoal={data.prefs.dailyGoal} onSetDailyGoal={(n) => setPref("dailyGoal", n)} voiceEnabled={data.prefs.voiceEnabled} onToggleVoice={() => togglePref("voiceEnabled")} />}
      {profileAssessment && <ProfileAssessment existingProfile={data.movementProfile} retakeExerciseIds={profileAssessment.retakeExerciseIds} prefs={data.prefs} onTogglePref={togglePref} onComplete={saveMovementProfile} onSkip={() => setProfileAssessment(null)} />}
      {viewingReport && <SessionSummary session={viewingReport} prefs={data.prefs} onClose={() => setViewingReport(null)} />}
      {journalPrompt && (
        <JournalPrompt
          session={journalPrompt.session}
          onSave={(entry) => { saveJournal(entry); setJournalPrompt(null); }}
          onSkip={() => setJournalPrompt(null)}
        />
      )}
    </div>
  );
}
