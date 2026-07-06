import assert from "node:assert/strict";
import test from "node:test";
import { applyMediaRetention, packFrameArchive, unpackFrameArchive } from "../src/storage.js";
import { MEDIA_RETENTION_SESSIONS } from "../src/domain/config.js";

test("frame archive round-trips the flat sample records through gzip", async () => {
  const frames = [
    { id: "s1:frame:0", sessionId: "s1", exerciseId: "eye-close", phase: "hold", ts: 10, landmarks: [{ x: 0.1234, y: 0.5678, z: -0.01 }], blendshapes: { eyeBlinkLeft: 0.42 } },
    { id: "s1:frame:1", sessionId: "s1", exerciseId: "eye-close", phase: "hold", ts: 20, landmarks: null, blendshapes: null },
  ];
  const archive = await packFrameArchive("s1", frames, 999);
  assert.equal(archive.sessionId, "s1");
  assert.equal(archive.count, 2);
  assert.ok(archive.blob, "archive should hold a blob");

  const restored = await unpackFrameArchive(archive);
  assert.deepEqual(restored, frames, "unpacked frames must match the originals exactly");
});

test("packFrameArchive returns null for empty input", async () => {
  assert.equal(await packFrameArchive("s1", [], 1), null);
  assert.equal(await packFrameArchive("", [{ sessionId: "s1" }], 1), null);
  assert.equal(await packFrameArchive("s1", null, 1), null);
});

test("unpackFrameArchive tolerates a missing/corrupt blob", async () => {
  assert.deepEqual(await unpackFrameArchive(null), []);
  assert.deepEqual(await unpackFrameArchive({ sessionId: "s1" }), []);
  assert.deepEqual(await unpackFrameArchive({ sessionId: "s1", encoding: "json", blob: new Blob(["not json"]) }), []);
});

function makeSession(index, { withMedia = true } = {}) {
  const session = {
    id: `s${index}`,
    ts: index, // higher ts = more recent
    date: `2026-06-${String(index).padStart(2, "0")}`,
    sessionAvg: 50 + index,
    scores: [{ exerciseId: "eye-close", avg: 60, scores: [60, 62] }],
  };
  if (withMedia) {
    session.baselineImageId = `s${index}:sessionBaseline:session:base`;
    session.hasBaselineSnapshot = true;
    session.imageCount = 4;
    session.frameSampleCount = 30;
    session.scores[0].baselineImageId = `s${index}:baseline:0:base`;
    session.scores[0].snapshotRefs = [{ id: `s${index}:rep:0:0` }];
    session.scores[0].snapshotCount = 1;
    session.scores[0].hasBaselineSnapshot = true;
  }
  return session;
}

test("applyMediaRetention keeps media for the most recent sessions and strips older ones", () => {
  const total = MEDIA_RETENTION_SESSIONS + 3;
  const sessions = Array.from({ length: total }, (_, i) => makeSession(i + 1));
  const evicted = applyMediaRetention(sessions);

  // The three oldest (lowest ts) sessions are evicted.
  assert.deepEqual(evicted.sort(), ["s1", "s2", "s3"].sort());

  const byId = Object.fromEntries(sessions.map((s) => [s.id, s]));
  // Evicted: media refs gone, scores/metrics preserved.
  for (const id of ["s1", "s2", "s3"]) {
    const s = byId[id];
    assert.equal(s.baselineImageId, undefined);
    assert.equal(s.hasBaselineSnapshot, undefined);
    assert.equal(s.imageCount, undefined);
    assert.equal(s.frameSampleCount, undefined);
    assert.equal(s.scores[0].baselineImageId, undefined);
    assert.equal(s.scores[0].snapshotRefs, undefined);
    assert.equal(s.scores[0].snapshotCount, undefined);
    // Scores themselves survive.
    assert.equal(s.scores[0].avg, 60);
    assert.deepEqual(s.scores[0].scores, [60, 62]);
    assert.equal(typeof s.sessionAvg, "number");
  }
  // Most-recent session keeps its media.
  const newest = byId[`s${total}`];
  assert.equal(newest.baselineImageId, `s${total}:sessionBaseline:session:base`);
  assert.equal(newest.scores[0].snapshotRefs.length, 1);
});

test("applyMediaRetention evicts nothing when under the limit", () => {
  const sessions = Array.from({ length: MEDIA_RETENTION_SESSIONS }, (_, i) => makeSession(i + 1));
  const evicted = applyMediaRetention(sessions);
  assert.deepEqual(evicted, []);
  assert.equal(sessions[0].baselineImageId, "s1:sessionBaseline:session:base");
});
