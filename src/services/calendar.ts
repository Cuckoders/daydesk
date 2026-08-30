import type { CalendarEvent, MailAccount } from "../types";
import type { OAuthProvider } from "./oauth";

export interface RemoteCalendarEvent {
  remoteId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  remindBeforeMinutes: number;
  reminderEnabled: boolean;
  allDay: boolean;
  usesDefaultReminder: boolean;
  startDate?: string;
  endDate?: string;
  version?: string;
}

interface CalendarAccountInput {
  provider: OAuthProvider;
  accountId: string;
}

interface CalendarRangeInput extends CalendarAccountInput {
  timeMin: string;
  timeMax: string;
}

interface CalendarEventInput extends CalendarAccountInput {
  remoteId?: string;
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  remindBeforeMinutes: number;
  reminderEnabled: boolean;
  usesDefaultReminder?: boolean;
  updateReminders: boolean;
  updateTitle: boolean;
  updateTime: boolean;
  updateLocation: boolean;
  version?: string;
  operationId?: string;
}

interface CalendarDeleteInput extends CalendarAccountInput {
  remoteId: string;
  version?: string;
}

function isDesktopApp() {
  return "__TAURI_INTERNALS__" in window;
}

async function invokeCalendar<T>(command: string, input: object): Promise<T> {
  if (!isDesktopApp()) {
    throw new Error("Синхронизация календаря доступна в установленном приложении DayDesk");
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, { input });
  } catch (error) {
    if (typeof error === "string") throw new Error(error);
    if (error instanceof Error) throw error;
    throw new Error("Не удалось выполнить операцию с календарём");
  }
}

export const syncRemoteCalendar = (input: CalendarRangeInput) =>
  invokeCalendar<RemoteCalendarEvent[]>("sync_calendar", input);

export const upsertRemoteCalendarEvent = (input: CalendarEventInput) =>
  invokeCalendar<RemoteCalendarEvent>("upsert_calendar_event", input);

export const deleteRemoteCalendarEvent = (input: CalendarDeleteInput) =>
  invokeCalendar<void>("delete_calendar_event", input);

function stableIdPart(value: string) {
  let first = 0x811c9dc5;
  let second = 0x1f123bb5;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

export function toCalendarEvent(account: MailAccount, remote: RemoteCalendarEvent): CalendarEvent {
  return {
    id: `calendar:${stableIdPart(account.id)}:${stableIdPart(remote.remoteId)}`,
    title: remote.title,
    startsAt: remote.startsAt,
    endsAt: remote.endsAt,
    type: "meeting",
    location: remote.location,
    remindBeforeMinutes: remote.remindBeforeMinutes,
    allDay: remote.allDay,
    allDayStartDate: remote.startDate,
    allDayEndDate: remote.endDate,
    calendar: {
      provider: account.provider as OAuthProvider,
      accountId: account.id,
      remoteId: remote.remoteId,
      version: remote.version,
      readOnly: remote.allDay,
      reminderEnabled: remote.reminderEnabled,
      usesDefaultReminder: remote.usesDefaultReminder,
    },
  };
}
