import { MEDIA_RETENTION_SESSIONS } from "./domain/config";

const DB_NAME = "mirror-db";
const DB_VERSION = 3;
const APP_STATE_STORE = "appState";
const SESSIONS_STORE = "sessions";
const SESSION_IMAGES_STORE = "sessionImages";
// Legacy store: one record per captured frame. Superseded by SESSION_FRAME_ARCHIVE_STORE
// (one gzip blob per session). Kept in the schema only so legacy rows can be migrated/cleared.
const SESSION_FRAME_SAMPLES_STORE = "sessionFrameSamples";
const SESSION_FRAME_ARCHIVE_STORE = "sessionFrameArchive";
// Above this many legacy per-frame rows we drop rather than migrate: reading them all
// into memory to re-pack risks the very OOM this change is meant to avoid. They are
// opt-in debug samples, so reclaiming the space wins.
const LEGACY_FRAME_MIGRATION_LIMIT = 8000;
const APP_STATE_ID = "state";
const SCHEMA_VERSION = 1;
const LEGACY_STORAGE_KEY = "mirror-app-data";
const EXPORT_KIND = "mirror-browser-data";
const EXPORT_LINES_KIND = "mirror-browser-data-lines";
const EXPORT_VERSION = 1;
const EXPORT_APP_ID = "mirror-bells-palsy";

let dbPromise = null;

function hasIndexedDb() {
  return typeof indexedDB !== "undefined";
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function ensureIndex(store, name, keyPath) {
  if (!store.indexNames.contains(name)) store.createIndex(name, keyPath, { unique: false });
}

function openMirrorDb() {
  if (!hasIndexedDb()) return Promise.reject(new Error("IndexedDB is not available"));
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const tx = request.transaction;

      if (!db.objectStoreNames.contains(APP_STATE_STORE)) {
        db.createObjectStore(APP_STATE_STORE, { keyPath: "id" });
      }

      const sessionsStore = db.objectStoreNames.contains(SESSIONS_STORE)
        ? tx.objectStore(SESSIONS_STORE)
        : db.createObjectStore(SESSIONS_STORE, { keyPath: "id" });
      ensureIndex(sessionsStore, "date", "date");
      ensureIndex(sessionsStore, "ts", "ts");
      ensureIndex(sessionsStore, "updatedAt", "updatedAt");

      const imagesStore = db.objectStoreNames.contains(SESSION_IMAGES_STORE)
        ? tx.objectStore(SESSION_IMAGES_STORE)
        : db.createObjectStore(SESSION_IMAGES_STORE, { keyPath: "id" });
      ensureIndex(imagesStore, "sessionId", "sessionId");
      ensureIndex(imagesStore, "exerciseId", "exerciseId");
      ensureIndex(imagesStore, "role", "role");

      const frameSamplesStore = db.objectStoreNames.contains(SESSION_FRAME_SAMPLES_STORE)
        ? tx.objectStore(SESSION_FRAME_SAMPLES_STORE)
        : db.createObjectStore(SESSION_FRAME_SAMPLES_STORE, { keyPath: "id" });
      ensureIndex(frameSamplesStore, "sessionId", "sessionId");
      ensureIndex(frameSamplesStore, "exerciseId", "exerciseId");
      ensureIndex(frameSamplesStore, "phase", "phase");
      ensureIndex(frameSamplesStore, "ts", "ts");

      if (!db.objectStoreNames.contains(SESSION_FRAME_ARCHIVE_STORE)) {
        db.createObjectStore(SESSION_FRAME_ARCHIVE_STORE, { keyPath: "sessionId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error("IndexedDB upgrade was blocked"));
    };
  });

  return dbPromise;
}

function createRecordId(prefix) {
  const value = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${value}`;
}

function imageRecordId(sessionId, role, scoreIndex, repIndex = "base") {
  return `${sessionId}:${role}:${scoreIndex}:${repIndex}`;
}

function snapshotCountForStorage(score) {
  if (Array.isArray(score?.snapshots)) return score.snapshots.length;
  return Number.isFinite(score?.snapshotCount) ? score.snapshotCount : 0;
}

function compactExerciseScoreForStorage(score) {
  if (!score || typeof score !== "object") return score;
  const compactScore = { ...score };
  const baselineSnapshot = compactScore.baselineSnapshot;
  delete compactScore.baselineSnapshot;
  delete compactScore.snapshots;
  const snapshotCount = snapshotCountForStorage(score);
  if (snapshotCount > 0) compactScore.snapshotCount = snapshotCount;
  if (baselineSnapshot || score.hasBaselineSnapshot) compactScore.hasBaselineSnapshot = true;
  return compactScore;
}

function compactSessionForStorage(session) {
  if (!session || typeof session !== "object") return session;
  const { baselineSnapshot, frameSamples, scores, ...compactSession } = session;
  if (Array.isArray(scores)) compactSession.scores = scores.map(compactExerciseScoreForStorage);
  else if (scores !== undefined) compactSession.scores = scores;

  const snapshotCount = Array.isArray(scores)
    ? scores.reduce((sum, score) => sum + snapshotCountForStorage(score), 0)
    : Number.isFinite(session.snapshotCount) ? session.snapshotCount : 0;
  if (snapshotCount > 0) compactSession.snapshotCount = snapshotCount;
  if (baselineSnapshot || session.hasBaselineSnapshot) compactSession.hasBaselineSnapshot = true;
  const frameSampleCount = Array.isArray(frameSamples) ? frameSamples.length : session.frameSampleCount;
  if (Number.isFinite(frameSampleCount) && frameSampleCount > 0) compactSession.frameSampleCount = frameSampleCount;
  return compactSession;
}

export function compactAppDataForStorage(next = {}) {
  return {
    ...next,
    sessions: Array.isArray(next.sessions) ? next.sessions.map(compactSessionForStorage) : [],
  };
}

function parseDataUrlMime(dataUrl) {
  const match = /^data:([^;,]+)[;,]/.exec(dataUrl);
  return match?.[1] ?? "image/jpeg";
}

async function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) return null;
  const response = await fetch(dataUrl);
  return response.blob();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function makeImageRecord({ id, sessionId, exerciseId, role, scoreIndex, repIndex = null, score = null, ts = null, dataUrl, now }) {
  const blob = await dataUrlToBlob(dataUrl);
  if (!blob) return null;
  return {
    id,
    sessionId,
    exerciseId: exerciseId ?? "",
    role,
    scoreIndex,
    repIndex,
    score,
    ts,
    mime: parseDataUrlMime(dataUrl),
    blob,
    createdAt: now,
    updatedAt: now,
    syncStatus: "local",
  };
}

function makeFrameSampleRecord({ sessionId, sample, index, now }) {
  if (!sample || typeof sample !== "object") return null;
  return {
    ...sample,
    id: `${sessionId}:frame:${index}`,
    sessionId,
    exerciseId: sample.exerciseId ?? "",
    phase: sample.phase ?? "",
    ts: sample.ts ?? now,
    sampleIndex: index,
    createdAt: now,
    updatedAt: now,
    syncStatus: "local",
  };
}

const supportsCompressionStreams = () =>
  typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";

// Pack an array of frame-sample records into a single gzip Blob (falls back to
// uncompressed JSON where CompressionStream is unavailable). Returns null for empty input.
// Exported for round-trip testing.
export async function packFrameArchive(sessionId, frames, now) {
  if (!sessionId || !Array.isArray(frames) || frames.length === 0) return null;
  const json = JSON.stringify(frames);
  let blob;
  let encoding;
  if (supportsCompressionStreams()) {
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("gzip"));
    blob = await new Response(stream).blob();
    encoding = "gzip";
  } else {
    blob = new Blob([json], { type: "application/json" });
    encoding = "json";
  }
  return {
    sessionId,
    count: frames.length,
    encoding,
    blob,
    createdAt: now,
    updatedAt: now,
    syncStatus: "local",
  };
}

// Reverse of packFrameArchive: yields the flat frame-sample record array so the
// export/summary paths see the same shape they did before archiving.
export async function unpackFrameArchive(record) {
  const blob = record?.blob;
  if (!blob) return [];
  try {
    let text;
    if (record.encoding === "gzip" && typeof DecompressionStream !== "undefined") {
      const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
      text = await new Response(stream).text();
    } else {
      text = await blob.text();
    }
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Failed to read frame archive", record?.sessionId, error);
    return [];
  }
}

// Group prepared flat frame records by session and pack each group into one archive record.
async function packFrameArchives(frameSamples, now) {
  const bySession = new Map();
  for (const sample of frameSamples ?? []) {
    if (!sample?.sessionId) continue;
    const group = bySession.get(sample.sessionId) ?? [];
    group.push(sample);
    bySession.set(sample.sessionId, group);
  }
  const archives = [];
  for (const [sessionId, frames] of bySession) {
    const archive = await packFrameArchive(sessionId, frames, now);
    if (archive) archives.push(archive);
  }
  return archives;
}

// Retention: drop heavy media (image refs + counts) from all but the most recent
// sessions. Scores/metrics are untouched. Mutates the compact session records in
// place (they are shared with the app-facing `data`) and returns the evicted ids.
// Exported for testing.
export function applyMediaRetention(sessions) {
  const evictedMediaSessionIds = [];
  if (!Array.isArray(sessions) || !Number.isFinite(MEDIA_RETENTION_SESSIONS) || MEDIA_RETENTION_SESSIONS <= 0) {
    return evictedMediaSessionIds;
  }
  const keepIds = new Set(
    [...sessions]
      .sort((a, b) => (b?.ts ?? b?.createdAt ?? 0) - (a?.ts ?? a?.createdAt ?? 0))
      .slice(0, MEDIA_RETENTION_SESSIONS)
      .map((session) => session?.id)
      .filter(Boolean),
  );
  for (const session of sessions) {
    if (!session?.id || keepIds.has(session.id)) continue;
    const hadMedia = session.baselineImageId || session.hasBaselineSnapshot || session.imageCount
      || session.snapshotCount || session.frameSampleCount
      || (Array.isArray(session.scores) && session.scores.some((score) => score?.baselineImageId || score?.snapshotRefs?.length));
    if (!hadMedia) continue;
    delete session.baselineImageId;
    delete session.hasBaselineSnapshot;
    delete session.imageCount;
    delete session.snapshotCount;
    delete session.frameSampleCount;
    if (Array.isArray(session.scores)) {
      session.scores = session.scores.map((score) => {
        if (!score || typeof score !== "object") return score;
        const stripped = { ...score };
        delete stripped.baselineImageId;
        delete stripped.snapshotRefs;
        delete stripped.snapshotCount;
        delete stripped.hasBaselineSnapshot;
        return stripped;
      });
    }
    evictedMediaSessionIds.push(session.id);
  }
  return evictedMediaSessionIds;
}

async function prepareScoreForIndexedDb(score, sessionId, scoreIndex, now) {
  const compactScore = compactExerciseScoreForStorage(score) ?? {};
  const images = [];
  const exerciseId = score?.exerciseId ?? "";

  if (typeof score?.baselineSnapshot === "string") {
    const baselineImageId = imageRecordId(sessionId, "baseline", scoreIndex);
    const image = await makeImageRecord({
      id: baselineImageId,
      sessionId,
      exerciseId,
      role: "baseline",
      scoreIndex,
      dataUrl: score.baselineSnapshot,
      now,
    });
    if (image) {
      images.push(image);
      compactScore.baselineImageId = baselineImageId;
      compactScore.hasBaselineSnapshot = true;
    }
  }

  const snapshotRefs = [];
  if (Array.isArray(score?.snapshots)) {
    for (const [repIndex, snap] of score.snapshots.entries()) {
      if (typeof snap?.dataUrl !== "string") continue;
      const id = imageRecordId(sessionId, "rep", scoreIndex, repIndex);
      const image = await makeImageRecord({
        id,
        sessionId,
        exerciseId,
        role: "rep",
        scoreIndex,
        repIndex,
        score: snap.score ?? null,
        ts: snap.ts ?? now,
        dataUrl: snap.dataUrl,
        now,
      });
      if (image) {
        images.push(image);
        snapshotRefs.push({ id, repIndex, score: snap.score ?? null, ts: snap.ts ?? now });
      }
    }
  }

  if (snapshotRefs.length > 0) {
    compactScore.snapshotRefs = snapshotRefs;
    compactScore.snapshotCount = snapshotRefs.length;
  }

  return { score: compactScore, images };
}

async function prepareSessionForIndexedDb(session, now) {
  const sessionId = session?.id ?? createRecordId("session");
  const compactSession = compactSessionForStorage(session);
  compactSession.id = sessionId;
  compactSession.createdAt = session?.createdAt ?? session?.ts ?? now;
  compactSession.updatedAt = now;
  compactSession.syncStatus = session?.syncStatus ?? "local";

  const images = [];
  const frameSamples = [];
  let hasExerciseBaseline = false;

  if (Array.isArray(session?.scores)) {
    const scores = [];
    for (const [scoreIndex, score] of session.scores.entries()) {
      const prepared = await prepareScoreForIndexedDb(score, sessionId, scoreIndex, now);
      if (prepared.score?.hasBaselineSnapshot) hasExerciseBaseline = true;
      scores.push(prepared.score);
      images.push(...prepared.images);
    }
    compactSession.scores = scores;
  }

  if (!hasExerciseBaseline && typeof session?.baselineSnapshot === "string") {
    const baselineImageId = imageRecordId(sessionId, "sessionBaseline", "session");
    const image = await makeImageRecord({
      id: baselineImageId,
      sessionId,
      exerciseId: "",
      role: "sessionBaseline",
      scoreIndex: null,
      dataUrl: session.baselineSnapshot,
      now,
    });
    if (image) {
      images.push(image);
      compactSession.baselineImageId = baselineImageId;
      compactSession.hasBaselineSnapshot = true;
    }
  }

  if (Array.isArray(session?.frameSamples)) {
    for (const [index, sample] of session.frameSamples.entries()) {
      const record = makeFrameSampleRecord({ sessionId, sample, index, now });
      if (record) frameSamples.push(record);
    }
    if (frameSamples.length > 0) compactSession.frameSampleCount = frameSamples.length;
  }

  compactSession.imageCount = images.length || compactSession.imageCount || 0;
  return { session: compactSession, images, frameSamples };
}

function buildAppStateRecord(data, now) {
  const appState = { ...(data ?? {}) };
  delete appState.sessions;
  return {
    id: APP_STATE_ID,
    schemaVersion: SCHEMA_VERSION,
    ...appState,
    createdAt: appState.createdAt ?? now,
    updatedAt: now,
    syncStatus: appState.syncStatus ?? "local",
  };
}

function appStateRecordToData(record) {
  if (!record) return null;
  const data = { ...record };
  delete data.id;
  delete data.schemaVersion;
  delete data.createdAt;
  delete data.updatedAt;
  delete data.syncStatus;
  delete data.cloudId;
  return data;
}

async function prepareDataForIndexedDb(next) {
  const now = Date.now();
  const appState = buildAppStateRecord(next, now);
  const sessions = [];
  const allImages = [];
  const frameSamples = [];

  for (const session of next?.sessions ?? []) {
    const prepared = await prepareSessionForIndexedDb(session, now);
    sessions.push(prepared.session);
    allImages.push(...prepared.images);
    frameSamples.push(...prepared.frameSamples);
  }

  const evictedMediaSessionIds = applyMediaRetention(sessions);
  const evictedSet = new Set(evictedMediaSessionIds);
  // A session that just captured media is always among the most recent, so retention
  // never evicts what we're about to write — but guard anyway.
  const images = allImages.filter((image) => !evictedSet.has(image.sessionId));
  const frameArchives = await packFrameArchives(
    frameSamples.filter((sample) => !evictedSet.has(sample.sessionId)),
    now,
  );

  return {
    appState,
    sessions,
    images,
    frameArchives,
    evictedMediaSessionIds,
    data: { ...appStateRecordToData(appState), sessions },
  };
}

async function writePreparedDataToIndexedDb(prepared) {
  const db = await openMirrorDb();
  const currentSessionIds = new Set(prepared.sessions.map((session) => session.id).filter(Boolean));
  const evictedIds = prepared.evictedMediaSessionIds ?? [];

  // Read-only pass gathers just the keys to delete (retention-evicted media + archives
  // orphaned by deleted sessions). Reading keys — never blobs — keeps this O(records),
  // not O(bytes), so save cost no longer scales with the total stored corpus.
  const imageKeysToDelete = [];
  const legacyFrameKeysToDelete = [];
  const archiveKeysToDelete = [];
  {
    const rtx = db.transaction([SESSION_IMAGES_STORE, SESSION_FRAME_SAMPLES_STORE, SESSION_FRAME_ARCHIVE_STORE], "readonly");
    const rdone = transactionDone(rtx);
    const imagesIndex = rtx.objectStore(SESSION_IMAGES_STORE).index("sessionId");
    const legacyIndex = rtx.objectStore(SESSION_FRAME_SAMPLES_STORE).index("sessionId");
    const archiveKeys = await requestToPromise(rtx.objectStore(SESSION_FRAME_ARCHIVE_STORE).getAllKeys());
    for (const sessionId of evictedIds) {
      imageKeysToDelete.push(...await requestToPromise(imagesIndex.getAllKeys(sessionId)));
      legacyFrameKeysToDelete.push(...await requestToPromise(legacyIndex.getAllKeys(sessionId)));
    }
    for (const key of archiveKeys) if (!currentSessionIds.has(key)) archiveKeysToDelete.push(key);
    await rdone;
  }

  const tx = db.transaction([APP_STATE_STORE, SESSIONS_STORE, SESSION_IMAGES_STORE, SESSION_FRAME_ARCHIVE_STORE, SESSION_FRAME_SAMPLES_STORE], "readwrite");
  const done = transactionDone(tx);
  tx.objectStore(APP_STATE_STORE).put(prepared.appState);
  const sessionsStore = tx.objectStore(SESSIONS_STORE);
  const imagesStore = tx.objectStore(SESSION_IMAGES_STORE);
  const archiveStore = tx.objectStore(SESSION_FRAME_ARCHIVE_STORE);
  const legacyFrameStore = tx.objectStore(SESSION_FRAME_SAMPLES_STORE);
  sessionsStore.clear();
  for (const session of prepared.sessions) sessionsStore.put(session);
  // Incremental writes: only this change's blobs are written; untouched sessions keep
  // their existing images/archives in place (no full-corpus read-and-rewrite).
  for (const image of prepared.images) imagesStore.put(image);
  for (const archive of prepared.frameArchives) archiveStore.put(archive);
  for (const key of imageKeysToDelete) imagesStore.delete(key);
  for (const key of legacyFrameKeysToDelete) legacyFrameStore.delete(key);
  for (const sessionId of evictedIds) archiveStore.delete(sessionId);
  for (const key of archiveKeysToDelete) archiveStore.delete(key);
  await done;
}

async function readDataFromIndexedDb() {
  const db = await openMirrorDb();
  const tx = db.transaction([APP_STATE_STORE, SESSIONS_STORE], "readonly");
  const done = transactionDone(tx);
  const appStateRequest = tx.objectStore(APP_STATE_STORE).get(APP_STATE_ID);
  const sessionsRequest = tx.objectStore(SESSIONS_STORE).getAll();
  const appState = await requestToPromise(appStateRequest);
  const sessions = await requestToPromise(sessionsRequest);
  await done;
  if (!appState && sessions.length === 0) return null;
  return {
    ...(appStateRecordToData(appState) ?? {}),
    sessions: sessions.sort((a, b) => (a.ts ?? a.createdAt ?? 0) - (b.ts ?? b.createdAt ?? 0)),
  };
}

function readLegacyStorage() {
  try {
    const value = localStorage.getItem(LEGACY_STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function writeLegacyStorage(data) {
  localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(compactAppDataForStorage(data)));
}

function removeLegacyStorage() {
  try { localStorage.removeItem(LEGACY_STORAGE_KEY); } catch { /* best effort cleanup */ }
}

function plainRecord(record) {
  if (!record || typeof record !== "object") return null;
  return { ...record };
}

function recordArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map(plainRecord).filter(Boolean);
}

async function readIndexedDbStores(storeNames) {
  const db = await openMirrorDb();
  const names = storeNames.filter((name) => db.objectStoreNames.contains(name));
  if (names.length === 0) return {};
  const tx = db.transaction(names, "readonly");
  const done = transactionDone(tx);
  const requests = Object.fromEntries(names.map((name) => [name, tx.objectStore(name).getAll()]));
  const entries = await Promise.all(Object.entries(requests).map(async ([name, request]) => [name, await requestToPromise(request)]));
  await done;
  return Object.fromEntries(entries);
}

// Expand the per-session gzip archives (plus any not-yet-migrated legacy rows) back
// into the flat frame-sample record array the export/import format uses.
async function readFrameSamplesForExport() {
  const db = await openMirrorDb();
  const frames = [];
  if (db.objectStoreNames.contains(SESSION_FRAME_ARCHIVE_STORE)) {
    const tx = db.transaction(SESSION_FRAME_ARCHIVE_STORE, "readonly");
    const done = transactionDone(tx);
    const archives = await requestToPromise(tx.objectStore(SESSION_FRAME_ARCHIVE_STORE).getAll());
    await done;
    for (const archive of archives) frames.push(...await unpackFrameArchive(archive));
  }
  if (db.objectStoreNames.contains(SESSION_FRAME_SAMPLES_STORE)) {
    const tx = db.transaction(SESSION_FRAME_SAMPLES_STORE, "readonly");
    const done = transactionDone(tx);
    const legacy = await requestToPromise(tx.objectStore(SESSION_FRAME_SAMPLES_STORE).getAll());
    await done;
    frames.push(...legacy);
  }
  return frames;
}

async function exportImageRecord(record) {
  if (!record || typeof record !== "object") return null;
  const { blob, ...rest } = record;
  const dataUrl = typeof record.dataUrl === "string"
    ? record.dataUrl
    : blob
      ? await blobToDataUrl(blob)
      : null;
  return dataUrl ? { ...rest, dataUrl } : { ...rest };
}

function browserDataSummary(stores) {
  const appState = recordArray(stores.appState).find((record) => record.id === APP_STATE_ID) ?? recordArray(stores.appState)[0] ?? null;
  const sessionImages = recordArray(stores.sessionImages);
  const sessionFrameSamples = recordArray(stores.sessionFrameSamples);
  return {
    sessions: recordArray(stores.sessions).length,
    assessments: Array.isArray(appState?.assessments) ? appState.assessments.length : 0,
    sessionImages: sessionImages.length,
    sessionFrameSamples: sessionFrameSamples.length,
    journalEntries: Array.isArray(appState?.journal) ? appState.journal.length : 0,
    hasMovementProfile: Boolean(appState?.movementProfile),
  };
}

export async function exportMirrorBrowserData() {
  const stores = await readIndexedDbStores([APP_STATE_STORE, SESSIONS_STORE, SESSION_IMAGES_STORE]);
  const appState = recordArray(stores[APP_STATE_STORE]);
  const sessions = recordArray(stores[SESSIONS_STORE]);
  const sessionFrameSamples = recordArray(await readFrameSamplesForExport());
  const sessionImages = [];
  for (const image of recordArray(stores[SESSION_IMAGES_STORE])) {
    const exported = await exportImageRecord(image);
    if (exported) sessionImages.push(exported);
  }

  const exportStores = { appState, sessions, sessionImages, sessionFrameSamples };
  return {
    kind: EXPORT_KIND,
    appId: EXPORT_APP_ID,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    storage: {
      dbName: DB_NAME,
      dbVersion: DB_VERSION,
      schemaVersion: SCHEMA_VERSION,
    },
    summary: browserDataSummary(exportStores),
    stores: exportStores,
    legacyData: readLegacyStorage(),
  };
}

export function createMirrorBrowserDataExportBlob(payload) {
  const manifest = {
    kind: EXPORT_LINES_KIND,
    appId: payload?.appId ?? EXPORT_APP_ID,
    version: payload?.version ?? EXPORT_VERSION,
    exportedAt: payload?.exportedAt ?? new Date().toISOString(),
    storage: payload?.storage ?? { dbName: DB_NAME, dbVersion: DB_VERSION, schemaVersion: SCHEMA_VERSION },
    summary: payload?.summary ?? browserDataSummary(payload?.stores ?? {}),
  };
  const parts = [JSON.stringify(manifest), "\n"];
  for (const store of [APP_STATE_STORE, SESSIONS_STORE, SESSION_IMAGES_STORE, SESSION_FRAME_SAMPLES_STORE]) {
    for (const record of recordArray(payload?.stores?.[store])) {
      parts.push(JSON.stringify({ store, record }), "\n");
    }
  }
  if (payload?.legacyData) parts.push(JSON.stringify({ store: "legacyData", record: payload.legacyData }), "\n");
  return new Blob(parts, { type: "application/x-ndjson" });
}

async function parseMirrorBrowserDataLines(file) {
  const stores = { appState: [], sessions: [], sessionImages: [], sessionFrameSamples: [] };
  let manifest = null;
  let legacyData = null;
  const reader = file.stream().getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const parseLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed);
    if (parsed.kind === EXPORT_LINES_KIND) {
      manifest = parsed;
      return;
    }
    if (parsed.store === "legacyData") {
      legacyData = parsed.record ?? null;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(stores, parsed.store) && parsed.record && typeof parsed.record === "object") {
      stores[parsed.store].push(parsed.record);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let lineEnd = buffer.indexOf("\n");
    while (lineEnd >= 0) {
      parseLine(buffer.slice(0, lineEnd));
      buffer = buffer.slice(lineEnd + 1);
      lineEnd = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  parseLine(buffer);

  if (!manifest) throw new Error("Choose a Mirror browser data JSON export.");
  return {
    ...manifest,
    kind: EXPORT_KIND,
    stores,
    legacyData,
  };
}

export async function parseMirrorBrowserDataFile(file) {
  const firstChunk = await file.slice(0, 512).text();
  const isLineExport = file.name?.toLowerCase().endsWith(".jsonl")
    || firstChunk.includes(`"kind":"${EXPORT_LINES_KIND}"`)
    || firstChunk.includes(`"kind": "${EXPORT_LINES_KIND}"`);
  if (isLineExport) return parseMirrorBrowserDataLines(file);
  return JSON.parse(await file.text());
}

function importedStoresFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const stores = payload.stores ?? payload.data?.stores ?? null;
  if (!stores || typeof stores !== "object") return null;
  const hasKnownStoreShape = payload.kind === EXPORT_KIND
    || payload.appId === EXPORT_APP_ID
    || Array.isArray(stores.appState)
    || Array.isArray(stores.sessions)
    || Array.isArray(stores.sessionImages)
    || Array.isArray(stores.sessionFrameSamples)
    || Array.isArray(stores.images)
    || Array.isArray(stores.frameSamples);
  if (!hasKnownStoreShape) return null;
  return {
    appState: recordArray(Array.isArray(stores.appState) ? stores.appState : [stores.appState].filter(Boolean)),
    sessions: recordArray(stores.sessions),
    sessionImages: recordArray(stores.sessionImages ?? stores.images),
    sessionFrameSamples: recordArray(stores.sessionFrameSamples ?? stores.frameSamples),
  };
}

function appDataFromImportedPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.kind === EXPORT_KIND) return payload.legacyData ?? payload.appData ?? payload.data?.appData ?? null;
  if (payload.appData && typeof payload.appData === "object") return payload.appData;
  if (payload.data?.appData && typeof payload.data.appData === "object") return payload.data.appData;
  if (Array.isArray(payload.sessions) || Array.isArray(payload.journal) || payload.prefs || payload.movementProfile) return payload;
  return null;
}

function normalizeImportedAppStateRecords(records, now) {
  return records.map((record, index) => ({
    ...record,
    id: record.id ?? (index === 0 ? APP_STATE_ID : createRecordId("appState")),
    schemaVersion: record.schemaVersion ?? SCHEMA_VERSION,
    createdAt: record.createdAt ?? now,
    updatedAt: now,
    syncStatus: record.syncStatus ?? "local",
  }));
}

function normalizeImportedSessionRecords(records, now) {
  return records.map((record) => ({
    ...record,
    id: record.id ?? createRecordId("session"),
    createdAt: record.createdAt ?? record.ts ?? now,
    updatedAt: now,
    syncStatus: record.syncStatus ?? "local",
  }));
}

function normalizeImportedFrameSampleRecords(records, now) {
  return records.map((record, index) => {
    const sessionId = record.sessionId ?? "";
    return {
      ...record,
      id: record.id ?? `${sessionId}:frame:${index}`,
      sessionId,
      exerciseId: record.exerciseId ?? "",
      phase: record.phase ?? "",
      ts: record.ts ?? now,
      createdAt: record.createdAt ?? now,
      updatedAt: now,
      syncStatus: record.syncStatus ?? "local",
    };
  });
}

async function normalizeImportedImageRecords(records, now) {
  const images = [];
  for (const record of records) {
    const { dataUrl, blob, ...rest } = record;
    const imageBlob = blob ?? (typeof dataUrl === "string" ? await dataUrlToBlob(dataUrl) : null);
    if (!imageBlob) continue;
    images.push({
      ...rest,
      id: rest.id ?? createRecordId("image"),
      sessionId: rest.sessionId ?? "",
      exerciseId: rest.exerciseId ?? "",
      role: rest.role ?? "",
      scoreIndex: Number.isInteger(rest.scoreIndex) ? rest.scoreIndex : null,
      repIndex: Number.isInteger(rest.repIndex) ? rest.repIndex : null,
      mime: rest.mime ?? (typeof dataUrl === "string" ? parseDataUrlMime(dataUrl) : "image/jpeg"),
      blob: imageBlob,
      createdAt: rest.createdAt ?? now,
      updatedAt: now,
      syncStatus: rest.syncStatus ?? "local",
    });
  }
  return images;
}

async function replaceIndexedDbStores({ appState, sessions, sessionImages, sessionFrameSamples }) {
  const db = await openMirrorDb();
  // Pack imported frames into per-session archives before the write transaction
  // (gzip is async and must not straddle the synchronous store writes).
  const frameArchives = await packFrameArchives(sessionFrameSamples, Date.now());
  const tx = db.transaction([APP_STATE_STORE, SESSIONS_STORE, SESSION_IMAGES_STORE, SESSION_FRAME_SAMPLES_STORE, SESSION_FRAME_ARCHIVE_STORE], "readwrite");
  const done = transactionDone(tx);
  const appStateStore = tx.objectStore(APP_STATE_STORE);
  const sessionsStore = tx.objectStore(SESSIONS_STORE);
  const imagesStore = tx.objectStore(SESSION_IMAGES_STORE);
  const frameSamplesStore = tx.objectStore(SESSION_FRAME_SAMPLES_STORE);
  const archiveStore = tx.objectStore(SESSION_FRAME_ARCHIVE_STORE);
  appStateStore.clear();
  sessionsStore.clear();
  imagesStore.clear();
  frameSamplesStore.clear();
  archiveStore.clear();
  for (const record of appState) appStateStore.put(record);
  for (const record of sessions) sessionsStore.put(record);
  for (const record of sessionImages) imagesStore.put(record);
  for (const record of frameArchives) archiveStore.put(record);
  await done;
}

async function replacePreparedDataInIndexedDb(prepared) {
  const db = await openMirrorDb();
  const tx = db.transaction([APP_STATE_STORE, SESSIONS_STORE, SESSION_IMAGES_STORE, SESSION_FRAME_SAMPLES_STORE, SESSION_FRAME_ARCHIVE_STORE], "readwrite");
  const done = transactionDone(tx);
  const appStateStore = tx.objectStore(APP_STATE_STORE);
  const sessionsStore = tx.objectStore(SESSIONS_STORE);
  const imagesStore = tx.objectStore(SESSION_IMAGES_STORE);
  const frameSamplesStore = tx.objectStore(SESSION_FRAME_SAMPLES_STORE);
  const archiveStore = tx.objectStore(SESSION_FRAME_ARCHIVE_STORE);
  appStateStore.clear();
  sessionsStore.clear();
  imagesStore.clear();
  frameSamplesStore.clear();
  archiveStore.clear();
  appStateStore.put(prepared.appState);
  for (const session of prepared.sessions) sessionsStore.put(session);
  for (const image of prepared.images) imagesStore.put(image);
  for (const archive of prepared.frameArchives ?? []) archiveStore.put(archive);
  await done;
}

export async function importMirrorBrowserData(payload) {
  const now = Date.now();
  const stores = importedStoresFromPayload(payload);
  const appData = appDataFromImportedPayload(payload);
  const hasStoreRecords = stores && (
    stores.appState.length > 0
    || stores.sessions.length > 0
    || stores.sessionImages.length > 0
    || stores.sessionFrameSamples.length > 0
  );
  if (stores && (hasStoreRecords || !appData)) {
    const appState = normalizeImportedAppStateRecords(stores.appState, now);
    const sessions = normalizeImportedSessionRecords(stores.sessions, now);
    const sessionImages = await normalizeImportedImageRecords(stores.sessionImages, now);
    const sessionFrameSamples = normalizeImportedFrameSampleRecords(stores.sessionFrameSamples, now);
    await replaceIndexedDbStores({ appState, sessions, sessionImages, sessionFrameSamples });
    removeLegacyStorage();
    return await readDataFromIndexedDb() ?? { sessions: [] };
  }

  if (!appData) throw new Error("Choose a Mirror browser data JSON export.");
  const prepared = await prepareDataForIndexedDb(appData);
  await replacePreparedDataInIndexedDb(prepared);
  removeLegacyStorage();
  return prepared.data;
}

function sessionSignature(session) {
  if (!session || typeof session !== "object") return "";
  const exerciseIds = Array.isArray(session.exercises) ? session.exercises.join(",") : "";
  const scoreSig = Array.isArray(session.scores)
    ? session.scores.map((score) => `${score.exerciseId ?? ""}:${score.scores?.length ?? 0}:${score.avg ?? ""}`).join(";")
    : "";
  return [session.ts ?? "", session.date ?? "", session.duration ?? "", session.sessionAvg ?? "", exerciseIds, scoreSig].join("|");
}

function sessionImageWeight(session) {
  if (!session || typeof session !== "object") return 0;
  const topLevel = (session.baselineSnapshot || session.baselineImageId || session.hasBaselineSnapshot ? 1 : 0) + (session.imageCount ?? 0);
  const scoreLevel = Array.isArray(session.scores)
    ? session.scores.reduce((sum, score) => {
        const baseline = score?.baselineSnapshot || score?.baselineImageId || score?.hasBaselineSnapshot ? 1 : 0;
        const snapshots = Array.isArray(score?.snapshots) ? score.snapshots.length : (score?.snapshotCount ?? 0);
        return sum + baseline + snapshots;
      }, 0)
    : 0;
  return topLevel + scoreLevel;
}

function richerSession(current, candidate) {
  if (!current) return candidate;
  return sessionImageWeight(candidate) > sessionImageWeight(current) ? candidate : current;
}

function mergeSessions(primary = [], legacy = []) {
  const merged = new Map();
  const signatureToKey = new Map();

  for (const session of [...primary, ...legacy]) {
    const signature = sessionSignature(session);
    const key = session?.id || signature || createRecordId("session");
    const existingKey = (session?.id && merged.has(session.id)) ? session.id : signatureToKey.get(signature);
    if (existingKey) {
      merged.set(existingKey, richerSession(merged.get(existingKey), session));
      continue;
    }
    merged.set(key, session);
    if (signature) signatureToKey.set(signature, key);
  }

  return Array.from(merged.values()).sort((a, b) => (a?.ts ?? a?.createdAt ?? 0) - (b?.ts ?? b?.createdAt ?? 0));
}

function mergeJournal(primary = [], legacy = []) {
  const byDate = new Map();
  for (const entry of legacy) if (entry?.date) byDate.set(entry.date, entry);
  for (const entry of primary) if (entry?.date) byDate.set(entry.date, entry);
  return Array.from(byDate.values()).sort((a, b) => a.date.localeCompare(b.date));
}

function mergeMirrorData(primary, legacy) {
  if (!primary) return legacy;
  if (!legacy) return primary;
  return {
    ...legacy,
    ...primary,
    prefs: { ...(legacy.prefs ?? {}), ...(primary.prefs ?? {}) },
    journal: mergeJournal(primary.journal, legacy.journal),
    sessions: mergeSessions(primary.sessions, legacy.sessions),
    movementProfile: primary.movementProfile ?? legacy.movementProfile ?? null,
    initialMovementProfile: primary.initialMovementProfile ?? legacy.initialMovementProfile ?? null,
    movementProfileHistory: Array.isArray(primary.movementProfileHistory) && primary.movementProfileHistory.length > 0
      ? primary.movementProfileHistory
      : legacy.movementProfileHistory,
  };
}

// One-time upgrade from the legacy per-frame store to per-session gzip archives.
// Small datasets are re-packed; oversized ones are dropped (see LEGACY_FRAME_MIGRATION_LIMIT)
// rather than read wholesale into memory. Best-effort: failure leaves legacy rows in place,
// and the export path still reads them.
async function migrateLegacyFrameSamples() {
  try {
    const db = await openMirrorDb();
    if (!db.objectStoreNames.contains(SESSION_FRAME_SAMPLES_STORE)) return;
    const countTx = db.transaction(SESSION_FRAME_SAMPLES_STORE, "readonly");
    const count = await requestToPromise(countTx.objectStore(SESSION_FRAME_SAMPLES_STORE).count());
    await transactionDone(countTx);
    if (!count) return;

    if (count > LEGACY_FRAME_MIGRATION_LIMIT) {
      const clearTx = db.transaction(SESSION_FRAME_SAMPLES_STORE, "readwrite");
      clearTx.objectStore(SESSION_FRAME_SAMPLES_STORE).clear();
      await transactionDone(clearTx);
      console.warn(`Dropped ${count} legacy frame samples to reclaim storage (exceeded migration limit).`);
      return;
    }

    const readTx = db.transaction(SESSION_FRAME_SAMPLES_STORE, "readonly");
    const legacy = await requestToPromise(readTx.objectStore(SESSION_FRAME_SAMPLES_STORE).getAll());
    await transactionDone(readTx);
    const archives = await packFrameArchives(legacy, Date.now());

    const writeTx = db.transaction([SESSION_FRAME_ARCHIVE_STORE, SESSION_FRAME_SAMPLES_STORE], "readwrite");
    const wdone = transactionDone(writeTx);
    const archiveStore = writeTx.objectStore(SESSION_FRAME_ARCHIVE_STORE);
    for (const archive of archives) {
      const existing = await requestToPromise(archiveStore.get(archive.sessionId));
      if (!existing) archiveStore.put(archive);
    }
    writeTx.objectStore(SESSION_FRAME_SAMPLES_STORE).clear();
    await wdone;
  } catch (error) {
    console.error("Failed to migrate legacy frame samples", error);
  }
}

export async function loadMirrorData() {
  try {
    await migrateLegacyFrameSamples();
    const indexedData = await readDataFromIndexedDb();
    const legacyData = readLegacyStorage();
    if (indexedData && legacyData) {
      const merged = mergeMirrorData(indexedData, legacyData);
      const prepared = await prepareDataForIndexedDb(merged);
      await writePreparedDataToIndexedDb(prepared);
      removeLegacyStorage();
      return prepared.data;
    }
    if (indexedData) return indexedData;
    if (!legacyData) return null;

    const prepared = await prepareDataForIndexedDb(legacyData);
    await writePreparedDataToIndexedDb(prepared);
    removeLegacyStorage();
    return prepared.data;
  } catch (error) {
    console.error("Failed to load IndexedDB storage, using legacy storage", error);
    const legacyData = readLegacyStorage();
    return legacyData ? compactAppDataForStorage(legacyData) : null;
  }
}

export async function saveMirrorData(next) {
  try {
    const prepared = await prepareDataForIndexedDb(next);
    await writePreparedDataToIndexedDb(prepared);
    removeLegacyStorage();
    return prepared.data;
  } catch (error) {
    console.error("Failed to persist IndexedDB storage, using legacy storage", error);
    const compactData = compactAppDataForStorage(next);
    writeLegacyStorage(compactData);
    return compactData;
  }
}

export async function estimateStorageUsage() {
  const result = {
    usage: null,
    quota: null,
    counts: { sessions: 0, images: 0, frameArchives: 0, frameSamples: 0 },
  };
  try {
    if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      result.usage = usage ?? null;
      result.quota = quota ?? null;
    }
  } catch (error) {
    console.error("Failed to estimate storage usage", error);
  }
  try {
    const db = await openMirrorDb();
    const names = [SESSIONS_STORE, SESSION_IMAGES_STORE, SESSION_FRAME_ARCHIVE_STORE, SESSION_FRAME_SAMPLES_STORE]
      .filter((name) => db.objectStoreNames.contains(name));
    const tx = db.transaction(names, "readonly");
    const done = transactionDone(tx);
    const counts = {};
    for (const name of names) counts[name] = await requestToPromise(tx.objectStore(name).count());
    await done;
    result.counts = {
      sessions: counts[SESSIONS_STORE] ?? 0,
      images: counts[SESSION_IMAGES_STORE] ?? 0,
      frameArchives: counts[SESSION_FRAME_ARCHIVE_STORE] ?? 0,
      frameSamples: counts[SESSION_FRAME_SAMPLES_STORE] ?? 0,
    };
  } catch (error) {
    console.error("Failed to count stored records", error);
  }
  return result;
}

export async function clearAllMirrorData() {
  try {
    const db = await openMirrorDb();
    const names = [APP_STATE_STORE, SESSIONS_STORE, SESSION_IMAGES_STORE, SESSION_FRAME_ARCHIVE_STORE, SESSION_FRAME_SAMPLES_STORE]
      .filter((name) => db.objectStoreNames.contains(name));
    const tx = db.transaction(names, "readwrite");
    const done = transactionDone(tx);
    for (const name of names) tx.objectStore(name).clear();
    await done;
  } catch (error) {
    console.error("Failed to clear IndexedDB storage", error);
  }
  removeLegacyStorage();
}

export async function deleteSessionImages(sessionId) {
  if (!sessionId) return;
  try {
    const db = await openMirrorDb();
    const tx = db.transaction(SESSION_IMAGES_STORE, "readwrite");
    const done = transactionDone(tx);
    const store = tx.objectStore(SESSION_IMAGES_STORE);
    const keysRequest = store.index("sessionId").getAllKeys(sessionId);
    const keys = await requestToPromise(keysRequest);
    for (const key of keys) store.delete(key);
    await done;
  } catch (error) {
    // Orphaned blobs are a storage cost only, not a correctness issue, so deletion
    // is best-effort — the next save still drops the session record itself.
    console.error("Failed to delete session images", error);
  }
}

export async function deleteSessionFrameSamples(sessionId) {
  if (!sessionId) return;
  try {
    const db = await openMirrorDb();
    const stores = [SESSION_FRAME_ARCHIVE_STORE, SESSION_FRAME_SAMPLES_STORE].filter((name) => db.objectStoreNames.contains(name));
    if (!stores.length) return;
    const tx = db.transaction(stores, "readwrite");
    const done = transactionDone(tx);
    if (db.objectStoreNames.contains(SESSION_FRAME_ARCHIVE_STORE)) {
      tx.objectStore(SESSION_FRAME_ARCHIVE_STORE).delete(sessionId);
    }
    if (db.objectStoreNames.contains(SESSION_FRAME_SAMPLES_STORE)) {
      const legacyStore = tx.objectStore(SESSION_FRAME_SAMPLES_STORE);
      const keys = await requestToPromise(legacyStore.index("sessionId").getAllKeys(sessionId));
      for (const key of keys) legacyStore.delete(key);
    }
    await done;
  } catch (error) {
    console.error("Failed to delete session frame samples", error);
  }
}

async function readImagesForSession(sessionId) {
  const db = await openMirrorDb();
  const tx = db.transaction(SESSION_IMAGES_STORE, "readonly");
  const done = transactionDone(tx);
  const imagesRequest = tx.objectStore(SESSION_IMAGES_STORE).index("sessionId").getAll(sessionId);
  const images = await requestToPromise(imagesRequest);
  await done;
  return images.sort((a, b) => {
    const scoreDelta = (a.scoreIndex ?? -1) - (b.scoreIndex ?? -1);
    if (scoreDelta !== 0) return scoreDelta;
    return (a.repIndex ?? -1) - (b.repIndex ?? -1);
  });
}

function targetScoreForImage(scores, image) {
  if (Number.isInteger(image.scoreIndex) && scores[image.scoreIndex]) return scores[image.scoreIndex];
  return scores.find((score) => score.exerciseId === image.exerciseId) ?? null;
}

export async function hydrateSessionImages(session) {
  if (!session?.id) return session;
  try {
    const images = await readImagesForSession(session.id);
    if (images.length === 0) return session;

    const hydrated = {
      ...session,
      scores: Array.isArray(session.scores) ? session.scores.map((score) => ({ ...score })) : [],
    };

    for (const image of images) {
      const dataUrl = await blobToDataUrl(image.blob);
      if (image.role === "sessionBaseline") {
        hydrated.baselineSnapshot = dataUrl;
        continue;
      }

      const score = targetScoreForImage(hydrated.scores, image);
      if (!score) continue;
      if (image.role === "baseline") {
        score.baselineSnapshot = dataUrl;
        continue;
      }
      if (image.role === "rep") {
        const repIndex = Number.isInteger(image.repIndex) ? image.repIndex : (score.snapshots?.length ?? 0);
        const snapshots = Array.isArray(score.snapshots) ? [...score.snapshots] : [];
        snapshots[repIndex] = { ts: image.ts ?? image.createdAt, score: image.score, dataUrl };
        score.snapshots = snapshots;
      }
    }

    hydrated.scores = hydrated.scores.map((score) => (
      Array.isArray(score.snapshots)
        ? { ...score, snapshots: score.snapshots.filter(Boolean) }
        : score
    ));

    return hydrated;
  } catch (error) {
    console.error("Failed to hydrate session images", error);
    return session;
  }
}
