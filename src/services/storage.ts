import { initialState } from "../data";
import type { AppState, Routine, RoutineKind, Task } from "../types";

const STORAGE_KEY = "daydesk:state:v1";
const MAX_PERSISTED_STATE_BYTES = 4 * 1024 * 1024;

const serializeState = (state: AppState) => JSON.stringify({ ...state, messages: [] });
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
const routineKinds = new Set<RoutineKind>(["water", "meal", "break", "focus", "custom"]);
const taskPriorities = new Set<Task["priority"]>(["high", "medium", "low"]);

function sanitizeTasks(value: unknown): Task[] {
  if (!Array.isArray(value)) return initialState.tasks;
  return value.slice(0, 5_000).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const raw = candidate as Partial<Task>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const category = typeof raw.category === "string" ? raw.category.trim() : "";
    const dueAt = typeof raw.dueAt === "string" ? new Date(raw.dueAt) : new Date(Number.NaN);
    if (!id || id.length > 100 || !title || title.length > 300 || !category || category.length > 100 || Number.isNaN(dueAt.getTime())) return [];
    if (/[\u0000-\u001f\u007f]/.test(`${id}${title}${category}`) || !taskPriorities.has(raw.priority as Task["priority"])) return [];
    const reminderMinutes = typeof raw.remindBeforeMinutes === "number" ? raw.remindBeforeMinutes : 0;
    const reminderIsValid = Number.isInteger(reminderMinutes) && reminderMinutes >= 0 && reminderMinutes <= 7 * 24 * 60;
    return [{
      id,
      title,
      completed: raw.completed === true,
      dueAt: dueAt.toISOString(),
      priority: raw.priority as Task["priority"],
      category,
      remindBeforeMinutes: reminderIsValid ? reminderMinutes : 0,
      reminderEnabled: raw.reminderEnabled === true && reminderIsValid,
    }];
  });
}

function sanitizeRoutines(value: unknown): Routine[] {
  if (!Array.isArray(value)) return initialState.routines;
  return value.slice(0, 64).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const raw = candidate as Partial<Routine>;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const time = typeof raw.time === "string" ? raw.time : "";
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    const days = Array.isArray(raw.days)
      ? [...new Set(raw.days.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))]
      : [];
    if (!id || id.length > 100 || /[\u0000-\u001f\u007f]/.test(id) || !title || title.length > 100 || /[\u0000-\u001f\u007f]/.test(title) || !match || days.length === 0) return [];
    if (Number(match[1]) > 23 || Number(match[2]) > 59 || !routineKinds.has(raw.kind as RoutineKind)) return [];
    const remindBeforeMinutes = [0, 5, 10, 15, 30].includes(raw.remindBeforeMinutes ?? -1)
      ? raw.remindBeforeMinutes as number
      : 0;
    return [{
      id,
      title,
      time,
      days,
      kind: raw.kind as RoutineKind,
      remindBeforeMinutes,
      enabled: raw.enabled !== false,
    }];
  });
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialState;
    const stored = JSON.parse(raw) as AppState;
    const demoAccountIds = new Set(["a1", "a2", "a3"]);
    const accounts = (stored.accounts ?? []).filter((account) => {
      if (demoAccountIds.has(account.id) || !account.connected) return false;
      if (account.authType === "oauth") return account.provider === "gmail" || account.provider === "outlook";
      return Boolean(account.imapHost);
    }).map((account) => ({
      ...account,
      calendarEnabled: account.authType === "oauth" ? account.calendarEnabled ?? false : false,
    }));
    const accountIds = new Set(accounts.map((account) => account.id));
    return {
      ...stored,
      tasks: sanitizeTasks(stored.tasks),
      events: (stored.events ?? []).map((event) => ({
        ...event,
        remindBeforeMinutes: event.remindBeforeMinutes ?? 10,
      })).filter((event) => !event.calendar || accountIds.has(event.calendar.accountId)),
      routines: sanitizeRoutines(stored.routines),
      accounts,
      messages: (stored.messages ?? []).filter((message) => accountIds.has(message.accountId)),
    };
  } catch {
    return initialState;
  }
}

export function saveState(state: AppState): string | null {
  const complete = serializeState(state);
  if (byteLength(complete) <= MAX_PERSISTED_STATE_BYTES) {
    try {
      localStorage.setItem(STORAGE_KEY, complete);
      return null;
    } catch {
      // Retry without the reproducible remote calendar cache when the platform quota is smaller.
    }
  }

  const withoutRemoteCalendar = serializeState({
    ...state,
    events: state.events.filter((event) => !event.calendar),
  });
  if (byteLength(withoutRemoteCalendar) > MAX_PERSISTED_STATE_BYTES) {
    return "Локальное хранилище заполнено. Новые изменения не сохранятся после перезапуска.";
  }
  try {
    localStorage.setItem(STORAGE_KEY, withoutRemoteCalendar);
    return null;
  } catch {
    return "DayDesk не может сохранить изменения в локальное хранилище. Освободите место и повторите действие.";
  }
}

export const stateChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("daydesk-state");
