import type { DayDeskDatabase } from './database.js';
import type { ClientChange, ServerChange, SyncRequestBody, SyncResponseBody, SyncedTask } from './types.js';

const PAGE_SIZE = 500;

interface EntityRow {
  operation: 'upsert' | 'delete';
  updatedAt: string;
  sourceDeviceId: string;
}

interface ChangeRow {
  sequence: number;
  entityType: 'task';
  entityId: string;
  operation: 'upsert' | 'delete';
  payload: string | null;
  updatedAt: string;
}

function isValidIsoDate(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function validateChange(change: ClientChange) {
  if (!isValidIsoDate(change.updatedAt)) throw new TypeError('Invalid change timestamp');
  if (change.operation === 'upsert') {
    if (!change.payload || change.payload.id !== change.entityId || change.payload.updatedAt !== change.updatedAt) {
      throw new TypeError('Change payload does not match its envelope');
    }
    if (!isValidIsoDate(change.payload.dueAt)) throw new TypeError('Invalid task due date');
    if (change.payload.snoozedUntil && !isValidIsoDate(change.payload.snoozedUntil)) throw new TypeError('Invalid task snooze date');
    if (change.payload.desktopRecurrence?.mode === 'custom' && change.payload.desktopRecurrence.days.length === 0) {
      throw new TypeError('Custom recurrence requires at least one day');
    }
  }
}

function shouldApply(current: EntityRow | undefined, incoming: ClientChange, deviceId: string) {
  if (!current) return true;
  const timeComparison = incoming.updatedAt.localeCompare(current.updatedAt);
  return timeComparison > 0 || (timeComparison === 0 && deviceId.localeCompare(current.sourceDeviceId) > 0);
}

export function synchronize(database: DayDeskDatabase, deviceId: string, request: SyncRequestBody): SyncResponseBody {
  const acceptedOperationIds: string[] = [];
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const change of request.changes) {
      validateChange(change);
      const duplicate = database.prepare('SELECT 1 FROM accepted_operations WHERE operation_id = ?').get(change.id);
      if (duplicate) {
        acceptedOperationIds.push(change.id);
        continue;
      }

      const current = database.prepare(`
        SELECT operation, updated_at AS updatedAt, source_device_id AS sourceDeviceId
        FROM entities WHERE entity_type = ? AND entity_id = ?
      `).get(change.entity, change.entityId) as EntityRow | undefined;

      if (shouldApply(current, change, deviceId)) {
        const payload = change.operation === 'upsert' ? JSON.stringify(change.payload) : null;
        database.prepare(`
          INSERT INTO entities (entity_type, entity_id, operation, payload, updated_at, source_device_id)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_type, entity_id) DO UPDATE SET
            operation = excluded.operation,
            payload = excluded.payload,
            updated_at = excluded.updated_at,
            source_device_id = excluded.source_device_id
        `).run(change.entity, change.entityId, change.operation, payload, change.updatedAt, deviceId);
        database.prepare(`
          INSERT INTO change_log (entity_type, entity_id, operation, payload, updated_at, source_device_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(change.entity, change.entityId, change.operation, payload, change.updatedAt, deviceId);
      }

      database.prepare('INSERT INTO accepted_operations (operation_id, device_id, accepted_at) VALUES (?, ?, ?)')
        .run(change.id, deviceId, new Date().toISOString());
      acceptedOperationIds.push(change.id);
    }

    const rows = database.prepare(`
      SELECT sequence, entity_type AS entityType, entity_id AS entityId, operation, payload, updated_at AS updatedAt
      FROM change_log WHERE sequence > ? ORDER BY sequence ASC LIMIT ?
    `).all(request.cursor, PAGE_SIZE + 1) as unknown as ChangeRow[];
    const page = rows.slice(0, PAGE_SIZE);
    const changes: ServerChange[] = page.map((row) => ({
      sequence: row.sequence,
      entity: row.entityType,
      entityId: row.entityId,
      operation: row.operation,
      updatedAt: row.updatedAt,
      ...(row.payload ? { payload: JSON.parse(row.payload) as SyncedTask } : {}),
    }));
    const cursor = changes.at(-1)?.sequence ?? request.cursor;
    database.exec('COMMIT');
    return {
      cursor,
      acceptedOperationIds,
      changes,
      hasMore: rows.length > PAGE_SIZE,
      serverTime: new Date().toISOString(),
    };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
