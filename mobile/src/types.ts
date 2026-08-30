export type Priority = 'high' | 'medium' | 'low';

export type TaskRecurrenceMode = 'none' | 'daily' | 'weekdays' | 'weekly';

export interface DesktopTaskRecurrence {
  mode: 'daily' | 'weekdays' | 'weekly' | 'custom';
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
  reminderEnabled: boolean;
  remindBeforeMinutes: number;
  recurrence: TaskRecurrenceMode;
  desktopRecurrence?: DesktopTaskRecurrence;
  snoozedUntil?: string;
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
  reminderEnabled: boolean;
  remindBeforeMinutes: number;
  allDay?: boolean;
  allDayStartDate?: string;
  allDayEndDate?: string;
  notificationId?: string;
  updatedAt: string;
  syncVersion: number;
}

export type RoutineKind = 'water' | 'meal' | 'break' | 'focus' | 'custom';

export interface Routine {
  id: string;
  title: string;
  time: string;
  days: number[];
  kind: RoutineKind;
  remindBeforeMinutes: number;
  enabled: boolean;
  notificationId?: string;
  notificationIds?: string[];
  updatedAt: string;
  syncVersion: number;
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

interface RemoteSyncChangeBase {
  sequence: number;
  entityId: string;
  operation: 'upsert' | 'delete';
  updatedAt: string;
}

export type RemoteSyncChange =
  | (RemoteSyncChangeBase & { entity: 'task'; payload?: Omit<Task, 'notificationId'> })
  | (RemoteSyncChangeBase & { entity: 'event'; payload?: Omit<CalendarEvent, 'notificationId'> })
  | (RemoteSyncChangeBase & { entity: 'routine'; payload?: Omit<Routine, 'notificationId' | 'notificationIds'> });

export type SyncStatus = 'idle' | 'syncing' | 'offline' | 'error';

export interface DayDeskState {
  tasks: Task[];
  events: CalendarEvent[];
  routines: Routine[];
  accounts: MailAccount[];
  messages: MailMessage[];
  syncQueue: SyncOperation[];
  syncCursor: number;
  syncStatus: SyncStatus;
  syncError?: string;
  lastSyncedAt?: string;
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

export interface NewEventInput {
  title: string;
  startsAt: string;
  endsAt: string;
  type: CalendarEventType;
  location?: string;
  reminderEnabled: boolean;
  remindBeforeMinutes: number;
}

export interface NewRoutineInput {
  title: string;
  time: string;
  days: number[];
  kind: RoutineKind;
  remindBeforeMinutes: number;
  enabled: boolean;
}
