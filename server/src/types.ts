export type EntityType = 'task' | 'event' | 'routine';
export type SyncOperationType = 'upsert' | 'delete';

export interface DesktopTaskRecurrence {
  mode: 'daily' | 'weekdays' | 'weekly' | 'custom';
  days: number[];
  seriesId: string;
}

export interface SyncedTask {
  id: string;
  title: string;
  completed: boolean;
  dueAt: string;
  priority: 'high' | 'medium' | 'low';
  category: string;
  reminderEnabled: boolean;
  remindBeforeMinutes: number;
  recurrence: 'none' | 'daily' | 'weekdays' | 'weekly';
  desktopRecurrence?: DesktopTaskRecurrence;
  snoozedUntil?: string;
  updatedAt: string;
  syncVersion: number;
}

export interface SyncedEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  type: 'meeting' | 'meal' | 'focus' | 'personal';
  location?: string;
  remindBeforeMinutes: number;
  reminderEnabled: boolean;
  allDay?: boolean;
  allDayStartDate?: string;
  allDayEndDate?: string;
  updatedAt: string;
  syncVersion: number;
}

export interface SyncedRoutine {
  id: string;
  title: string;
  time: string;
  days: number[];
  kind: 'water' | 'meal' | 'break' | 'focus' | 'custom';
  remindBeforeMinutes: number;
  enabled: boolean;
  updatedAt: string;
  syncVersion: number;
}

export type SyncedPayload = SyncedTask | SyncedEvent | SyncedRoutine;

export interface ClientChange {
  id: string;
  entity: EntityType;
  entityId: string;
  operation: SyncOperationType;
  updatedAt: string;
  payload?: SyncedPayload;
}

export interface ServerChange {
  sequence: number;
  entity: EntityType;
  entityId: string;
  operation: SyncOperationType;
  updatedAt: string;
  payload?: SyncedPayload;
}

export interface SyncRequestBody {
  cursor: number;
  changes: ClientChange[];
}

export interface SyncResponseBody {
  cursor: number;
  acceptedOperationIds: string[];
  changes: ServerChange[];
  hasMore: boolean;
  serverTime: string;
}

export interface DeviceRecord {
  id: string;
  name: string;
  tokenHash: string;
  revokedAt: string | null;
}

export interface MailAccount {
  id: string;
  provider: 'imap' | 'gmail' | 'outlook';
  label: string;
  address: string;
  host?: string;
  port?: 993;
  username?: string;
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

export interface MailContent {
  body: string;
  hasAttachments: boolean;
}
