import { initialState } from "../data";
import type { AppState } from "../types";

const STORAGE_KEY = "daydesk:state:v1";
const MAX_PERSISTED_STATE_BYTES = 4 * 1024 * 1024;

const serializeState = (state: AppState) => JSON.stringify({ ...state, messages: [] });
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

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
      events: (stored.events ?? []).map((event) => ({
        ...event,
        remindBeforeMinutes: event.remindBeforeMinutes ?? 10,
      })).filter((event) => !event.calendar || accountIds.has(event.calendar.accountId)),
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
