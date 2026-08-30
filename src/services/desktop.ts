import type { CalendarEvent } from "../types";

function isDesktopApp() {
  return "__TAURI_INTERNALS__" in window;
}

async function invokeDesktop<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, payload);
}

export async function replaceBackgroundReminders(events: CalendarEvent[]): Promise<void> {
  if (!isDesktopApp()) return;
  await invokeDesktop<void>("replace_reminders", {
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: event.startsAt,
      location: event.location,
      remindBeforeMinutes: event.remindBeforeMinutes,
      reminderEnabled: event.reminderEnabled ?? event.calendar?.reminderEnabled ?? event.remindBeforeMinutes > 0,
    })),
  });
}

export async function isAutostartEnabled(): Promise<boolean> {
  if (!isDesktopApp()) return false;
  return invokeDesktop<boolean>("is_autostart_enabled");
}

export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  if (!isDesktopApp()) return;
  await invokeDesktop<void>("set_autostart_enabled", { enabled });
}

export async function quitDayDesk(): Promise<void> {
  if (!isDesktopApp()) return;
  await invokeDesktop<void>("quit_daydesk");
}
