import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_REMINDER_TAG,
  SESSION_REMINDER_TITLE,
  buildNextSessionReminder,
  buildSessionReminderNotificationOptions,
  countCompletedReminderSessions,
} from "../src/hooks/useSessionReminders.js";

test("builds the next session reminder from counted sessions and daily goal slots", () => {
  const now = new Date(2026, 6, 6, 10, 0, 0);
  const reminder = buildNextSessionReminder({
    dailyGoal: 3,
    now,
    date: "2026-07-06",
    sessions: [
      { date: "2026-07-06", kind: "session" },
      { date: "2026-07-05", kind: "session" },
    ],
  });

  assert.equal(reminder.title, SESSION_REMINDER_TITLE);
  assert.equal(reminder.sessionNumber, 2);
  assert.equal(reminder.dailyGoal, 3);
  assert.equal(reminder.at.getHours(), 15);
  assert.equal(reminder.at.getMinutes(), 0);
  assert.equal(reminder.dueNow, false);

  const options = buildSessionReminderNotificationOptions(reminder);
  assert.equal(options.icon, "/favicon.svg");
  assert.equal(options.tag, SESSION_REMINDER_TAG);
  assert.match(options.body, /Session 2 of 3/);
});

test("does not build a reminder when today's counted goal is complete", () => {
  const reminder = buildNextSessionReminder({
    dailyGoal: 2,
    now: new Date(2026, 6, 6, 18, 0, 0),
    date: "2026-07-06",
    sessions: [
      { date: "2026-07-06", kind: "session" },
      { date: "2026-07-06", kind: "session" },
    ],
  });

  assert.equal(reminder, null);
});

test("ignores practice and assessment records for reminder session counting", () => {
  const sessions = [
    { date: "2026-07-06", kind: "practice" },
    { date: "2026-07-06", kind: "assessment" },
    { date: "2026-07-06", kind: "session" },
    { date: "2026-07-06" },
  ];

  assert.equal(countCompletedReminderSessions(sessions, "2026-07-06"), 2);

  const reminder = buildNextSessionReminder({
    dailyGoal: 3,
    now: new Date(2026, 6, 6, 18, 0, 0),
    date: "2026-07-06",
    sessions,
  });

  assert.equal(reminder.sessionNumber, 3);
  assert.equal(reminder.at.getHours(), 21);
});

test("skips scheduling while a session is active", () => {
  const reminder = buildNextSessionReminder({
    dailyGoal: 3,
    now: new Date(2026, 6, 6, 10, 0, 0),
    date: "2026-07-06",
    sessionActive: true,
    sessions: [],
  });

  assert.equal(reminder, null);
});
