import assert from "node:assert/strict";
import test from "node:test";
import { aggregateRescoredSessions } from "../src/ml/frameSampleReplay.js";

// `open-smile` uses blendshape fusion (smilePull); `frown` does not — so `frown` acts as
// the reconstruction control that validates the replay before any fusion exercise is trusted.
function frame(sessionId, exerciseId, repIndex, replayScore, storedScored = true) {
  return { sessionId, exerciseId, repIndex, storedScored, replayScore };
}

function session(id, ts, sessionAvg, scores) {
  return { id, ts, sessionAvg, scores };
}

test("rescores fusion exercises and keeps non-fusion controls untouched when self-check passes", () => {
  const sessions = [session("s1", 1000, 0.6, [
    { exerciseId: "open-smile", avg: 0.4 },
    { exerciseId: "frown", avg: 0.8 },
  ])];
  // open-smile corrected upward (0.5 across two reps); frown reproduces its stored 0.8.
  const frames = [
    frame("s1", "open-smile", 0, 0.5), frame("s1", "open-smile", 1, 0.5),
    frame("s1", "frown", 0, 0.8), frame("s1", "frown", 1, 0.8),
  ];

  const { sessions: [result] } = aggregateRescoredSessions(frames, sessions, { sinceTs: 0 });
  assert.equal(result.verdict, "rescore");
  assert.equal(result.selfCheckPassed, true);
  assert.equal(result.changedExercises.length, 1, "only the fusion exercise changes");
  assert.equal(result.changedExercises[0].exerciseId, "open-smile");
  assert.equal(result.changedExercises[0].replayAvg, 0.5);
  // newSessionAvg = mean(replay open-smile 0.5, stored frown 0.8)
  assert.equal(result.newSessionAvg, 0.65);
  assert.equal(result.storedSessionAvg, 0.6);
});

test("aborts a session when the non-fusion control can't be reproduced", () => {
  const sessions = [session("s1", 1000, 0.6, [
    { exerciseId: "open-smile", avg: 0.4 },
    { exerciseId: "frown", avg: 0.8 },
  ])];
  // frown replays at 0.5 — far from its stored 0.8 => reconstruction is untrustworthy.
  const frames = [
    frame("s1", "open-smile", 0, 0.7),
    frame("s1", "frown", 0, 0.5),
  ];

  const { sessions: [result] } = aggregateRescoredSessions(frames, sessions, { sinceTs: 0, scoreTolerance: 0.02 });
  assert.equal(result.selfCheckPassed, false);
  assert.equal(result.verdict, "skip-selfcheck");
  assert.ok(result.maxControlDelta > 0.02);
});

test("marks sessions with no usable frames as skip-no-frames", () => {
  const sessions = [session("s1", 1000, 0.4, [{ exerciseId: "open-smile", avg: 0.4 }])];
  const { sessions: [result] } = aggregateRescoredSessions([], sessions, { sinceTs: 0 });
  assert.equal(result.verdict, "skip-no-frames");
  assert.equal(result.recoverable, false);
  assert.equal(result.newSessionAvg, 0.4, "unrecoverable sessions keep their stored average");
  assert.equal(result.sessionAvgDelta, null, "skipped sessions report no change");
});

test("flags recoverable sessions that have no control to verify against", () => {
  const sessions = [session("s1", 1000, 0.4, [{ exerciseId: "open-smile", avg: 0.4 }])];
  const frames = [frame("s1", "open-smile", 0, 0.6)];
  const { sessions: [result] } = aggregateRescoredSessions(frames, sessions, { sinceTs: 0 });
  assert.equal(result.verdict, "rescore-unverified");
  assert.equal(result.selfCheckPassed, null);
  assert.equal(result.newSessionAvg, 0.6);
});

test("only frames that activated live and still score contribute to the rep average", () => {
  const sessions = [session("s1", 1000, 0.4, [{ exerciseId: "open-smile", avg: 0.4 }])];
  const frames = [
    frame("s1", "open-smile", 0, 0.6),
    frame("s1", "open-smile", 0, null),        // fix now drops this frame (blendshape-only)
    frame("s1", "open-smile", 0, 0.5, false),  // never activated live — ignored
  ];
  const { sessions: [result] } = aggregateRescoredSessions(frames, sessions, { sinceTs: 0 });
  // rep 0 average is mean of the single surviving scored frame (0.6)
  assert.equal(result.changedExercises[0].replayAvg, 0.6);
});

test("honors the time window", () => {
  const sessions = [
    session("old", 500, 0.5, [{ exerciseId: "open-smile", avg: 0.5 }]),
    session("new", 2000, 0.5, [{ exerciseId: "open-smile", avg: 0.5 }]),
  ];
  const frames = [frame("old", "open-smile", 0, 0.7), frame("new", "open-smile", 0, 0.7)];
  const { sessions: results } = aggregateRescoredSessions(frames, sessions, { sinceTs: 1000 });
  assert.equal(results.length, 1);
  assert.equal(results[0].sessionId, "new");
});
