export type Priority = "high" | "medium" | "low";

export type TaskRecurrenceMode = "daily" | "weekdays" | "weekly" | "custom";

export interface TaskRecurrence {
  mode: TaskRecurrenceMode;
  days: number[];
  seriesId: string;
}

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  dueAt: string;
  priority: Priority;
  category: string;
  remindBeforeMinutes?: number;
  reminderEnabled?: boolean;
  recurrence?: TaskRecurrence;
  snoozedUntil?: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  type: "meeting" | "meal" | "focus" | "personal";
  location?: string;
  remindBeforeMinutes: number;
  reminderEnabled?: boolean;
  routineId?: string;
  allDay?: boolean;
  allDayStartDate?: string;
  allDayEndDate?: string;
  calendar?: {
    provider: "gmail" | "outlook";
    accountId: string;
    remoteId?: string;
    version?: string;
    readOnly?: boolean;
    reminderEnabled?: boolean;
    usesDefaultReminder?: boolean;
    updateReminders?: boolean;
    updateTitle?: boolean;
    updateTime?: boolean;
    updateLocation?: boolean;
    operationId?: string;
  };
}

export type RoutineKind = "water" | "meal" | "break" | "focus" | "custom";

export interface Routine {
  id: string;
  title: string;
  time: string;
  days: number[];
  kind: RoutineKind;
  remindBeforeMinutes: number;
  enabled: boolean;
}

export interface MailAccount {
  id: string;
  provider: "gmail" | "outlook" | "imap";
  label: string;
  address: string;
  connected: boolean;
  color: string;
  imapHost?: string;
  imapPort?: number;
  smtpHost?: string;
  smtpPort?: number;
  authType?: "password" | "oauth";
  lastSyncedAt?: string;
  calendarEnabled?: boolean;
  lastCalendarSyncedAt?: string;
}

export interface MailMessage {
  id: string;
  accountId: string;
  sender: string;
  initials: string;
  subject: string;
  preview: string;
  body?: string;
  hasAttachments?: boolean;
  attachments?: MailAttachment[];
  receivedAt: string;
  unread: boolean;
  starred: boolean;
  color: string;
}

export interface MailAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  downloadable: boolean;
}

export interface AppState {
  tasks: Task[];
  events: CalendarEvent[];
  routines: Routine[];
  accounts: MailAccount[];
  messages: MailMessage[];
}
