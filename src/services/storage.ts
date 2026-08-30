import { initialState } from "../data";
import type { AppState } from "../types";

const STORAGE_KEY = "daydesk:state:v1";

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
    });
    const accountIds = new Set(accounts.map((account) => account.id));
    return {
      ...stored,
      events: (stored.events ?? []).map((event) => ({
        ...event,
        remindBeforeMinutes: event.remindBeforeMinutes ?? 10,
      })),
      accounts,
      messages: (stored.messages ?? []).filter((message) => accountIds.has(message.accountId)),
    };
  } catch {
    return initialState;
  }
}

export function saveState(state: AppState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, messages: [] }));
}

export const stateChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("daydesk-state");
