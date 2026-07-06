import { useCallback, useEffect, useMemo, useState } from "react";
import { formatClock, isCountedSession, nextSessionAt, todayISO } from "../domain/session";

export const SESSION_REMINDER_TITLE = "Time for your Mirror session";
export const SESSION_REMINDER_TAG = "mirror-session-reminder";

const DELIVERED_STORAGE_KEY = "mirror-session-reminder-delivered";
const MAX_DELIVERED_KEYS = 40;

function browserWindow() {
  return typeof window !== "undefined" ? window : null;
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function dateISOFor(value) {
  try {
    return validDate(value).toISOString().split("T")[0];
  } catch {
    return todayISO();
  }
}

function normalizeDailyGoal(value) {
  const n = Math.round(Number(value ?? 3));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function countCompletedReminderSessions(sessions = [], date = todayISO()) {
  return (sessions ?? []).filter((session) => session?.date === date && isCountedSession(session)).length;
}

export function buildNextSessionReminder({
  sessions = [],
  dailyGoal = 3,
  now = new Date(),
  date = dateISOFor(now),
  sessionActive = false,
} = {}) {
  if (sessionActive) return null;
  const goal = normalizeDailyGoal(dailyGoal);
  if (goal <= 0) return null;

  const completedToday = countCompletedReminderSessions(sessions, date);
  if (completedToday >= goal) return null;

  const reference = validDate(now);
  const at = nextSessionAt(goal, completedToday, reference);
  if (!at) return null;

  const sessionNumber = completedToday + 1;
  const dueNow = at.getTime() <= reference.getTime();
  const body = dueNow
    ? `Session ${sessionNumber} of ${goal} is ready. Open Mirror for a gentle practice session.`
    : `Session ${sessionNumber} of ${goal} is scheduled for ${formatClock(at)}.`;

  return {
    title: SESSION_REMINDER_TITLE,
    body,
    at,
    completedToday,
    dailyGoal: goal,
    sessionNumber,
    dueNow,
    key: `${date}:${goal}:${completedToday}:${at.getHours()}:${at.getMinutes()}`,
    tag: SESSION_REMINDER_TAG,
  };
}

export function buildSessionReminderNotificationOptions(reminder) {
  return {
    body: reminder?.body ?? "Open Mirror for your next gentle practice session.",
    icon: "/favicon.svg",
    tag: reminder?.tag ?? SESSION_REMINDER_TAG,
    renotify: false,
  };
}

export function getSessionReminderPermission(win = browserWindow()) {
  const notificationApi = win?.Notification;
  if (!notificationApi) return "unsupported";
  return notificationApi.permission ?? "default";
}

export function buildSessionReminderStatus({
  enabled = false,
  permission = "unsupported",
  requesting = false,
  reminder = null,
} = {}) {
  const state = (() => {
    if (permission === "unsupported") return "unsupported";
    if (requesting) return "requesting";
    if (permission === "denied") return "blocked";
    if (!enabled) return "disabled";
    if (permission !== "granted") return "needs-permission";
    return reminder ? "scheduled" : "complete";
  })();

  return {
    enabled,
    permission,
    requesting,
    state,
    nextAt: reminder?.at ?? null,
    nextLabel: reminder?.at ? formatClock(reminder.at) : null,
    reminder,
  };
}

function readDeliveredKeys(storage) {
  if (!storage) return [];
  try {
    const parsed = JSON.parse(storage.getItem(DELIVERED_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function localStorageFor(win) {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function wasSessionReminderDelivered(key, storage = localStorageFor(browserWindow())) {
  if (!key) return false;
  return readDeliveredKeys(storage).includes(key);
}

export function rememberSessionReminderDelivered(key, storage = localStorageFor(browserWindow())) {
  if (!key || !storage) return;
  const keys = [...readDeliveredKeys(storage).filter((item) => item !== key), key].slice(-MAX_DELIVERED_KEYS);
  try {
    storage.setItem(DELIVERED_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Storage may be unavailable in private contexts; duplicate prevention is best effort.
  }
}

function showSessionReminderNotification(NotificationApi, reminder) {
  try {
    return new NotificationApi(SESSION_REMINDER_TITLE, buildSessionReminderNotificationOptions(reminder));
  } catch {
    return null;
  }
}

export function useSessionReminders({
  sessions = [],
  dailyGoal = 3,
  enabled = false,
  sessionActive = false,
  onReminderClick,
} = {}) {
  const [permission, setPermission] = useState(() => getSessionReminderPermission());
  const [requesting, setRequesting] = useState(false);

  const refreshPermission = useCallback(() => {
    setPermission(getSessionReminderPermission());
  }, []);

  useEffect(() => {
    const win = browserWindow();
    if (!win) return undefined;
    const refresh = () => refreshPermission();
    win.addEventListener("focus", refresh);
    win.document?.addEventListener("visibilitychange", refresh);
    return () => {
      win.removeEventListener("focus", refresh);
      win.document?.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshPermission]);

  const requestPermission = useCallback(async () => {
    const win = browserWindow();
    const NotificationApi = win?.Notification;
    if (!NotificationApi) {
      setPermission("unsupported");
      return "unsupported";
    }

    const current = NotificationApi.permission ?? "default";
    setPermission(current);
    if (current !== "default" || typeof NotificationApi.requestPermission !== "function") return current;

    setRequesting(true);
    try {
      const next = await NotificationApi.requestPermission();
      const resolved = next ?? NotificationApi.permission ?? "default";
      setPermission(resolved);
      return resolved;
    } catch {
      const resolved = NotificationApi.permission ?? "default";
      setPermission(resolved);
      return resolved;
    } finally {
      setRequesting(false);
    }
  }, []);

  const reminder = useMemo(
    () => buildNextSessionReminder({ sessions, dailyGoal, sessionActive }),
    [sessions, dailyGoal, sessionActive],
  );

  const status = useMemo(
    () => buildSessionReminderStatus({ enabled, permission, requesting, reminder }),
    [enabled, permission, requesting, reminder],
  );

  useEffect(() => {
    const win = browserWindow();
    const NotificationApi = win?.Notification;
    if (!win || !NotificationApi || !enabled || permission !== "granted" || sessionActive) return undefined;

    const scheduled = buildNextSessionReminder({ sessions, dailyGoal });
    if (!scheduled || wasSessionReminderDelivered(scheduled.key, localStorageFor(win))) return undefined;

    const delayMs = Math.max(0, scheduled.at.getTime() - Date.now());
    const timer = win.setTimeout(() => {
      const due = buildNextSessionReminder({ sessions, dailyGoal, now: new Date() });
      if (!due || wasSessionReminderDelivered(due.key, localStorageFor(win))) return;

      rememberSessionReminderDelivered(due.key, localStorageFor(win));
      const notification = showSessionReminderNotification(NotificationApi, due);
      if (!notification) return;
      notification.onclick = () => {
        try { win.focus?.(); } catch { /* ignored */ }
        onReminderClick?.();
        try { notification.close?.(); } catch { /* ignored */ }
      };
    }, delayMs);

    return () => win.clearTimeout(timer);
  }, [dailyGoal, enabled, onReminderClick, permission, sessions, sessionActive]);

  return { status, requestPermission, refreshPermission };
}
