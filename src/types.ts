export type Priority = "high" | "medium" | "low";

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  dueAt: string;
  priority: Priority;
  category: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  type: "meeting" | "meal" | "focus" | "personal";
  location?: string;
  remindBeforeMinutes: number;
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
  accounts: MailAccount[];
  messages: MailMessage[];
}
