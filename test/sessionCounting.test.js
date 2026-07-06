import assert from "node:assert/strict";
import process from "node:process";
import test from "node:test";
import { dateISOFromTimestamp, localDateISO, recordDateISO, computeStreak, isCountedSession, todayISO } from "../src/domain/session.js";

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

test("practice and assessment runs do not count toward daily goal or streak", () => {
  const today = todayISO();

  assert.equal(isCountedSession({ kind: "practice" }), false);
  assert.equal(isCountedSession({ kind: "assessment" }), false);
  assert.equal(isCountedSession({ kind: "session" }), true);
  assert.equal(isCountedSession({}), true);

  assert.equal(computeStreak([{ date: today, kind: "assessment" }]), 0);
  assert.equal(computeStreak([{ date: today, kind: "session" }]), 1);
});

test("local calendar dates are not shifted to the UTC date", () => {
  withTimeZone("Asia/Kolkata", () => {
    const localMorning = new Date(2026, 5, 27, 4, 20);
    const previousLocalMorning = new Date(2026, 5, 26, 4, 20);

    assert.equal(localDateISO(localMorning), "2026-06-27");
    assert.equal(localMorning.toISOString().slice(0, 10), "2026-06-26");
    assert.equal(dateISOFromTimestamp(localMorning.getTime()), "2026-06-27");
    assert.equal(recordDateISO({ date: "2026-06-26", ts: localMorning.getTime() }), "2026-06-27");
    assert.equal(recordDateISO({ date: "2026-06-27", ts: previousLocalMorning.getTime() }), "2026-06-26");
  });
});
