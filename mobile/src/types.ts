export type Priority = 'high' | 'medium' | 'low';

export type TaskRecurrenceMode = 'none' | 'daily' | 'weekdays' | 'weekly';

export interface Task {
  id: string;
  title: string;
  completed: boolean;
  dueAt: string;
  priority: Priority;
  category: string;
  reminderEnabled: boolean;
  remindBeforeMinutes: number;
  recurrence: TaskRecurrenceMode;
  notificationId?: string;
  updatedAt: string;
  syncVersion: number;
}

export type CalendarEventType = 'meeting' | 'meal' | 'focus' | 'personal';

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  type: CalendarEventType;
  location?: string;
}

export type RoutineKind = 'water' | 'meal' | 'break' | 'focus';

export interface Routine {
  id: string;
  title: string;
  time: string;
  kind: RoutineKind;
  enabled: boolean;
  notificationId?: string;
}

export type MailProvider = 'gmail' | 'outlook' | 'imap';

export interface MailAccount {
  id: string;
  provider: MailProvider;
  address: string;
  label: string;
  color: string;
  lastSyncedAt?: string;
}

export interface MailMessage {
  id: string;
  accountId: string;
  sender: string;
  subject: string;
  preview: string;
  receivedAt: string;
  unread: boolean;
  starred: boolean;
}

export interface SyncOperation {
  id: string;
  entity: 'task' | 'event' | 'routine';
  entityId: string;
  operation: 'upsert' | 'delete';
  createdAt: string;
}

export interface DayDeskState {
  tasks: Task[];
  events: CalendarEvent[];
  routines: Routine[];
  accounts: MailAccount[];
  messages: MailMessage[];
  syncQueue: SyncOperation[];
  hydrated: boolean;
}

export interface NewTaskInput {
  title: string;
  dueAt: string;
  priority: Priority;
  category: string;
  reminderEnabled: boolean;
  remindBeforeMinutes: number;
  recurrence: TaskRecurrenceMode;
}
