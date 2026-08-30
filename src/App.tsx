import { FormEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Coffee,
  Droplets,
  Download,
  FilePlus2,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  Power,
  RefreshCw,
  Reply,
  Rocket,
  Search,
  Server,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Utensils,
  Video,
  X,
} from "lucide-react";
import { connectImap, disconnectImap, downloadImapAttachment, getImapMessageContent, syncImap, type RemoteMailMessage } from "./services/mail";
import { clearMailAttachments, selectMailAttachments, sendMail, type SelectedMailAttachment } from "./services/compose";
import { isAutostartEnabled, quitDayDesk, replaceBackgroundReminders, setAutostartEnabled } from "./services/desktop";
import { loadMailCache, replaceMailCache, searchMailCache } from "./services/mailCache";
import { connectOAuth, disconnectOAuth, downloadOAuthAttachment, getOAuthMessageContent, getOAuthProviderStatus, syncOAuth, type OAuthProvider, type OAuthProviderStatus } from "./services/oauth";
import { deleteRemoteCalendarEvent, syncRemoteCalendar, toCalendarEvent, upsertRemoteCalendarEvent } from "./services/calendar";
import { loadState, saveState, stateChannel } from "./services/storage";
import {
  createSyncSnapshot,
  disconnectDesktopSyncDevice,
  getDesktopSyncStatus,
  mergeRemoteChanges,
  recordSyncChanges,
  registerDesktopSyncDevice,
  syncDesktopData,
  type SyncDeviceStatus,
} from "./services/sync";
import type { AppState, CalendarEvent, MailAccount, MailAttachment, MailMessage, Routine, RoutineKind, Task, TaskRecurrenceMode } from "./types";

type View = "today" | "tasks" | "calendar" | "mail" | "widgets";
type SyncPhase = "idle" | "syncing" | "error";

const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "today", label: "Сегодня", icon: LayoutDashboard },
  { id: "tasks", label: "Задачи", icon: ListTodo },
  { id: "calendar", label: "Календарь", icon: CalendarDays },
  { id: "mail", label: "Почта", icon: Mail },
  { id: "widgets", label: "Виджеты", icon: LayoutGrid },
];

const shortTime = (iso: string) => new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const longDate = (date: Date) => new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(date);
const weekday = (date: Date) => new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date).replace(".", "");
const uid = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const recurringTaskId = (seriesId: string, dueAt: string) => `repeat-${seriesId.slice(0, 100)}-${new Date(dueAt).getTime().toString(36)}`;
const sameDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
const localDateKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const eventOccursOnDate = (event: CalendarEvent, date: Date) => {
  if (event.allDay && event.allDayStartDate && event.allDayEndDate) {
    const key = localDateKey(date);
    return event.allDayStartDate <= key && key < event.allDayEndDate;
  }
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  return new Date(event.startsAt) < dayEnd && new Date(event.endsAt) > dayStart;
};
const pad = (value: number) => String(value).padStart(2, "0");
const inputDate = (iso: string) => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const inputTime = (iso: string) => {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const combineDateTime = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
const routineKindLabel: Record<RoutineKind, string> = {
  water: "Вода",
  meal: "Питание",
  break: "Перерыв",
  focus: "Фокус",
  custom: "Другое",
};
const routineWeekdays = [
  { value: 1, short: "Пн" },
  { value: 2, short: "Вт" },
  { value: 3, short: "Ср" },
  { value: 4, short: "Чт" },
  { value: 5, short: "Пт" },
  { value: 6, short: "Сб" },
  { value: 0, short: "Вс" },
];
const routineDaysLabel = (days: number[]) => {
  if (days.length === 7) return "Каждый день";
  if ([1, 2, 3, 4, 5].every((day) => days.includes(day)) && days.length === 5) return "По будням";
  if ([0, 6].every((day) => days.includes(day)) && days.length === 2) return "По выходным";
  return routineWeekdays.filter((day) => days.includes(day.value)).map((day) => day.short).join(", ");
};
const routineEventType = (kind: RoutineKind): CalendarEvent["type"] => kind === "meal" ? "meal" : kind === "focus" ? "focus" : "personal";
const routineOccurrences = (routines: Routine[], days = 32, from = new Date()): CalendarEvent[] => {
  const occurrences: CalendarEvent[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
    for (const routine of routines) {
      if (!routine.enabled || !routine.days.includes(date.getDay())) continue;
      const [hours, minutes] = routine.time.split(":").map(Number);
      if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) continue;
      const startsAt = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
      const endsAt = new Date(startsAt.getTime() + 15 * 60_000);
      occurrences.push({
        id: `routine:${routine.id}:${localDateKey(date)}`,
        title: routine.title,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        type: routineEventType(routine.kind),
        location: "Ритм дня",
        remindBeforeMinutes: routine.remindBeforeMinutes,
        reminderEnabled: true,
        routineId: routine.id,
      });
    }
  }
  return occurrences.sort((left, right) => left.startsAt.localeCompare(right.startsAt));
};
const taskReminderEvents = (tasks: Task[]): CalendarEvent[] => tasks.flatMap((task) => {
  const dueAt = new Date(task.dueAt);
  const snoozedUntil = task.snoozedUntil ? new Date(task.snoozedUntil) : null;
  const usesSnooze = snoozedUntil !== null && !Number.isNaN(snoozedUntil.getTime()) && snoozedUntil > new Date();
  const scheduledAt = usesSnooze ? snoozedUntil : dueAt;
  const remindBeforeMinutes = usesSnooze ? 0 : task.remindBeforeMinutes ?? 0;
  if (
    task.completed
    || !task.reminderEnabled
    || Number.isNaN(dueAt.getTime())
    || remindBeforeMinutes < 0
    || remindBeforeMinutes > 7 * 24 * 60
    || !task.title.trim()
    || task.title.length > 300
    || /[\u0000-\u001f\u007f]/.test(task.title)
    || /[\u0000-\u001f\u007f]/.test(task.category)
  ) return [];
  return [{
    id: `task:${task.id}`,
    title: task.title,
    startsAt: scheduledAt.toISOString(),
    endsAt: new Date(scheduledAt.getTime() + 15 * 60_000).toISOString(),
    type: "personal",
    location: usesSnooze ? `Отложено на 10 минут · ${task.category}` : `Задача · ${task.category}`,
    remindBeforeMinutes,
    reminderEnabled: true,
  }];
});
const taskDateLabel = (iso: string) => {
  const date = new Date(iso);
  const now = new Date();
  if (sameDay(date, now)) return "Сегодня";
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  if (sameDay(date, tomorrow)) return "Завтра";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date);
};
const taskRecurrenceLabel: Record<TaskRecurrenceMode, string> = {
  daily: "Каждый день",
  weekdays: "По будням",
  weekly: "Каждую неделю",
  custom: "По выбранным дням",
};
const nextRecurringDueAt = (task: Task, now = new Date()): string | null => {
  if (!task.recurrence) return null;
  const dueAt = new Date(task.dueAt);
  if (Number.isNaN(dueAt.getTime())) return null;
  const threshold = Math.max(dueAt.getTime(), now.getTime());
  for (let offset = 1; offset <= 370; offset += 1) {
    const candidate = new Date(dueAt);
    candidate.setDate(dueAt.getDate() + offset);
    const weekday = candidate.getDay();
    const matches = task.recurrence.mode === "daily"
      || (task.recurrence.mode === "weekdays" && weekday >= 1 && weekday <= 5)
      || (task.recurrence.mode === "weekly" && offset % 7 === 0)
      || (task.recurrence.mode === "custom" && task.recurrence.days.includes(weekday));
    if (matches && candidate.getTime() > threshold) return candidate.toISOString();
  }
  return null;
};
const toggleTaskCompletion = (current: AppState, id: string): AppState => {
  const task = current.tasks.find((item) => item.id === id);
  if (!task) return current;
  if (task.completed) {
    return { ...current, tasks: current.tasks.map((item) => item.id === id ? { ...item, completed: false } : item) };
  }
  let tasks = current.tasks.map((item) => item.id === id ? { ...item, completed: true, snoozedUntil: undefined } : item);
  const nextDueAt = nextRecurringDueAt(task);
  if (task.recurrence && nextDueAt) {
    const alreadyExists = tasks.some((item) => !item.completed && item.recurrence?.seriesId === task.recurrence?.seriesId);
    if (!alreadyExists) {
      tasks = [...tasks, { ...task, id: recurringTaskId(task.recurrence.seriesId, nextDueAt), dueAt: nextDueAt, completed: false, snoozedUntil: undefined }];
    }
  }
  return { ...current, tasks: tasks.sort((left, right) => left.dueAt.localeCompare(right.dueAt)) };
};
const snoozeTaskReminder = (current: AppState, id: string): AppState => ({
  ...current,
  tasks: current.tasks.map((task) => task.id === id && !task.completed && task.reminderEnabled
    ? { ...task, snoozedUntil: new Date(Date.now() + 10 * 60_000).toISOString() }
    : task),
});
const calendarRange = () => {
  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30);
  const timeMax = new Date();
  timeMax.setDate(timeMax.getDate() + 365);
  return { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() };
};
const isCalendarAccount = (account: MailAccount): account is MailAccount & { provider: OAuthProvider } =>
  account.authType === "oauth" && (account.provider === "gmail" || account.provider === "outlook");
let calendarMutationVersion = 0;
let calendarSyncVersion = 0;
type DayDeskAction = "new-task" | "open-routines";
const actionChannel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("daydesk-actions");
const requestMainAction = async (action: DayDeskAction) => {
  actionChannel?.postMessage(action);
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const main = await WebviewWindow.getByLabel("main");
    if (main) {
      await main.show();
      await main.setFocus();
    }
  } catch {
    window.opener?.focus();
  }
};
const fetchCalendarEvents = async (account: MailAccount & { provider: OAuthProvider }) => {
  const remote = await syncRemoteCalendar({ provider: account.provider, accountId: account.id, ...calendarRange() });
  return remote.map((event) => toCalendarEvent(account, event));
};
const replaceAccountCalendarEvents = (current: CalendarEvent[], accountId: string, fresh: CalendarEvent[]) => {
  const previousTypes = new Map(current
    .filter((event) => event.calendar?.accountId === accountId && event.calendar.remoteId)
    .map((event) => [event.calendar?.remoteId, event.type]));
  return [...current.filter((event) => event.calendar?.accountId !== accountId), ...fresh.map((event) => ({
    ...event,
    type: previousTypes.get(event.calendar?.remoteId) ?? event.type,
  }))].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
};
const fileSize = (bytes: number) => {
  if (bytes <= 0) return "Размер неизвестен";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function Logo() {
  return (
    <div className="logo-mark" aria-label="DayDesk">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function Sidebar({ view, onChange, open, onClose, onSettings, unreadCount, syncLabel }: { view: View; onChange: (view: View) => void; open: boolean; onClose: () => void; onSettings: () => void; unreadCount: number; syncLabel: string }) {
  return (
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
      <div className="brand"><Logo /><span>DayDesk</span><button className="icon-button sidebar-close" onClick={onClose}><X size={19} /></button></div>
      <nav className="main-nav" aria-label="Главная навигация">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? "active" : ""} onClick={() => { onChange(id); onClose(); }}>
            <Icon size={19} strokeWidth={2} />
            <span>{label}</span>
            {id === "mail" && unreadCount > 0 ? <span className="nav-badge">{unreadCount}</span> : null}
          </button>
        ))}
      </nav>
      <div className="sidebar-label">МОИ СПИСКИ</div>
      <div className="lists">
        <button><span className="list-dot work" />Работа <span>5</span></button>
        <button><span className="list-dot personal" />Личное <span>3</span></button>
        <button><span className="list-dot health" />Здоровье <span>2</span></button>
        <button className="add-list"><Plus size={16} />Новый список</button>
      </div>
      <div className="sidebar-bottom">
        <div className="mini-profile"><div className="avatar">О</div><div><strong>Олег</strong><span>{syncLabel}</span></div><MoreHorizontal size={18} /></div>
        <button onClick={onSettings}><Settings size={18} />Настройки</button>
      </div>
    </aside>
  );
}

function SettingsModal({ onClose, syncDevice, syncPhase, syncError, lastSyncedAt, onConnectSync, onSyncNow, onDisconnectSync }: {
  onClose: () => void;
  syncDevice?: SyncDeviceStatus;
  syncPhase: SyncPhase;
  syncError: string;
  lastSyncedAt?: string;
  onConnectSync: (apiUrl: string, setupCode: string, deviceName: string) => Promise<void>;
  onSyncNow: () => Promise<void>;
  onDisconnectSync: () => Promise<void>;
}) {
  const [autostart, setAutostart] = useState(false);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [apiUrl, setApiUrl] = useState("http://127.0.0.1:4310");
  const [setupCode, setSetupCode] = useState("");
  const [deviceName, setDeviceName] = useState("DayDesk Desktop");

  useEffect(() => {
    let active = true;
    void isAutostartEnabled()
      .then((enabled) => { if (active) setAutostart(enabled); })
      .catch((reason: unknown) => { if (active) setError(reason instanceof Error ? reason.message : "Не удалось проверить автозапуск"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const toggleAutostart = async () => {
    const next = !autostart;
    setWorking(true);
    setError("");
    try {
      await setAutostartEnabled(next);
      setAutostart(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось изменить автозапуск");
    } finally {
      setWorking(false);
    }
  };

  const connectSync = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true);
    setError("");
    try {
      await onConnectSync(apiUrl, setupCode, deviceName);
      setSetupCode("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось подключить синхронизацию");
    } finally {
      setWorking(false);
    }
  };

  const runSync = async () => {
    setWorking(true);
    setError("");
    try {
      await onSyncNow();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось синхронизировать данные");
    } finally {
      setWorking(false);
    }
  };

  const disconnectSync = async () => {
    if (!window.confirm("Отключить это устройство от синхронизации DayDesk?")) return;
    setWorking(true);
    setError("");
    try {
      await onDisconnectSync();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отключить синхронизацию");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <header className="settings-header"><div><span className="eyebrow">ПОВЕДЕНИЕ ПРИЛОЖЕНИЯ</span><h2 id="settings-title">Настройки DayDesk</h2></div><button className="icon-button mail-reader-close" onClick={onClose} aria-label="Закрыть настройки"><X size={20} /></button></header>
        <div className="settings-content">
          <div className="setting-row"><div className="setting-icon"><Bell size={19} /></div><div><strong>Фоновые напоминания</strong><span>После закрытия окна DayDesk остаётся в трее и продолжает следить за встречами.</span></div><span className="setting-status">Включены</span></div>
          <div className="setting-row"><div className="setting-icon"><Rocket size={19} /></div><div><strong>Запускать при входе в систему</strong><span>DayDesk запустится скрыто, чтобы напоминания работали сразу после входа в Windows или macOS.</span></div><button type="button" className={`setting-toggle ${autostart ? "active" : ""}`} role="switch" aria-checked={autostart} disabled={loading || working} onClick={() => void toggleAutostart()}><i /></button></div>
          {syncDevice ? (
            <div className="sync-settings-card">
              <div className="sync-settings-head"><div className="setting-icon"><Server size={19} /></div><div><strong>Синхронизация DayDesk подключена</strong><span>{syncDevice.deviceName} · {syncDevice.apiUrl}</span>{lastSyncedAt ? <small>Последний обмен: {new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }).format(new Date(lastSyncedAt))}</small> : null}</div><span className={`sync-dot ${syncPhase}`} /></div>
              <div className="sync-settings-actions"><button type="button" className="secondary-button" disabled={working || syncPhase === "syncing"} onClick={() => void runSync()}>{syncPhase === "syncing" ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}Синхронизировать</button><button type="button" className="danger-button" disabled={working || syncPhase === "syncing"} onClick={() => void disconnectSync()}><Trash2 size={15} />Отключить</button></div>
            </div>
          ) : (
            <form className="sync-settings-card sync-connect-form" onSubmit={connectSync}>
              <div className="sync-settings-head"><div className="setting-icon"><Server size={19} /></div><div><strong>Общие планы на всех устройствах</strong><span>Синхронизируйте задачи, локальные встречи и «Ритм дня» с мобильным приложением.</span></div></div>
              <div className="sync-fields"><label>Адрес сервера<input type="url" required maxLength={500} autoComplete="url" value={apiUrl} onChange={(event) => setApiUrl(event.target.value)} placeholder="https://sync.example.com" /></label><label>Название устройства<input required maxLength={80} autoComplete="off" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} /></label><label className="field-full">Setup-код<input type="password" required minLength={12} maxLength={256} autoComplete="one-time-code" value={setupCode} onChange={(event) => setSetupCode(event.target.value)} placeholder="Код из настроек сервера" /></label></div>
              <button className="primary-button" type="submit" disabled={working}>{working ? <LoaderCircle className="spin" size={15} /> : <LockKeyhole size={15} />}Подключить безопасно</button>
            </form>
          )}
          <div className="background-note"><ShieldCheck size={18} /><span>Полный выход доступен через меню иконки DayDesk в системном трее. Обычное закрытие окна безопасно сворачивает приложение в фон.</span></div>
          {error || syncError ? <div className="form-error" role="alert">{error || syncError}</div> : null}
        </div>
        <footer className="settings-footer"><button className="danger-button" onClick={() => void quitDayDesk()}><Power size={16} />Выйти полностью</button><button className="primary-button" onClick={onClose}>Готово</button></footer>
      </section>
    </div>
  );
}

function MiniCalendar({ events, selectedDate = new Date(), onSelect }: { events: CalendarEvent[]; selectedDate?: Date; onSelect?: (date: Date) => void }) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 3);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  return (
    <div className="week-strip">
      {days.map((day) => {
        const isSelected = sameDay(day, selectedDate);
        const hasEvents = events.some((event) => eventOccursOnDate(event, day));
        return <button key={day.toISOString()} className={isSelected ? "selected" : ""} onClick={() => onSelect?.(day)} aria-label={longDate(day)}><span>{weekday(day)}</span><strong>{day.getDate()}</strong>{hasEvents ? <i /> : null}</button>;
      })}
    </div>
  );
}

function TaskRow({ task, onToggle, onEdit, onSnooze }: { task: Task; onToggle: (id: string) => void; onEdit?: (task: Task) => void; onSnooze?: (task: Task) => void }) {
  const now = Date.now();
  const dueAt = new Date(task.dueAt).getTime();
  const snoozed = task.snoozedUntil && new Date(task.snoozedUntil).getTime() > now;
  const canSnooze = task.reminderEnabled
    && !task.completed
    && !snoozed
    && now >= dueAt - (task.remindBeforeMinutes ?? 0) * 60_000
    && now < dueAt + 24 * 60 * 60_000;
  return (
    <div className={`task-row ${task.completed ? "completed" : ""}`}>
      <button className="task-check" onClick={() => onToggle(task.id)} aria-label={task.completed ? "Вернуть задачу" : "Завершить задачу"}>
        {task.completed ? <Check size={14} /> : <Circle size={18} />}
      </button>
      <div className="task-copy"><strong>{task.title}</strong><span><Clock3 size={13} />{taskDateLabel(task.dueAt)}, {shortTime(task.dueAt)} · {task.category}{task.recurrence ? ` · ${taskRecurrenceLabel[task.recurrence.mode]}` : ""}{snoozed ? ` · отложено до ${shortTime(task.snoozedUntil!)}` : ""}{task.reminderEnabled ? <Bell size={11} /> : null}</span></div>
      <span className={`priority ${task.priority}`} />
      {onSnooze && canSnooze ? <button className="task-snooze" onClick={() => onSnooze(task)} title="Отложить напоминание на 10 минут"><Bell size={13} /><span>10</span></button> : null}
      {onEdit ? <button className="icon-button task-edit" onClick={() => onEdit(task)} aria-label={`Изменить задачу «${task.title}»`}><MoreHorizontal size={18} /></button> : null}
    </div>
  );
}

function EventIcon({ type }: { type: CalendarEvent["type"] }) {
  if (type === "meal") return <Utensils size={17} />;
  if (type === "focus") return <Sparkles size={17} />;
  if (type === "meeting") return <Video size={17} />;
  return <CalendarDays size={17} />;
}

function EventRow({ event, onEdit }: { event: CalendarEvent; onEdit?: (event: CalendarEvent) => void }) {
  const source = event.calendar?.provider === "gmail" ? "Google Calendar" : event.calendar?.provider === "outlook" ? "Outlook Calendar" : undefined;
  return (
    <div className={`event-row event-${event.type}`}>
      <div className="event-time"><strong>{event.allDay ? "Весь день" : shortTime(event.startsAt)}</strong><span>{event.allDay ? "" : shortTime(event.endsAt)}</span></div>
      <div className="event-bar" />
      <div className="event-icon"><EventIcon type={event.type} /></div>
      <div className="event-copy"><strong>{event.title}</strong><span>{[event.location ?? (event.type === "meal" ? "Перерыв" : "Личное время"), source].filter(Boolean).join(" · ")}</span></div>
      {onEdit && !event.calendar?.readOnly ? <button className="icon-button event-menu" onClick={() => onEdit(event)} aria-label={`Изменить событие «${event.title}»`}><MoreHorizontal size={18} /></button> : null}
    </div>
  );
}

function MailPreview({ state, setState, messages = state.messages, searchQuery = "", limit = 4, onShowAll, onOpen }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; messages?: MailMessage[]; searchQuery?: string; limit?: number; onShowAll?: () => void; onOpen?: (message: MailMessage) => void }) {
  const unread = messages.filter((message) => message.unread).length;
  const markRead = (id: string) => setState((current) => ({ ...current, messages: current.messages.map((message) => message.id === id ? { ...message, unread: false } : message) }));
  const searching = Boolean(searchQuery.trim());
  return (
    <section className="card mail-card">
      <div className="card-head"><div><span className="eyebrow"><Inbox size={15} />{searching ? "ПОИСК ПО ПОЧТЕ" : "ВХОДЯЩИЕ"}</span><h2>{searching ? "Результаты поиска" : "Свежая почта"} <span>{searching ? messages.length : unread}</span></h2></div>{onShowAll && !searching ? <button className="text-button" onClick={onShowAll}>Все письма <ChevronRight size={16} /></button> : null}</div>
      <div className="mail-list">
        {messages.length === 0 ? <div className="empty-state">{searching ? `По запросу «${searchQuery.trim()}» ничего не найдено.` : "Подключите почту, и свежие письма появятся здесь."}</div> : messages.slice(0, limit).map((message) => (
          <button className={`mail-row ${message.unread ? "unread" : ""}`} key={message.id} onClick={() => { markRead(message.id); onOpen?.(message); }}>
            <div className="sender-avatar" style={{ background: message.color }}>{message.initials}</div>
            <div className="mail-copy"><div><strong>{message.sender}</strong><time>{shortTime(message.receivedAt)}</time></div><b>{message.subject}</b><span>{message.preview}</span></div>
            {message.hasAttachments ? <Paperclip size={15} className="attachment-icon" /> : null}
            {message.starred ? <Star size={16} fill="#f8b84a" color="#f8b84a" /> : null}
            {message.unread ? <i className="unread-dot" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function MailReader({ message, loading, error, downloadingAttachment, downloadStatus, onClose, onRetry, onDownload, onReply }: { message: MailMessage; loading: boolean; error: string; downloadingAttachment: string | null; downloadStatus: string; onClose: () => void; onRetry: () => void; onDownload: (attachment: MailAttachment) => void; onReply: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const received = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short" }).format(new Date(message.receivedAt));
  return (
    <div className="modal-backdrop mail-reader-backdrop" onMouseDown={onClose}>
      <article className="mail-reader" aria-labelledby="mail-reader-subject" onMouseDown={(event) => event.stopPropagation()}>
        <header className="mail-reader-header">
          <div className="sender-avatar mail-reader-avatar" style={{ background: message.color }}>{message.initials}</div>
          <div><strong>{message.sender}</strong><span>{received}</span></div>
          <button className="secondary-button mail-reader-reply" onClick={onReply}><Reply size={15} />Ответить</button>
          <button className="icon-button mail-reader-close" onClick={onClose} aria-label="Закрыть письмо"><X size={20} /></button>
        </header>
        <div className="mail-reader-title"><span className="eyebrow">ПИСЬМО</span><h2 id="mail-reader-subject">{message.subject}</h2>{message.hasAttachments ? <span className="attachment-chip"><Paperclip size={14} />{message.attachments?.length ? `${message.attachments.length} влож.` : "Есть вложения"}</span> : null}</div>
        <div className="mail-reader-content">
          {loading ? <div className="mail-reader-status"><LoaderCircle className="spin" size={22} />Загружаем защищённое содержимое…</div> : error ? <div className="mail-reader-status error"><span>{error}</span><button className="secondary-button" onClick={onRetry}>Повторить</button></div> : <div className="mail-reader-body">{message.body ?? message.preview}</div>}
          {!loading && !error && message.attachments?.length ? <div className="mail-attachments"><strong>Вложения</strong>{message.attachments.map((attachment) => <button key={attachment.id} disabled={!attachment.downloadable || downloadingAttachment !== null} onClick={() => onDownload(attachment)} title={attachment.downloadable ? "Сохранить в папку «Загрузки»" : "Это вложение нельзя скачать автоматически"}><span className="attachment-file"><Paperclip size={16} /></span><span><b>{attachment.name}</b><small>{fileSize(attachment.size)} · {attachment.mimeType}</small></span>{downloadingAttachment === attachment.id ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}</button>)}</div> : null}
          {downloadStatus ? <div className={`attachment-status ${downloadStatus.startsWith("Ошибка:") ? "error" : ""}`} role="status">{downloadStatus}</div> : null}
        </div>
        <footer className="mail-reader-footer"><ShieldCheck size={15} /><span>DayDesk показывает только безопасный текст. Скрипты, удалённые изображения и трекеры не загружаются.</span></footer>
      </article>
    </div>
  );
}

interface MailDraftSeed {
  to?: string;
  subject?: string;
  reply?: boolean;
}

const splitRecipients = (value: string) => value
  .split(/[;,]/)
  .map((address) => address.trim())
  .filter(Boolean);

const extractEmailAddress = (value: string) => {
  const angleAddress = value.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1];
  if (angleAddress) return angleAddress;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim() : "";
};

const smtpSettings = (account: MailAccount) => {
  if (account.smtpHost && account.smtpPort) return { host: account.smtpHost, port: account.smtpPort };
  const known: Record<string, { host: string; port: number }> = {
    "imap.yandex.ru": { host: "smtp.yandex.ru", port: 465 },
    "imap.mail.ru": { host: "smtp.mail.ru", port: 465 },
    "imap.mail.me.com": { host: "smtp.mail.me.com", port: 587 },
  };
  if (account.imapHost && known[account.imapHost]) return known[account.imapHost];
  return { host: account.imapHost?.replace(/^imap\./i, "smtp.") ?? "", port: 465 };
};

function MailComposer({ accounts, seed, onClose, onSent }: { accounts: MailAccount[]; seed?: MailDraftSeed; onClose: () => void; onSent: () => void }) {
  const [accountId, setAccountId] = useState(() => accounts[0]?.id ?? "");
  const [to, setTo] = useState(() => seed?.to ?? "");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(() => seed?.subject ?? "");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<SelectedMailAttachment[]>([]);
  const [choosingFiles, setChoosingFiles] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const selectedAccount = accounts.find((account) => account.id === accountId);

  const discardAttachments = useCallback((tokens: string[]) => {
    if (tokens.length > 0) void clearMailAttachments(tokens).catch(() => undefined);
  }, []);

  const close = useCallback(() => {
    discardAttachments(attachments.map((attachment) => attachment.token));
    onClose();
  }, [attachments, discardAttachments, onClose]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [close, sending]);

  const chooseFiles = async () => {
    setChoosingFiles(true);
    setError("");
    try {
      const selected = await selectMailAttachments();
      const merged = [...attachments, ...selected];
      const total = merged.reduce((sum, attachment) => sum + attachment.size, 0);
      if (merged.length > 10 || total > 2 * 1024 * 1024) {
        discardAttachments(selected.map((attachment) => attachment.token));
        setError("Можно прикрепить до 10 файлов общим размером не больше 2 МБ");
        return;
      }
      setAttachments(merged);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось выбрать вложение");
    } finally {
      setChoosingFiles(false);
    }
  };

  const removeAttachment = (token: string) => {
    discardAttachments([token]);
    setAttachments((current) => current.filter((attachment) => attachment.token !== token));
  };

  const review = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const recipients = [...splitRecipients(to), ...splitRecipients(cc), ...splitRecipients(bcc)];
    if (!selectedAccount) {
      setError("Выберите аккаунт отправителя");
      return;
    }
    if (splitRecipients(to).length === 0 || recipients.length > 25 || recipients.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
      setError("Проверьте адреса получателей. Разделяйте их запятыми");
      return;
    }
    if (subject.length > 500 || body.length > 200_000) {
      setError("Тема или текст письма превышают допустимый размер");
      return;
    }
    if (!body.trim() && attachments.length === 0) {
      setError("Добавьте текст или вложение");
      return;
    }
    setConfirming(true);
  };

  const deliver = async () => {
    if (!selectedAccount) return;
    setSending(true);
    setError("");
    const smtp = smtpSettings(selectedAccount);
    try {
      await sendMail({
        provider: selectedAccount.provider,
        accountId: selectedAccount.id,
        fromAddress: selectedAccount.address,
        smtpHost: selectedAccount.provider === "imap" ? smtp.host : undefined,
        smtpPort: selectedAccount.provider === "imap" ? smtp.port : undefined,
        to: splitRecipients(to),
        cc: splitRecipients(cc),
        bcc: splitRecipients(bcc),
        subject: subject.trim(),
        body,
        attachmentTokens: attachments.map((attachment) => attachment.token),
      });
      onSent();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отправить письмо");
      setConfirming(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop mail-reader-backdrop" onMouseDown={close}>
      <form className="mail-composer" aria-labelledby="mail-composer-title" onSubmit={review} onMouseDown={(event) => event.stopPropagation()}>
        <header className="composer-header"><div><span className="eyebrow">ИСХОДЯЩЕЕ ПИСЬМО</span><h2 id="mail-composer-title">{seed?.reply ? "Ответить" : "Новое письмо"}</h2></div><button type="button" className="icon-button mail-reader-close" onClick={close} aria-label="Закрыть редактор"><X size={20} /></button></header>
        {confirming ? <div className="composer-confirmation">
          <div className="confirmation-icon"><Send size={24} /></div>
          <span className="eyebrow">ПРОВЕРКА ПЕРЕД ОТПРАВКОЙ</span>
          <h3>Отправить это письмо?</h3>
          <dl><div><dt>От кого</dt><dd>{selectedAccount?.address}</dd></div><div><dt>Кому</dt><dd>{splitRecipients(to).join(", ")}</dd></div><div><dt>Тема</dt><dd>{subject.trim() || "Без темы"}</dd></div><div><dt>Вложения</dt><dd>{attachments.length ? `${attachments.length}, ${fileSize(attachments.reduce((sum, attachment) => sum + attachment.size, 0))}` : "Нет"}</dd></div></dl>
          <div className="security-note"><ShieldCheck size={17} /><span>После подтверждения DayDesk сразу передаст письмо выбранному почтовому сервису. Отменить отправку после этого нельзя.</span></div>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <div className="composer-actions"><button type="button" className="secondary-button" disabled={sending} onClick={() => setConfirming(false)}>Вернуться</button><button type="button" className="primary-button" disabled={sending} onClick={() => void deliver()}>{sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}{sending ? "Отправляем…" : "Да, отправить"}</button></div>
        </div> : <>
          <div className="composer-fields">
            <label>От кого<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.address}</option>)}</select></label>
            <label>Кому<input autoFocus value={to} maxLength={4000} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" /></label>
            <div className="composer-copy-fields"><label>Копия<input value={cc} maxLength={4000} onChange={(event) => setCc(event.target.value)} placeholder="Необязательно" /></label><label>Скрытая копия<input value={bcc} maxLength={4000} onChange={(event) => setBcc(event.target.value)} placeholder="Необязательно" /></label></div>
            <label>Тема<input value={subject} maxLength={500} onChange={(event) => setSubject(event.target.value)} placeholder="О чём письмо" /></label>
            <label className="composer-body-label">Текст<textarea value={body} maxLength={200000} onChange={(event) => setBody(event.target.value)} placeholder="Напишите сообщение…" /></label>
          </div>
          <div className="composer-attachments"><div><strong>Вложения</strong><span>До 10 файлов, всего не больше 2 МБ</span></div><button type="button" className="secondary-button" disabled={choosingFiles} onClick={() => void chooseFiles()}>{choosingFiles ? <LoaderCircle className="spin" size={16} /> : <FilePlus2 size={16} />}Прикрепить</button>{attachments.length ? <div className="composer-file-list">{attachments.map((attachment) => <div key={attachment.token}><Paperclip size={15} /><span><b>{attachment.name}</b><small>{fileSize(attachment.size)} · {attachment.mimeType}</small></span><button type="button" className="icon-button" onClick={() => removeAttachment(attachment.token)} aria-label={`Убрать ${attachment.name}`}><X size={15} /></button></div>)}</div> : null}</div>
          {error ? <div className="form-error composer-error" role="alert">{error}</div> : null}
          <footer className="composer-footer"><span>Черновик хранится только до закрытия окна</span><button className="primary-button"><Send size={17} />Проверить и отправить</button></footer>
        </>}
      </form>
    </div>
  );
}

function TaskEditor({ existing, onSave, onDelete, onClose }: { existing?: Task; onSave: (task: Task) => void; onDelete: (task: Task) => void; onClose: () => void }) {
  const defaultDueAt = useMemo(() => {
    const due = new Date();
    due.setMinutes(0, 0, 0);
    due.setHours(due.getHours() + 1);
    return due.toISOString();
  }, []);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [date, setDate] = useState(() => inputDate(existing?.dueAt ?? defaultDueAt));
  const [time, setTime] = useState(() => inputTime(existing?.dueAt ?? defaultDueAt));
  const [priority, setPriority] = useState<Task["priority"]>(existing?.priority ?? "medium");
  const [category, setCategory] = useState(existing?.category ?? "Личное");
  const [reminderEnabled, setReminderEnabled] = useState(existing?.reminderEnabled ?? true);
  const [remindBeforeMinutes, setRemindBeforeMinutes] = useState(existing?.remindBeforeMinutes ?? 10);
  const [recurrenceMode, setRecurrenceMode] = useState<"none" | TaskRecurrenceMode>(existing?.recurrence?.mode ?? "none");
  const [recurrenceDays, setRecurrenceDays] = useState(existing?.recurrence?.days ?? [1, 2, 3, 4, 5]);
  const [error, setError] = useState("");
  const [taskId] = useState(() => existing?.id ?? uid());
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    if (recurrenceMode === "custom" && recurrenceDays.length === 0) {
      setError("Выберите хотя бы один день повтора");
      return;
    }
    const dueAt = combineDateTime(date, time);
    onSave({
      id: taskId,
      title: title.trim(),
      completed: existing?.completed ?? false,
      dueAt,
      priority,
      category: category.trim() || "Личное",
      remindBeforeMinutes: reminderEnabled ? remindBeforeMinutes : 0,
      reminderEnabled,
      recurrence: recurrenceMode === "none" ? undefined : {
        mode: recurrenceMode,
        days: recurrenceMode === "custom" ? routineWeekdays.map((day) => day.value).filter((day) => recurrenceDays.includes(day)) : [],
        seriesId: existing?.recurrence?.seriesId ?? taskId,
      },
      snoozedUntil: existing && dueAt === existing.dueAt ? existing.snoozedUntil : undefined,
    });
  };
  const toggleRecurrenceDay = (day: number) => {
    setRecurrenceDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day]);
    setError("");
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="quick-modal task-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><ListTodo size={22} /></div>
        <div><span className="eyebrow">ЗАДАЧА</span><h2>{existing ? "Изменить задачу" : "Что нужно сделать?"}</h2></div>
        <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        <div className="form-grid">
          <label className="field-full">Название<input autoFocus maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, позвонить врачу" /></label>
          <label>Дата<input required type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label>Время<input required type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
          <label>Приоритет<select value={priority} onChange={(event) => setPriority(event.target.value as Task["priority"])}><option value="high">Высокий</option><option value="medium">Средний</option><option value="low">Низкий</option></select></label>
          <label>Категория<input maxLength={50} value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Личное" /></label>
          <label className="field-full">Напомнить<select value={reminderEnabled ? String(remindBeforeMinutes) : "none"} onChange={(event) => { const value = event.target.value; setReminderEnabled(value !== "none"); if (value !== "none") setRemindBeforeMinutes(Number(value)); }}><option value="none">Не напоминать</option><option value="0">В срок задачи</option><option value="5">За 5 минут</option><option value="10">За 10 минут</option><option value="30">За 30 минут</option><option value="60">За 1 час</option><option value="1440">За 1 день</option></select></label>
          <label className="field-full">Повторять<select value={recurrenceMode} onChange={(event) => { setRecurrenceMode(event.target.value as "none" | TaskRecurrenceMode); setError(""); }}><option value="none">Не повторять</option><option value="daily">Каждый день</option><option value="weekdays">По будням</option><option value="weekly">Каждую неделю</option><option value="custom">В выбранные дни</option></select></label>
          {recurrenceMode === "custom" ? <fieldset className="routine-days task-recurrence-days"><legend>Дни повтора</legend><div>{routineWeekdays.map((day) => <button key={day.value} type="button" className={recurrenceDays.includes(day.value) ? "active" : ""} aria-pressed={recurrenceDays.includes(day.value)} onClick={() => toggleRecurrenceDay(day.value)}>{day.short}</button>)}</div></fieldset> : null}
        </div>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <div className="modal-actions event-actions">{existing ? <button type="button" className="danger-button" onClick={() => onDelete(existing)}><Trash2 size={16} />Удалить</button> : null}<span /><button type="button" className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button"><Check size={17} />Сохранить</button></div>
      </form>
    </div>
  );
}

function EventEditor({ existing, accounts, onSave, onDelete, onClose }: { existing?: CalendarEvent; accounts: MailAccount[]; onSave: (event: CalendarEvent) => Promise<void>; onDelete: (event: CalendarEvent) => Promise<void>; onClose: () => void }) {
  const defaults = useMemo(() => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 60 * 60_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, []);
  const [title, setTitle] = useState(() => existing?.title ?? "");
  const [date, setDate] = useState(() => inputDate(existing?.startsAt ?? defaults.start));
  const [endDate, setEndDate] = useState(() => inputDate(existing?.endsAt ?? defaults.end));
  const [startsAt, setStartsAt] = useState(() => inputTime(existing?.startsAt ?? defaults.start));
  const [endsAt, setEndsAt] = useState(() => inputTime(existing?.endsAt ?? defaults.end));
  const [type, setType] = useState<CalendarEvent["type"]>(() => existing?.type ?? "meeting");
  const [location, setLocation] = useState(() => existing?.location ?? "");
  const [reminder, setReminder] = useState(() => existing?.remindBeforeMinutes ?? 10);
  const [reminderEnabled, setReminderEnabled] = useState(() => existing ? (existing.calendar?.reminderEnabled ?? existing.remindBeforeMinutes > 0) : true);
  const [reminderDirty, setReminderDirty] = useState(() => !existing);
  const [usesDefaultReminder, setUsesDefaultReminder] = useState(() => existing?.calendar?.usesDefaultReminder ?? false);
  const [calendarAccountId, setCalendarAccountId] = useState(() => existing?.calendar?.accountId ?? "local");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [operationId] = useState(uid);
  const calendarAccounts = accounts.filter((account) => isCalendarAccount(account) && account.calendarEnabled);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim() || working) return;
    const start = combineDateTime(date, startsAt);
    const end = combineDateTime(endDate, endsAt);
    if (new Date(end) <= new Date(start)) {
      setError("Время окончания должно быть позже начала");
      return;
    }
    const account = calendarAccounts.find((item) => item.id === calendarAccountId);
    const normalizedLocation = location.trim() || undefined;
    const updateTitle = !existing || title.trim() !== existing.title;
    const updateTime = !existing
      || date !== inputDate(existing.startsAt)
      || startsAt !== inputTime(existing.startsAt)
      || endDate !== inputDate(existing.endsAt)
      || endsAt !== inputTime(existing.endsAt);
    const updateLocation = !existing || normalizedLocation !== existing.location;
    setError("");
    setWorking(true);
    try {
      await onSave({
        id: existing?.id ?? uid(),
        title: title.trim(),
        startsAt: start,
        endsAt: end,
        type,
        location: normalizedLocation,
        remindBeforeMinutes: reminderEnabled ? reminder : 0,
        calendar: account ? { provider: account.provider as OAuthProvider, accountId: account.id, remoteId: existing?.calendar?.remoteId, version: existing?.calendar?.version, reminderEnabled, usesDefaultReminder, updateReminders: reminderDirty, updateTitle, updateTime, updateLocation, operationId } : undefined,
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось сохранить событие");
      setWorking(false);
    }
  };

  const remove = async () => {
    if (!existing || !window.confirm(`Удалить событие «${existing.title}»?`)) return;
    setError("");
    setWorking(true);
    try {
      await onDelete(existing);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось удалить событие");
      setWorking(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="quick-modal event-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><CalendarDays size={22} /></div>
        <div><span className="eyebrow">{existing ? "РЕДАКТИРОВАНИЕ" : "НОВОЕ СОБЫТИЕ"}</span><h2>{existing ? "Изменить событие" : "Добавить в расписание"}</h2></div>
        <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        <div className="form-grid">
          <label className="field-full">Название<input autoFocus maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, встреча с командой" /></label>
          <label>Тип<select value={type} onChange={(event) => setType(event.target.value as CalendarEvent["type"])}><option value="meeting">Встреча</option><option value="meal">Обед или ужин</option><option value="focus">Фокус-время</option><option value="personal">Личное</option></select></label>
          <label>Дата начала<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label>Дата окончания<input type="date" value={endDate} min={date} onChange={(event) => setEndDate(event.target.value)} /></label>
          <label>Начало<input type="time" value={startsAt} onChange={(event) => { setStartsAt(event.target.value); setError(""); }} /></label>
          <label>Окончание<input type="time" value={endsAt} onChange={(event) => { setEndsAt(event.target.value); setError(""); }} /></label>
          <label className="field-full">Место или ссылка<input maxLength={500} value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Необязательно" /></label>
          <label>Напомнить<select value={usesDefaultReminder ? "default" : reminderEnabled ? `minutes:${reminder}` : "none"} onChange={(event) => { const value = event.target.value; setReminderDirty(true); setUsesDefaultReminder(value === "default"); setReminderEnabled(value !== "none"); if (value.startsWith("minutes:")) setReminder(Number(value.slice(8))); }}>{usesDefaultReminder ? <option value="default">По умолчанию календаря</option> : null}<option value="none">Не напоминать</option>{calendarAccountId !== "local" ? <option value="minutes:0">В момент начала</option> : null}<option value="minutes:5">За 5 минут</option><option value="minutes:10">За 10 минут</option><option value="minutes:15">За 15 минут</option><option value="minutes:30">За 30 минут</option><option value="minutes:60">За 1 час</option></select></label>
          <label>Календарь<select value={calendarAccountId} disabled={Boolean(existing?.calendar)} onChange={(event) => setCalendarAccountId(event.target.value)}><option value="local">Только DayDesk</option>{calendarAccounts.map((account) => <option key={account.id} value={account.id}>{account.provider === "gmail" ? "Google" : "Outlook"} · {account.address}</option>)}</select></label>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="modal-actions event-actions">{existing ? <button type="button" className="danger-button" disabled={working} onClick={() => void remove()}><Trash2 size={16} />Удалить</button> : null}<span /><button type="button" className="secondary-button" disabled={working} onClick={onClose}>Отмена</button><button className="primary-button" disabled={working}>{working ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{working ? "Сохраняем…" : "Сохранить"}</button></div>
      </form>
    </div>
  );
}

function TodayView({ state, setState, onAddTask, onEditTask, onAddEvent, onEditEvent }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; onAddTask: () => void; onEditTask: (task: Task) => void; onAddEvent: () => void; onEditEvent: (event: CalendarEvent) => void }) {
  const now = useClock();
  const greeting = now.getHours() < 12 ? "Доброе утро" : now.getHours() < 18 ? "Добрый день" : "Добрый вечер";
  const todayTasks = state.tasks.filter((task) => sameDay(new Date(task.dueAt), now)).sort((left, right) => left.dueAt.localeCompare(right.dueAt));
  const completed = todayTasks.filter((task) => task.completed).length;
  const progress = todayTasks.length ? Math.round((completed / todayTasks.length) * 100) : 0;
  const todayEvents = [...state.events, ...routineOccurrences(state.routines ?? [], 1, now)].filter((event) => eventOccursOnDate(event, now)).sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const toggleTask = (id: string) => setState((current) => toggleTaskCompletion(current, id));
  const snoozeTask = (task: Task) => setState((current) => snoozeTaskReminder(current, task.id));
  return (
    <>
      <div className="welcome-row"><div><p>{longDate(now)}</p><h1>{greeting}, Олег <span>👋</span></h1><span>Спокойный день начинается с ясного плана.</span></div><div className="weather"><div>☀️</div><strong>+18°</strong><span>Москва</span></div></div>
      <MiniCalendar events={state.events} selectedDate={now} />
      <div className="dashboard-grid">
        <section className="card tasks-card">
          <div className="card-head"><div><span className="eyebrow"><CheckCircle2 size={15} />ЗАДАЧИ</span><h2>На сегодня <span>{todayTasks.filter((task) => !task.completed).length}</span></h2></div><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div></div>
          <div className="task-list">{todayTasks.length ? todayTasks.map((task) => <TaskRow key={task.id} task={task} onToggle={toggleTask} onEdit={onEditTask} onSnooze={snoozeTask} />) : <div className="empty-state">На сегодня задач нет</div>}</div>
          <button className="add-row" onClick={onAddTask}><Plus size={17} />Добавить задачу</button>
        </section>
        <section className="card schedule-card">
          <div className="card-head"><div><span className="eyebrow"><CalendarDays size={15} />РАСПИСАНИЕ</span><h2>Ближайшее</h2></div><button className="date-chip">Сегодня <ChevronDown size={14} /></button></div>
          <div className="event-list">{todayEvents.length ? todayEvents.slice(0, 4).map((event) => <EventRow key={event.id} event={event} onEdit={event.routineId ? undefined : onEditEvent} />) : <div className="empty-state">На сегодня событий нет</div>}</div>
          <button className="add-row" onClick={onAddEvent}><Plus size={17} />Добавить событие</button>
        </section>
      </div>
      <MailPreview state={state} setState={setState} />
    </>
  );
}

function TasksView({ state, setState, onAdd, onEdit }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; onAdd: () => void; onEdit: (task: Task) => void }) {
  const toggle = (id: string) => setState((current) => toggleTaskCompletion(current, id));
  const snooze = (task: Task) => setState((current) => snoozeTaskReminder(current, task.id));
  const tasks = [...state.tasks].sort((left, right) => left.completed === right.completed ? left.dueAt.localeCompare(right.dueAt) : Number(left.completed) - Number(right.completed));
  return <section className="page-section"><div className="page-title"><div><span className="eyebrow">МОЙ ДЕНЬ</span><h1>Задачи</h1><p>Соберите всё важное в одном спокойном списке.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17} />Новая задача</button></div><div className="card large-list">{tasks.map((task) => <TaskRow key={task.id} task={task} onToggle={toggle} onEdit={onEdit} onSnooze={snooze} />)}<button className="add-row" onClick={onAdd}><Plus size={17} />Добавить задачу</button></div></section>;
}

function CalendarView({ state, setState, onAdd, onEdit }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; onAdd: () => void; onEdit: (event: CalendarEvent) => void }) {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [workingAccount, setWorkingAccount] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const calendarAccounts = state.accounts.filter(isCalendarAccount);
  const selectedEvents = useMemo(() => [...state.events, ...routineOccurrences(state.routines ?? [], 1, selectedDate)].filter((event) => eventOccursOnDate(event, selectedDate)).sort((left, right) => left.startsAt.localeCompare(right.startsAt)), [state.events, state.routines, selectedDate]);

  const synchronize = async (account: MailAccount & { provider: OAuthProvider }, enable = false) => {
    const startedAtMutation = calendarMutationVersion;
    const syncVersion = ++calendarSyncVersion;
    setWorkingAccount(account.id);
    setError("");
    setStatus("");
    try {
      const events = await fetchCalendarEvents(account);
      if (startedAtMutation !== calendarMutationVersion || syncVersion !== calendarSyncVersion) {
        setStatus("Календарь изменился во время обновления — запустите синхронизацию ещё раз");
        return;
      }
      const syncedAt = new Date().toISOString();
      setState((current) => {
        const currentAccount = current.accounts.find((item) => item.id === account.id);
        if (!currentAccount || !isCalendarAccount(currentAccount) || (!enable && !currentAccount.calendarEnabled)) {
          return current;
        }
        return {
          ...current,
          events: replaceAccountCalendarEvents(current.events, account.id, events),
          accounts: current.accounts.map((item) => item.id === account.id ? { ...item, calendarEnabled: true, lastCalendarSyncedAt: syncedAt } : item),
        };
      });
      setStatus(`${account.provider === "gmail" ? "Google" : "Outlook"}: загружено событий — ${events.length}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось обновить календарь");
      if (enable) setState((current) => ({ ...current, accounts: current.accounts.map((item) => item.id === account.id ? { ...item, calendarEnabled: false } : item) }));
    } finally {
      setWorkingAccount(null);
    }
  };

  const toggleCalendar = (account: MailAccount & { provider: OAuthProvider }) => {
    if (!account.calendarEnabled) {
      void synchronize(account, true);
      return;
    }
    calendarMutationVersion += 1;
    calendarSyncVersion += 1;
    setState((current) => ({
      ...current,
      events: current.events.filter((event) => event.calendar?.accountId !== account.id),
      accounts: current.accounts.map((item) => item.id === account.id ? { ...item, calendarEnabled: false, lastCalendarSyncedAt: undefined } : item),
    }));
    setStatus(`${account.provider === "gmail" ? "Google" : "Outlook"} Calendar отключён. События в исходном календаре сохранены.`);
  };

  return <section className="page-section">
    <div className="page-title"><div><span className="eyebrow">ПЛАН НА ДЕНЬ</span><h1>Календарь</h1><p>Встречи, питание и фокус-время без накладок.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17} />Новое событие</button></div>
    {calendarAccounts.length > 0 ? <div className="calendar-account-grid">{calendarAccounts.map((account) => <div className={`card calendar-account-card ${account.calendarEnabled ? "enabled" : ""}`} key={account.id}><div className={`provider-logo ${account.provider}`}>{account.provider === "gmail" ? "M" : "O"}</div><div><strong>{account.provider === "gmail" ? "Google Calendar" : "Outlook Calendar"}</strong><span>{account.address}</span><small>{account.calendarEnabled ? account.lastCalendarSyncedAt ? `Обновлён ${shortTime(account.lastCalendarSyncedAt)}` : "Синхронизация включена" : "Синхронизация выключена"}</small></div><div className="calendar-account-actions">{account.calendarEnabled ? <button className="icon-button" disabled={workingAccount === account.id} onClick={() => void synchronize(account)} title="Обновить календарь">{workingAccount === account.id ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button> : null}<button className={`setting-toggle ${account.calendarEnabled ? "active" : ""}`} disabled={workingAccount === account.id} onClick={() => toggleCalendar(account)} aria-label={account.calendarEnabled ? "Отключить календарь" : "Включить календарь"}><i /></button></div></div>)}</div> : <div className="calendar-connect-note"><CalendarDays size={18} /><span>Подключите Gmail или Outlook в разделе «Почта», чтобы объединить рабочие календари с DayDesk.</span></div>}
    {error ? <div className="form-error calendar-sync-message" role="alert">{error}</div> : null}
    {status ? <div className="mail-action-status calendar-sync-message" role="status"><CheckCircle2 size={16} />{status}</div> : null}
    <MiniCalendar events={state.events} selectedDate={selectedDate} onSelect={setSelectedDate} />
    <div className="calendar-date-title"><strong>{longDate(selectedDate)}</strong><span>{selectedEvents.length} {selectedEvents.length === 1 ? "событие" : selectedEvents.length > 1 && selectedEvents.length < 5 ? "события" : "событий"}</span></div>
    <div className="card calendar-list">{selectedEvents.length ? selectedEvents.map((event) => <EventRow key={event.id} event={event} onEdit={event.routineId ? undefined : onEdit} />) : <div className="empty-state large">Свободный день — можно запланировать отдых или фокус-время.</div>}</div>
  </section>;
}

const mailPresets = [
  { label: "Yandex", host: "imap.yandex.ru", smtpHost: "smtp.yandex.ru", smtpPort: 465 },
  { label: "Mail.ru", host: "imap.mail.ru", smtpHost: "smtp.mail.ru", smtpPort: 465 },
  { label: "iCloud", host: "imap.mail.me.com", smtpHost: "smtp.mail.me.com", smtpPort: 587 },
];

const senderInitials = (sender: string) => sender
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0]?.toUpperCase())
  .join("") || "@";

function toMailMessages(account: MailAccount, messages: RemoteMailMessage[]): MailMessage[] {
  return messages.map((message) => ({
    ...message,
    id: `${account.id}:${message.id}`,
    accountId: account.id,
    initials: senderInitials(message.sender),
    starred: false,
    color: account.color,
  }));
}

function mergeAccountMessages(current: MailMessage[], accountId: string, fresh: MailMessage[]) {
  const previous = new Map(current.filter((message) => message.accountId === accountId).map((message) => [message.id, message]));
  const merged = fresh.map((message) => {
    const existing = previous.get(message.id);
    if (!existing) return message;
    return {
      ...message,
      unread: existing.unread ? message.unread : false,
      starred: existing.starred,
    };
  });
  return [...merged, ...current.filter((message) => message.accountId !== accountId)]
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
}

function MailConnectModal({ onConnected, onClose }: { onConnected: (account: MailAccount, messages: MailMessage[]) => void; onClose: () => void }) {
  const [label, setLabel] = useState("Личная почта");
  const [address, setAddress] = useState("");
  const [host, setHost] = useState("imap.yandex.ru");
  const [smtpHost, setSmtpHost] = useState("smtp.yandex.ru");
  const [smtpPort, setSmtpPort] = useState(465);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setPassword("");
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const normalizedAddress = address.trim();
    const normalizedHost = host.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedAddress)) {
      setError("Укажите полный адрес электронной почты");
      return;
    }
    if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(normalizedHost)) {
      setError("Укажите корректный адрес IMAP-сервера");
      return;
    }
    const normalizedSmtpHost = smtpHost.trim().toLowerCase();
    if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(normalizedSmtpHost) || ![465, 587].includes(smtpPort)) {
      setError("Укажите защищённый SMTP-сервер и порт 465 или 587");
      return;
    }
    if (!password || password.length > 1024) {
      setError("Введите пароль приложения от почтового ящика");
      return;
    }

    const account: MailAccount = {
      id: `mail_${uid().replace(/[^a-zA-Z0-9_-]/g, "")}`,
      provider: "imap",
      label: label.trim() || normalizedAddress,
      address: normalizedAddress,
      connected: true,
      color: "#7868f1",
      imapHost: normalizedHost,
      imapPort: 993,
      smtpHost: normalizedSmtpHost,
      smtpPort,
      authType: "password",
      lastSyncedAt: new Date().toISOString(),
    };

    setLoading(true);
    try {
      const loaded = await connectImap({
        accountId: account.id,
        host: normalizedHost,
        port: 993,
        username: normalizedAddress,
        password,
      });
      setPassword("");
      onConnected(account, toMailMessages(account, loaded));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось подключить почту");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form className="quick-modal mail-connect-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><LockKeyhole size={22} /></div>
        <div><span className="eyebrow">ЗАЩИЩЁННЫЙ IMAP</span><h2>Подключить почту</h2></div>
        <button type="button" className="icon-button modal-close" onClick={close}><X size={20} /></button>
        <div className="mail-presets" aria-label="Популярные почтовые серверы">
          {mailPresets.map((preset) => <button type="button" className={host === preset.host ? "active" : ""} key={preset.host} onClick={() => { setHost(preset.host); setSmtpHost(preset.smtpHost); setSmtpPort(preset.smtpPort); }}>{preset.label}</button>)}
        </div>
        <div className="form-grid">
          <label>Название аккаунта<input value={label} autoComplete="off" maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="Например, Рабочая" /></label>
          <label>Адрес почты<input autoFocus type="email" autoComplete="username" value={address} maxLength={320} onChange={(event) => setAddress(event.target.value)} placeholder="name@example.com" /></label>
          <label className="field-full">IMAP-сервер<input value={host} autoComplete="off" maxLength={253} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" /></label>
          <label>SMTP-сервер<input value={smtpHost} autoComplete="off" maxLength={253} onChange={(event) => setSmtpHost(event.target.value)} placeholder="smtp.example.com" /></label>
          <label>SMTP TLS-порт<select value={smtpPort} onChange={(event) => setSmtpPort(Number(event.target.value))}><option value={465}>465 · SMTPS</option><option value={587}>587 · STARTTLS</option></select></label>
          <label className="field-full">Пароль приложения<input type="password" autoComplete="current-password" value={password} maxLength={1024} onChange={(event) => setPassword(event.target.value)} placeholder="Не обычный пароль, если включена 2FA" /></label>
        </div>
        <div className="security-note"><ShieldCheck size={17} /><span>Пароль передаётся только IMAP-серверу по TLS и хранится в системном хранилище macOS или Windows. DayDesk его не записывает в данные приложения.</span></div>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Отмена</button><button className="primary-button" disabled={loading}>{loading ? <LoaderCircle className="spin" size={17} /> : <Server size={17} />}{loading ? "Проверяем…" : "Подключить"}</button></div>
      </form>
    </div>
  );
}

function MailView({ state, setState, searchQuery }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; searchQuery: string }) {
  const [showConnector, setShowConnector] = useState(false);
  const [composerSeed, setComposerSeed] = useState<MailDraftSeed | null>(null);
  const [mailActionStatus, setMailActionStatus] = useState("");
  const [workingAccount, setWorkingAccount] = useState<string | null>(null);
  const [workingProvider, setWorkingProvider] = useState<OAuthProvider | null>(null);
  const [oauthStatus, setOauthStatus] = useState<OAuthProviderStatus | null>(null);
  const [error, setError] = useState("");
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState("");
  const [downloadingAttachment, setDownloadingAttachment] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState("");
  const readerRequest = useRef(0);
  const [cachedSearchResults, setCachedSearchResults] = useState<MailMessage[] | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());
  const localSearchResults = useMemo(() => {
    const normalized = deferredSearchQuery.toLocaleLowerCase("ru-RU");
    if (!normalized) return state.messages;
    return state.messages.filter((message) => [message.sender, message.subject, message.preview]
      .some((value) => value.toLocaleLowerCase("ru-RU").includes(normalized)));
  }, [deferredSearchQuery, state.messages]);

  useEffect(() => {
    if (!deferredSearchQuery) {
      setCachedSearchResults(null);
      return;
    }
    let active = true;
    setCachedSearchResults(null);
    const timer = window.setTimeout(() => {
      void searchMailCache(deferredSearchQuery, 100)
        .then((messages) => { if (active && messages !== null) setCachedSearchResults(messages); })
        .catch(() => { if (active) setCachedSearchResults(null); });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [deferredSearchQuery, state.messages]);

  useEffect(() => {
    let active = true;
    void getOAuthProviderStatus()
      .then((status) => { if (active) setOauthStatus(status); })
      .catch(() => { if (active) setOauthStatus({ gmail: false, outlook: false }); });
    return () => { active = false; };
  }, []);

  const connected = (account: MailAccount, messages: MailMessage[]) => {
    setState((current) => ({
      ...current,
      accounts: [...current.accounts.filter((item) => item.id !== account.id), account],
      messages: mergeAccountMessages(current.messages, account.id, messages),
    }));
    setShowConnector(false);
  };

  const connectOAuthAccount = async (provider: OAuthProvider) => {
    setError("");
    setWorkingProvider(provider);
    const accountId = `mail_${uid().replace(/[^a-zA-Z0-9_-]/g, "")}`;
    try {
      const result = await connectOAuth({ provider, accountId });
      const account: MailAccount = {
        id: accountId,
        provider,
        label: result.label || (provider === "gmail" ? "Gmail" : "Outlook"),
        address: result.address,
        connected: true,
        color: provider === "gmail" ? "#e95c55" : "#3478f6",
        authType: "oauth",
        lastSyncedAt: new Date().toISOString(),
        calendarEnabled: true,
      };
      connected(account, toMailMessages(account, result.messages));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось подключить аккаунт");
    } finally {
      setWorkingProvider(null);
    }
  };

  const synchronize = async (account: MailAccount) => {
    const imapHost = account.imapHost;
    if (account.authType !== "oauth" && !imapHost) return;
    setError("");
    setWorkingAccount(account.id);
    try {
      const loaded = account.authType === "oauth"
        ? await syncOAuth({ provider: account.provider as OAuthProvider, accountId: account.id })
        : await syncImap({ accountId: account.id, host: imapHost ?? "", port: account.imapPort ?? 993, username: account.address });
      const messages = toMailMessages(account, loaded);
      setState((current) => ({
        ...current,
        accounts: current.accounts.map((item) => item.id === account.id ? { ...item, lastSyncedAt: new Date().toISOString() } : item),
        messages: mergeAccountMessages(current.messages, account.id, messages),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось обновить почту");
    } finally {
      setWorkingAccount(null);
    }
  };

  const disconnect = async (account: MailAccount) => {
    if (!window.confirm(`Отключить ${account.address} и удалить данные входа из системного хранилища?`)) return;
    setError("");
    setWorkingAccount(account.id);
    try {
      if (account.authType === "oauth") {
        await disconnectOAuth({ provider: account.provider as OAuthProvider, accountId: account.id });
      } else {
        await disconnectImap(account.id);
      }
      if (isCalendarAccount(account)) {
        calendarMutationVersion += 1;
        calendarSyncVersion += 1;
      }
      setState((current) => ({
        ...current,
        accounts: current.accounts.filter((item) => item.id !== account.id),
        messages: current.messages.filter((message) => message.accountId !== account.id),
        events: current.events.filter((event) => event.calendar?.accountId !== account.id),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отключить почту");
    } finally {
      setWorkingAccount(null);
    }
  };

  const openMessage = (requestedMessage: MailMessage) => {
    const message = state.messages.find((item) => item.id === requestedMessage.id) ?? requestedMessage;
    setSelectedMessageId(message.id);
    setReaderError("");
    setDownloadStatus("");
    if (message.body !== undefined) {
      setReaderLoading(false);
      return;
    }
    const account = state.accounts.find((item) => item.id === message.accountId);
    const prefix = `${message.accountId}:`;
    const remoteMessageId = message.id.startsWith(prefix) ? message.id.slice(prefix.length) : "";
    if (!account || !remoteMessageId) {
      setReaderError("Не удалось определить почтовый аккаунт для этого письма");
      setReaderLoading(false);
      return;
    }
    const requestId = ++readerRequest.current;
    setReaderLoading(true);
    void (account.authType === "oauth"
      ? getOAuthMessageContent({ provider: account.provider as OAuthProvider, accountId: account.id, messageId: remoteMessageId })
      : getImapMessageContent({ accountId: account.id, host: account.imapHost ?? "", port: account.imapPort ?? 993, username: account.address, messageId: remoteMessageId }))
      .then((content) => {
        setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === message.id ? { ...item, body: content.body, hasAttachments: content.hasAttachments, attachments: content.attachments } : item) }));
        if (readerRequest.current === requestId) setReaderError("");
      })
      .catch((reason) => {
        if (readerRequest.current === requestId) setReaderError(reason instanceof Error ? reason.message : "Не удалось загрузить письмо");
      })
      .finally(() => { if (readerRequest.current === requestId) setReaderLoading(false); });
  };

  const closeMessage = useCallback(() => {
    readerRequest.current += 1;
    setSelectedMessageId(null);
    setReaderLoading(false);
    setReaderError("");
    setDownloadingAttachment(null);
    setDownloadStatus("");
  }, []);

  const downloadAttachment = (message: MailMessage, attachment: MailAttachment) => {
    const account = state.accounts.find((item) => item.id === message.accountId);
    const prefix = `${message.accountId}:`;
    const remoteMessageId = message.id.startsWith(prefix) ? message.id.slice(prefix.length) : "";
    if (!account || !remoteMessageId || !attachment.downloadable) {
      setDownloadStatus("Ошибка: вложение нельзя скачать автоматически");
      return;
    }
    setDownloadingAttachment(attachment.id);
    setDownloadStatus("");
    void (account.authType === "oauth"
      ? downloadOAuthAttachment({ provider: account.provider as OAuthProvider, accountId: account.id, messageId: remoteMessageId, attachmentId: attachment.id })
      : downloadImapAttachment({ accountId: account.id, host: account.imapHost ?? "", port: account.imapPort ?? 993, username: account.address, messageId: remoteMessageId, attachmentId: attachment.id }))
      .then((result) => setDownloadStatus(`Сохранено в «Загрузки»: ${result.fileName}`))
      .catch((reason) => setDownloadStatus(`Ошибка: ${reason instanceof Error ? reason.message : "не удалось сохранить вложение"}`))
      .finally(() => setDownloadingAttachment(null));
  };

  const selectedMessage = selectedMessageId ? state.messages.find((message) => message.id === selectedMessageId) : undefined;

  const replyToMessage = (message: MailMessage) => {
    closeMessage();
    const address = extractEmailAddress(message.sender);
    setComposerSeed({
      to: address,
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
      reply: true,
    });
  };

  return (
    <section className="page-section">
      <div className="page-title"><div><span className="eyebrow">ЕДИНЫЙ ЯЩИК</span><h1>Почта</h1><p>Все письма в одном месте — без хранения паролей внутри DayDesk.</p></div><div className="mail-title-actions"><button className="secondary-button" disabled={state.accounts.length === 0} onClick={() => setComposerSeed({})}><Send size={17} />Написать</button><button className="primary-button" onClick={() => setShowConnector(true)}><Plus size={17} />Подключить почту</button></div></div>
      <div className="provider-grid">
        <button className="card provider-card provider-action" disabled={workingProvider !== null} onClick={() => void connectOAuthAccount("gmail")}><div className="provider-logo gmail">M</div><div><strong>Gmail</strong><span>Безопасный вход Google</span></div><em>{workingProvider === "gmail" ? <><LoaderCircle className="spin" size={12} />Ожидаем вход…</> : oauthStatus === null ? "Проверяем доступность…" : oauthStatus.gmail ? "Подключить через Google" : "Требуется настройка OAuth"}</em></button>
        <button className="card provider-card provider-action" disabled={workingProvider !== null} onClick={() => void connectOAuthAccount("outlook")}><div className="provider-logo outlook">O</div><div><strong>Outlook / 365</strong><span>Вход Microsoft</span></div><em>{workingProvider === "outlook" ? <><LoaderCircle className="spin" size={12} />Ожидаем вход…</> : oauthStatus === null ? "Проверяем доступность…" : oauthStatus.outlook ? "Подключить через Microsoft" : "Требуется настройка OAuth"}</em></button>
        <button className="card provider-card provider-action" onClick={() => setShowConnector(true)}><div className="provider-logo imap">@</div><div><strong>IMAP-почта</strong><span>Yandex, Mail.ru, iCloud и другие</span></div><em>Подключить сейчас</em></button>
      </div>
      {state.accounts.length > 0 ? <><div className="mail-section-title"><strong>Подключённые аккаунты</strong><span>{state.accounts.length}</span></div><div className="account-grid">{state.accounts.map((account) => <div className="card account-card connected-account" key={account.id}><div className={`provider-logo ${account.provider}`}>{account.provider === "gmail" ? "M" : account.provider === "outlook" ? "O" : "@"}</div><div><strong>{account.label}</strong><span>{account.address}</span></div><div className="account-actions"><button className="icon-button" disabled={workingAccount === account.id} onClick={() => void synchronize(account)} title="Обновить письма">{workingAccount === account.id ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button><button className="disconnect-button" disabled={workingAccount === account.id} onClick={() => void disconnect(account)}>Отключить</button></div></div>)}</div></> : null}
      {error ? <div className="form-error mail-error" role="alert">{error}</div> : null}
      {mailActionStatus ? <div className="mail-action-status" role="status"><CheckCircle2 size={16} />{mailActionStatus}</div> : null}
      <MailPreview state={state} setState={setState} messages={deferredSearchQuery ? cachedSearchResults ?? localSearchResults : state.messages} searchQuery={deferredSearchQuery} limit={100} onOpen={openMessage} />
      {showConnector ? <MailConnectModal onConnected={connected} onClose={() => setShowConnector(false)} /> : null}
      {selectedMessage ? <MailReader message={selectedMessage} loading={readerLoading} error={readerError} downloadingAttachment={downloadingAttachment} downloadStatus={downloadStatus} onClose={closeMessage} onRetry={() => openMessage(selectedMessage)} onDownload={(attachment) => downloadAttachment(selectedMessage, attachment)} onReply={() => replyToMessage(selectedMessage)} /> : null}
      {composerSeed ? <MailComposer accounts={state.accounts} seed={composerSeed} onClose={() => setComposerSeed(null)} onSent={() => { setComposerSeed(null); setMailActionStatus("Письмо принято почтовым сервисом и отправляется"); }} /> : null}
    </section>
  );
}

function RoutineIcon({ kind, size = 18 }: { kind: RoutineKind; size?: number }) {
  if (kind === "water") return <Droplets size={size} />;
  if (kind === "meal") return <Utensils size={size} />;
  if (kind === "break") return <Coffee size={size} />;
  if (kind === "focus") return <Sparkles size={size} />;
  return <Bell size={size} />;
}

function RoutineEditor({ existing, onSave, onDelete, onClose }: { existing?: Routine; onSave: (routine: Routine) => void; onDelete: (routine: Routine) => void; onClose: () => void }) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [time, setTime] = useState(existing?.time ?? "13:00");
  const [kind, setKind] = useState<RoutineKind>(existing?.kind ?? "custom");
  const [days, setDays] = useState(existing?.days ?? [1, 2, 3, 4, 5]);
  const [remindBeforeMinutes, setRemindBeforeMinutes] = useState(existing?.remindBeforeMinutes ?? 0);
  const [error, setError] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    if (days.length === 0) {
      setError("Выберите хотя бы один день недели");
      return;
    }
    onSave({
      id: existing?.id ?? uid(),
      title: title.trim(),
      time,
      kind,
      days: routineWeekdays.map((day) => day.value).filter((day) => days.includes(day)),
      remindBeforeMinutes,
      enabled: existing?.enabled ?? true,
    });
  };

  const toggleDay = (day: number) => {
    setDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day]);
    setError("");
  };

  return <div className="modal-backdrop" onMouseDown={onClose}>
    <form className="quick-modal routine-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-icon"><RoutineIcon kind={kind} size={21} /></div>
      <div><span className="eyebrow">РИТМ ДНЯ</span><h2>{existing ? "Изменить напоминание" : "Новое напоминание"}</h2></div>
      <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
      <div className="form-grid">
        <label className="field-full">Название<input autoFocus maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, выпить воды" /></label>
        <label>Время<input required type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
        <label>Категория<select value={kind} onChange={(event) => setKind(event.target.value as RoutineKind)}><option value="water">Вода</option><option value="meal">Питание</option><option value="break">Перерыв</option><option value="focus">Фокус</option><option value="custom">Другое</option></select></label>
        <label className="field-full">Напомнить<select value={remindBeforeMinutes} onChange={(event) => setRemindBeforeMinutes(Number(event.target.value))}><option value={0}>В момент начала</option><option value={5}>За 5 минут</option><option value={10}>За 10 минут</option><option value={15}>За 15 минут</option><option value={30}>За 30 минут</option></select></label>
        <fieldset className="routine-days"><legend>Повторять</legend><div>{routineWeekdays.map((day) => <button key={day.value} type="button" className={days.includes(day.value) ? "active" : ""} aria-pressed={days.includes(day.value)} onClick={() => toggleDay(day.value)}>{day.short}</button>)}</div></fieldset>
      </div>
      {error ? <div className="form-error" role="alert">{error}</div> : null}
      <div className="modal-actions event-actions">{existing ? <button type="button" className="danger-button" onClick={() => onDelete(existing)}><Trash2 size={16} />Удалить</button> : null}<span /><button type="button" className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button"><Check size={17} />Сохранить</button></div>
    </form>
  </div>;
}

async function openWidget(kind: "agenda" | "rhythm") {
  const isRhythm = kind === "rhythm";
  const label = isRhythm ? "rhythm-widget" : "agenda-widget";
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel(label);
    if (existing) { await existing.show(); await existing.setFocus(); return; }
    new WebviewWindow(label, { url: `/?widget=${kind}`, title: isRhythm ? "DayDesk — Ритм дня" : "DayDesk — Сегодня", width: 360, height: 510, decorations: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnBottom: true, shadow: true });
  } catch {
    window.open(`/?widget=${kind}`, `daydesk-${kind}-widget`, "width=360,height=510");
  }
}

function WidgetsView({ state, setState }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>> }) {
  const [editor, setEditor] = useState<Routine | "new" | null>(null);
  const routines = state.routines ?? [];
  const nextRoutines = routineOccurrences(routines, 2).filter((event) => new Date(event.startsAt) >= new Date()).slice(0, 3);
  const saveRoutine = (routine: Routine) => {
    setState((current) => {
      const currentRoutines = current.routines ?? [];
      return { ...current, routines: currentRoutines.some((item) => item.id === routine.id) ? currentRoutines.map((item) => item.id === routine.id ? routine : item) : [...currentRoutines, routine] };
    });
    setEditor(null);
  };
  const deleteRoutine = (routine: Routine) => {
    if (!window.confirm(`Удалить напоминание «${routine.title}»?`)) return;
    setState((current) => ({ ...current, routines: (current.routines ?? []).filter((item) => item.id !== routine.id) }));
    setEditor(null);
  };
  const toggleRoutine = (id: string) => setState((current) => ({ ...current, routines: (current.routines ?? []).map((routine) => routine.id === id ? { ...routine, enabled: !routine.enabled } : routine) }));

  return <section className="page-section"><div className="page-title"><div><span className="eyebrow">РАБОЧИЙ СТОЛ</span><h1>Виджеты</h1><p>Важное остаётся перед глазами, не мешая работе.</p></div></div><div className="widget-gallery"><div className="card widget-option"><div className="widget-preview"><div className="preview-top"><Logo /><span>Сегодня</span><MoreHorizontal size={14} /></div><strong>4 задачи</strong><div className="preview-line"><i />Презентация <span>11:30</span></div><div className="preview-line"><i />Встреча с Анной <span>15:00</span></div><div className="preview-line"><i />Заказать продукты <span>18:30</span></div></div><div className="widget-description"><div><h3>План на сегодня</h3><p>Задачи и ближайшие события</p></div><button className="primary-button" onClick={() => void openWidget("agenda")}><Plus size={17} />На рабочий стол</button></div></div><div className="card widget-option"><div className="widget-preview rhythm-preview"><div className="preview-top"><Logo /><span>Ритм дня</span><Clock3 size={14} /></div><strong>{routines.filter((routine) => routine.enabled).length} напоминания</strong>{nextRoutines.length ? nextRoutines.map((routine) => <div className="preview-line" key={routine.id}><i />{routine.title}<span>{shortTime(routine.startsAt)}</span></div>) : <div className="preview-line"><i />Добавьте первый ритуал</div>}</div><div className="widget-description"><div><h3>Ритм дня</h3><p>Вода, обед, отдых и фокус</p></div><button className="primary-button" onClick={() => void openWidget("rhythm")}><Plus size={17} />На рабочий стол</button></div></div></div>
    <div className="routine-section-title"><div><span className="eyebrow">РЕГУЛЯРНЫЕ НАПОМИНАНИЯ</span><h2>Мой ритм</h2><p>DayDesk повторит их в выбранные дни, даже когда окно свёрнуто.</p></div><button className="primary-button" onClick={() => setEditor("new")}><Plus size={17} />Добавить</button></div>
    <div className="card routine-list">{routines.length ? routines.map((routine) => <div className={`routine-row ${routine.enabled ? "" : "disabled"}`} key={routine.id}><div className={`routine-kind ${routine.kind}`}><RoutineIcon kind={routine.kind} /></div><div className="routine-copy"><strong>{routine.title}</strong><span>{routine.time} · {routineDaysLabel(routine.days)} · {routine.remindBeforeMinutes ? `за ${routine.remindBeforeMinutes} мин` : "в момент начала"}</span></div><small>{routineKindLabel[routine.kind]}</small><button className="icon-button routine-edit" onClick={() => setEditor(routine)} aria-label={`Изменить ${routine.title}`}><Settings size={16} /></button><button className={`setting-toggle ${routine.enabled ? "active" : ""}`} role="switch" aria-checked={routine.enabled} onClick={() => toggleRoutine(routine.id)} aria-label={`${routine.enabled ? "Выключить" : "Включить"} ${routine.title}`}><i /></button></div>) : <div className="empty-state large">Добавьте обед, воду, перерыв или любой собственный ритуал.</div>}</div>
    {editor ? <RoutineEditor existing={editor === "new" ? undefined : editor} onSave={saveRoutine} onDelete={deleteRoutine} onClose={() => setEditor(null)} /> : null}
  </section>;
}

function WidgetApp({ state, kind }: { state: AppState; kind: "agenda" | "rhythm" }) {
  const now = useClock();
  if (kind === "rhythm") {
    const routines = state.routines ?? [];
    const upcoming = routineOccurrences(routines, 2, now).filter((event) => new Date(event.startsAt) >= now).slice(0, 5);
    return <main className="desktop-widget rhythm-widget"><div className="widget-drag" data-tauri-drag-region><Logo /><span data-tauri-drag-region>Ритм дня</span><Clock3 size={17} /></div><div className="widget-date"><span>{longDate(now)}</span><strong>{new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(now)}</strong></div><div className="rhythm-widget-summary"><Sparkles size={20} /><div><strong>{upcoming.length ? `Дальше — ${upcoming[0].title}` : "На сегодня всё"}</strong><span>{upcoming.length ? shortTime(upcoming[0].startsAt) : "Можно отдохнуть"}</span></div></div><div className="widget-tasks rhythm-widget-list">{upcoming.map((routine) => <div key={routine.id}><Clock3 size={16} /><span>{routine.title}</span><time>{shortTime(routine.startsAt)}</time></div>)}</div><button className="widget-add" onClick={() => void requestMainAction("open-routines")}><Bell size={16} />Настроить · {routines.filter((routine) => routine.enabled).length}</button></main>;
  }
  const upcoming = state.tasks.filter((task) => !task.completed).sort((left, right) => left.dueAt.localeCompare(right.dueAt)).slice(0, 4);
  return <main className="desktop-widget"><div className="widget-drag" data-tauri-drag-region><Logo /><span data-tauri-drag-region>Сегодня</span><button className="icon-button"><MoreHorizontal size={17} /></button></div><div className="widget-date"><span>{longDate(now)}</span><strong>{new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(now)}</strong></div><div className="widget-stat"><div><CheckCircle2 size={20} /><strong>{upcoming.length}</strong><span>осталось</span></div><div><CalendarDays size={20} /><strong>{state.events.length}</strong><span>событий</span></div></div><div className="widget-tasks">{upcoming.map((task) => <div key={task.id}><Circle size={17} /><span>{task.title}</span><time>{shortTime(task.dueAt)}</time></div>)}</div><button className="widget-add" onClick={() => void requestMainAction("new-task")}><Plus size={17} />Добавить задачу</button></main>;
}

export default function App() {
  const widgetParam = new URLSearchParams(window.location.search).get("widget");
  const widgetKind = widgetParam === "rhythm" ? "rhythm" : "agenda";
  const isWidget = widgetParam === "agenda" || widgetParam === "rhythm";
  const [state, setState] = useState<AppState>(() => loadState());
  const [persistenceError, setPersistenceError] = useState("");
  const [reminderError, setReminderError] = useState("");
  const [view, setView] = useState<View>("today");
  const [taskEditor, setTaskEditor] = useState<Task | "new" | null>(null);
  const [eventEditor, setEventEditor] = useState<CalendarEvent | "new" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [mailCacheReady, setMailCacheReady] = useState(false);
  const [reminderScheduleTick, setReminderScheduleTick] = useState(0);
  const [syncDevice, setSyncDevice] = useState<SyncDeviceStatus>();
  const [syncPhase, setSyncPhase] = useState<SyncPhase>("idle");
  const [syncError, setSyncError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<string>();
  const searchInput = useRef<HTMLInputElement>(null);
  const mailSyncRunning = useRef(false);
  const calendarSyncRunning = useRef(false);
  const latestSyncSnapshot = useRef(createSyncSnapshot(state));
  const syncSnapshot = useRef(createSyncSnapshot(state));
  const mailAccountsKey = state.accounts
    .map((account) => [account.id, account.provider, account.authType, account.address, account.imapHost ?? "", account.imapPort ?? ""].join(":"))
    .join("|");
  const calendarAccountsKey = state.accounts
    .filter(isCalendarAccount)
    .map((account) => [account.id, account.provider, account.calendarEnabled ? "on" : "off"].join(":"))
    .join("|");

  latestSyncSnapshot.current = createSyncSnapshot(state);

  const runDataSync = useCallback(async () => {
    if (isWidget) return;
    setSyncPhase("syncing");
    setSyncError("");
    try {
      const result = await syncDesktopData(latestSyncSnapshot.current);
      if (!result) {
        setSyncPhase("idle");
        return;
      }
      if (result.changes.length > 0) {
        setState((current) => {
          const externalEvents = current.events.filter((event) => event.calendar || event.routineId);
          const merged = mergeRemoteChanges(createSyncSnapshot(current), result.changes);
          syncSnapshot.current = merged;
          return { ...current, tasks: merged.tasks, events: [...externalEvents, ...merged.events].sort((left, right) => left.startsAt.localeCompare(right.startsAt)), routines: merged.routines };
        });
      }
      setLastSyncedAt(result.serverTime);
      setSyncPhase("idle");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Не удалось синхронизировать данные";
      setSyncError(message);
      setSyncPhase("error");
      throw reason;
    }
  }, [isWidget]);

  const connectDataSync = useCallback(async (apiUrl: string, setupCode: string, deviceName: string) => {
    const device = await registerDesktopSyncDevice(apiUrl, setupCode, deviceName);
    setSyncDevice(device);
    await runDataSync();
  }, [runDataSync]);

  const disconnectDataSync = useCallback(async () => {
    await disconnectDesktopSyncDevice();
    setSyncDevice(undefined);
    setSyncPhase("idle");
    setSyncError("");
    setLastSyncedAt(undefined);
  }, []);

  useEffect(() => {
    setPersistenceError(saveState(state) ?? "");
    stateChannel?.postMessage({ ...state, messages: [] });
  }, [state]);

  useEffect(() => {
    if (isWidget) return;
    const current = createSyncSnapshot(state);
    recordSyncChanges(syncSnapshot.current, current);
    syncSnapshot.current = current;
  }, [isWidget, state.events, state.routines, state.tasks]);

  useEffect(() => {
    if (isWidget) return;
    let cancelled = false;
    void getDesktopSyncStatus()
      .then((device) => { if (!cancelled) setSyncDevice(device); })
      .catch((reason: unknown) => { if (!cancelled) setSyncError(reason instanceof Error ? reason.message : "Не удалось проверить синхронизацию"); });
    const initialTimer = window.setTimeout(() => void runDataSync().catch(() => undefined), 5_000);
    const interval = window.setInterval(() => void runDataSync().catch(() => undefined), 30_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [isWidget, runDataSync]);

  useEffect(() => {
    if (isWidget) return;
    void replaceBackgroundReminders([...state.events, ...routineOccurrences(state.routines ?? []), ...taskReminderEvents(state.tasks)])
      .then(() => setReminderError(""))
      .catch(() => setReminderError("Не удалось обновить фоновые напоминания. Перезапустите DayDesk."));
  }, [isWidget, reminderScheduleTick, state.events, state.routines, state.tasks]);

  useEffect(() => {
    if (isWidget) return;
    const timer = window.setInterval(() => setReminderScheduleTick((current) => current + 1), 6 * 60 * 60_000);
    return () => window.clearInterval(timer);
  }, [isWidget]);

  useEffect(() => {
    if (isWidget) return;
    let active = true;
    void loadMailCache()
      .then((messages) => {
        if (!active) return;
        setState((current) => {
          const accountIds = new Set(current.accounts.map((account) => account.id));
          const cached = messages.filter((message) => accountIds.has(message.accountId));
          return cached.length > 0 ? { ...current, messages: cached } : current;
        });
        setMailCacheReady(true);
      })
      .catch(() => { /* Не перезаписываем кэш, если системное хранилище недоступно. */ });
    return () => { active = false; };
  }, [isWidget]);

  useEffect(() => {
    if (isWidget || !mailCacheReady) return;
    const timer = window.setTimeout(() => void replaceMailCache(state.messages).catch(() => undefined), 250);
    return () => window.clearTimeout(timer);
  }, [isWidget, mailCacheReady, state.messages]);

  useEffect(() => {
    if (isWidget) return;
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [isWidget]);

  useEffect(() => {
    if (!stateChannel) return;
    const channel = stateChannel;
    const receive = (event: MessageEvent<AppState>) => setState((current) =>
      JSON.stringify(current) === JSON.stringify(event.data) ? current : event.data,
    );
    channel.addEventListener("message", receive);
    return () => channel.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    if (isWidget || !actionChannel) return;
    const channel = actionChannel;
    const receive = (event: MessageEvent<DayDeskAction>) => {
      if (event.data === "new-task") setTaskEditor("new");
      if (event.data === "open-routines") setView("widgets");
    };
    channel.addEventListener("message", receive);
    return () => channel.removeEventListener("message", receive);
  }, [isWidget]);

  useEffect(() => {
    if (isWidget || !mailAccountsKey) return;
    let cancelled = false;
    const accounts = state.accounts;
    const synchronizeAll = async () => {
      if (mailSyncRunning.current) return;
      mailSyncRunning.current = true;
      try {
        const results = await Promise.allSettled(accounts.map(async (account) => {
          const loaded = account.authType === "oauth"
            ? await syncOAuth({ provider: account.provider as OAuthProvider, accountId: account.id })
            : account.imapHost
              ? await syncImap({ accountId: account.id, host: account.imapHost, port: account.imapPort ?? 993, username: account.address })
              : [];
          return { account, messages: toMailMessages(account, loaded) };
        }));
        if (cancelled) return;
        const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        if (successful.length === 0) return;
        const syncedAt = new Date().toISOString();
        const syncedIds = new Set(successful.map(({ account }) => account.id));
        setState((current) => {
          let messages = current.messages;
          for (const result of successful) {
            messages = mergeAccountMessages(messages, result.account.id, result.messages);
          }
          return {
            ...current,
            accounts: current.accounts.map((account) => syncedIds.has(account.id) ? { ...account, lastSyncedAt: syncedAt } : account),
            messages,
          };
        });
      } finally {
        mailSyncRunning.current = false;
      }
    };
    const initialTimer = window.setTimeout(() => void synchronizeAll(), 15_000);
    const interval = window.setInterval(() => void synchronizeAll(), 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [isWidget, mailAccountsKey]);

  useEffect(() => {
    if (isWidget || !calendarAccountsKey) return;
    let cancelled = false;
    const accounts = state.accounts.filter((account): account is MailAccount & { provider: OAuthProvider } => isCalendarAccount(account) && Boolean(account.calendarEnabled));
    if (accounts.length === 0) return;
    const synchronizeAll = async () => {
      if (calendarSyncRunning.current) return;
      calendarSyncRunning.current = true;
      const startedAtMutation = calendarMutationVersion;
      const syncVersion = ++calendarSyncVersion;
      try {
        const results = await Promise.allSettled(accounts.map(async (account) => ({ account, events: await fetchCalendarEvents(account) })));
        if (cancelled || startedAtMutation !== calendarMutationVersion || syncVersion !== calendarSyncVersion) return;
        const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        if (successful.length === 0) return;
        const syncedAt = new Date().toISOString();
        setState((current) => {
          let events = current.events;
          const syncedIds = new Set<string>();
          for (const result of successful) {
            const currentAccount = current.accounts.find((account) => account.id === result.account.id);
            if (!currentAccount || !isCalendarAccount(currentAccount) || !currentAccount.calendarEnabled) continue;
            events = replaceAccountCalendarEvents(events, result.account.id, result.events);
            syncedIds.add(result.account.id);
          }
          if (syncedIds.size === 0) return current;
          return {
            ...current,
            events,
            accounts: current.accounts.map((account) => syncedIds.has(account.id) ? { ...account, lastCalendarSyncedAt: syncedAt } : account),
          };
        });
      } finally {
        calendarSyncRunning.current = false;
      }
    };
    const initialTimer = window.setTimeout(() => void synchronizeAll(), 20_000);
    const interval = window.setInterval(() => void synchronizeAll(), 10 * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [isWidget, calendarAccountsKey]);

  const saveTask = useCallback((task: Task) => {
    setState((current) => {
      const exists = current.tasks.some((item) => item.id === task.id);
      const tasks = exists ? current.tasks.map((item) => item.id === task.id ? task : item) : [...current.tasks, task];
      return { ...current, tasks: tasks.sort((left, right) => left.dueAt.localeCompare(right.dueAt)) };
    });
    setTaskEditor(null);
  }, []);

  const deleteTask = useCallback((task: Task) => {
    if (!window.confirm(`Удалить задачу «${task.title}»?`)) return;
    setState((current) => ({ ...current, tasks: current.tasks.filter((item) => item.id !== task.id) }));
    setTaskEditor(null);
  }, []);

  const saveEvent = useCallback(async (event: CalendarEvent) => {
    let saved = event;
    if (event.calendar) {
      const account = state.accounts.find((item) => item.id === event.calendar?.accountId);
      if (!account || !isCalendarAccount(account) || !account.calendarEnabled) throw new Error("Календарный аккаунт отключён");
      const updatesProvider = !event.calendar.remoteId
        || Boolean(event.calendar.updateTitle)
        || Boolean(event.calendar.updateTime)
        || Boolean(event.calendar.updateLocation)
        || Boolean(event.calendar.updateReminders);
      if (updatesProvider) {
        const remote = await upsertRemoteCalendarEvent({
          provider: account.provider,
          accountId: account.id,
          remoteId: event.calendar.remoteId,
          title: event.title,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          location: event.location,
          remindBeforeMinutes: event.remindBeforeMinutes,
          reminderEnabled: event.calendar.reminderEnabled ?? event.remindBeforeMinutes > 0,
          usesDefaultReminder: event.calendar.usesDefaultReminder,
          updateReminders: event.calendar.updateReminders ?? false,
          updateTitle: event.calendar.updateTitle ?? false,
          updateTime: event.calendar.updateTime ?? false,
          updateLocation: event.calendar.updateLocation ?? false,
          version: event.calendar.version,
          operationId: event.calendar.operationId,
        });
        calendarMutationVersion += 1;
        saved = { ...toCalendarEvent(account, remote), type: event.type };
      } else {
        saved = {
          ...event,
          calendar: {
            ...event.calendar,
            updateReminders: undefined,
            updateTitle: undefined,
            updateTime: undefined,
            updateLocation: undefined,
            operationId: undefined,
          },
        };
      }
    }
    setState((current) => {
      if (saved.calendar) {
        const currentAccount = current.accounts.find((account) => account.id === saved.calendar?.accountId);
        if (!currentAccount || !isCalendarAccount(currentAccount) || !currentAccount.calendarEnabled) return current;
      }
      const exists = current.events.some((item) => item.id === event.id);
      const events = exists ? current.events.map((item) => item.id === event.id ? saved : item) : [...current.events, saved];
      return { ...current, events: events.sort((left, right) => left.startsAt.localeCompare(right.startsAt)) };
    });
    setEventEditor(null);
  }, [state.accounts]);

  const deleteEvent = useCallback(async (event: CalendarEvent) => {
    if (event.calendar?.remoteId) {
      await deleteRemoteCalendarEvent({ provider: event.calendar.provider, accountId: event.calendar.accountId, remoteId: event.calendar.remoteId, version: event.calendar.version });
      calendarMutationVersion += 1;
    }
    setState((current) => ({ ...current, events: current.events.filter((item) => item.id !== event.id) }));
    setEventEditor(null);
  }, []);

  const openNewEvent = useCallback(() => setEventEditor("new"), []);
  const openEvent = useCallback((event: CalendarEvent) => setEventEditor(event), []);
  const openNewTask = useCallback(() => setTaskEditor("new"), []);
  const openTask = useCallback((task: Task) => setTaskEditor(task), []);

  const page = useMemo(() => {
    if (view === "tasks") return <TasksView state={state} setState={setState} onAdd={openNewTask} onEdit={openTask} />;
    if (view === "calendar") return <CalendarView state={state} setState={setState} onAdd={openNewEvent} onEdit={openEvent} />;
    if (view === "mail") return <MailView state={state} setState={setState} searchQuery={searchQuery} />;
    if (view === "widgets") return <WidgetsView state={state} setState={setState} />;
    return <TodayView state={state} setState={setState} onAddTask={openNewTask} onEditTask={openTask} onAddEvent={openNewEvent} onEditEvent={openEvent} />;
  }, [openEvent, openNewEvent, openNewTask, openTask, searchQuery, state, view]);

  if (isWidget) return <WidgetApp state={state} kind={widgetKind} />;

  return (
    <div className="app-shell">
      <Sidebar view={view} onChange={setView} open={sidebarOpen} onClose={() => setSidebarOpen(false)} onSettings={() => { setSettingsOpen(true); setSidebarOpen(false); }} unreadCount={state.messages.filter((message) => message.unread).length} syncLabel={syncPhase === "syncing" ? "Синхронизация…" : syncPhase === "error" ? "Ошибка синхронизации" : syncDevice ? "Данные синхронизированы" : "Только на этом устройстве"} />
      {sidebarOpen ? <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Закрыть меню" /> : null}
      <div className="app-content">
        <header className="topbar"><button className="icon-button menu-button" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div className="search-box"><Search size={18} /><input ref={searchInput} value={searchQuery} aria-label="Поиск писем" maxLength={200} placeholder="Найти письмо…" onChange={(event) => { setSearchQuery(event.target.value); if (event.target.value.trim()) setView("mail"); }} />{searchQuery ? <button className="search-clear" onClick={() => setSearchQuery("")} aria-label="Очистить поиск"><X size={15} /></button> : <kbd>Ctrl K</kbd>}</div><div className="top-actions"><button className="icon-button notification-button"><Bell size={19} /><i /></button><button className="primary-button quick-add" onClick={openNewTask}><Plus size={18} />Добавить</button></div></header>
        {persistenceError || reminderError ? <div className="runtime-error" role="alert">{persistenceError || reminderError}</div> : null}
        <main className="content-area">{page}</main>
      </div>
      {taskEditor ? <TaskEditor existing={taskEditor === "new" ? undefined : taskEditor} onSave={saveTask} onDelete={deleteTask} onClose={() => setTaskEditor(null)} /> : null}
      {eventEditor ? <EventEditor existing={eventEditor === "new" ? undefined : eventEditor} accounts={state.accounts} onSave={saveEvent} onDelete={deleteEvent} onClose={() => setEventEditor(null)} /> : null}
      {settingsOpen ? <SettingsModal onClose={() => setSettingsOpen(false)} syncDevice={syncDevice} syncPhase={syncPhase} syncError={syncError} lastSyncedAt={lastSyncedAt} onConnectSync={connectDataSync} onSyncNow={runDataSync} onDisconnectSync={disconnectDataSync} /> : null}
    </div>
  );
}
