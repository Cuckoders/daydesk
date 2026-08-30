export type EntityType = 'task';
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

export interface ClientChange {
  id: string;
  entity: EntityType;
  entityId: string;
  operation: SyncOperationType;
  updatedAt: string;
  payload?: SyncedTask;
}

export interface ServerChange {
  sequence: number;
  entity: EntityType;
  entityId: string;
  operation: SyncOperationType;
  updatedAt: string;
  payload?: SyncedTask;
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
