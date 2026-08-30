import type { AppState, CalendarEvent, Routine, Task, TaskRecurrence } from "../types";

const QUEUE_KEY = "daydesk:sync:queue:v1";
const CURSOR_KEY = "daydesk:sync:cursor:v1";
const VERSIONS_KEY = "daydesk:sync:versions:v1";
const ENTITY_SET_KEY = "daydesk:sync:entities:v2";
const MAX_LOCAL_OPERATIONS = 5_000;

type EntityType = "task" | "event" | "routine";

export interface SyncDeviceStatus {
  apiUrl: string;
  deviceId: string;
  deviceName: string;
}

interface SyncMetadata { updatedAt: string; syncVersion: number }

interface SyncedTask extends SyncMetadata {
  id: string; title: string; completed: boolean; dueAt: string; priority: Task["priority"]; category: string;
  reminderEnabled: boolean; remindBeforeMinutes: number; recurrence: "none" | "daily" | "weekdays" | "weekly";
  desktopRecurrence?: TaskRecurrence; snoozedUntil?: string;
}

interface SyncedEvent extends SyncMetadata {
  id: string; title: string; startsAt: string; endsAt: string; type: CalendarEvent["type"]; location?: string;
  remindBeforeMinutes: number; reminderEnabled: boolean; allDay?: boolean; allDayStartDate?: string; allDayEndDate?: string;
}

interface SyncedRoutine extends SyncMetadata {
  id: string; title: string; time: string; days: number[]; kind: Routine["kind"];
  remindBeforeMinutes: number; enabled: boolean;
}

type SyncedPayload = SyncedTask | SyncedEvent | SyncedRoutine;

interface LocalChange {
  id: string; entity: EntityType; entityId: string; operation: "upsert" | "delete"; updatedAt: string; payload?: SyncedPayload;
}

export interface RemoteSyncChange {
  sequence: number; entity: EntityType; entityId: string; operation: "upsert" | "delete"; updatedAt: string; payload?: SyncedPayload;
}

interface SyncResponse {
  cursor: number; acceptedOperationIds: string[]; changes: RemoteSyncChange[]; hasMore: boolean; serverTime: string;
}

export interface DesktopSyncResult { changes: RemoteSyncChange[]; serverTime: string }
export interface SyncSnapshot { tasks: Task[]; events: CalendarEvent[]; routines: Routine[] }

interface EntityRecord {
  entity: EntityType;
  entityId: string;
  comparable: string;
  payload: (updatedAt: string, syncVersion: number) => SyncedPayload;
}

let activeSync: Promise<DesktopSyncResult | undefined> | undefined;

const uid = () => crypto.randomUUID?.() ?? `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const entityKey = (entity: EntityType, entityId: string) => `${entity}:${entityId}`;
const isDesktopApp = () => "__TAURI_INTERNALS__" in window;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isMetadata = (value: Record<string, unknown>) => typeof value.updatedAt === "string" && Number.isInteger(value.syncVersion);

async function invokeDesktop<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, payload);
}

function isSyncedTask(value: unknown): value is SyncedTask {
  if (!isRecord(value)) return false;
  const recurrence = value.desktopRecurrence;
  const validDesktopRecurrence = recurrence === undefined || (isRecord(recurrence)
    && ["daily", "weekdays", "weekly", "custom"].includes(String(recurrence.mode))
    && Array.isArray(recurrence.days) && recurrence.days.length <= 7
    && recurrence.days.every((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)
    && typeof recurrence.seriesId === "string");
  return isMetadata(value) && typeof value.id === "string" && typeof value.title === "string"
    && typeof value.completed === "boolean" && typeof value.dueAt === "string"
    && ["high", "medium", "low"].includes(String(value.priority)) && typeof value.category === "string"
    && typeof value.reminderEnabled === "boolean" && Number.isInteger(value.remindBeforeMinutes)
    && ["none", "daily", "weekdays", "weekly"].includes(String(value.recurrence)) && validDesktopRecurrence
    && (value.snoozedUntil === undefined || typeof value.snoozedUntil === "string");
}

function isSyncedEvent(value: unknown): value is SyncedEvent {
  if (!isRecord(value)) return false;
  return isMetadata(value) && typeof value.id === "string" && typeof value.title === "string"
    && typeof value.startsAt === "string" && typeof value.endsAt === "string"
    && ["meeting", "meal", "focus", "personal"].includes(String(value.type))
    && (value.location === undefined || typeof value.location === "string")
    && Number.isInteger(value.remindBeforeMinutes) && typeof value.reminderEnabled === "boolean"
    && (value.allDay === undefined || typeof value.allDay === "boolean")
    && (value.allDayStartDate === undefined || typeof value.allDayStartDate === "string")
    && (value.allDayEndDate === undefined || typeof value.allDayEndDate === "string");
}

function isSyncedRoutine(value: unknown): value is SyncedRoutine {
  if (!isRecord(value)) return false;
  return isMetadata(value) && typeof value.id === "string" && typeof value.title === "string" && typeof value.time === "string"
    && Array.isArray(value.days) && value.days.length > 0 && value.days.length <= 7
    && value.days.every((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)
    && ["water", "meal", "break", "focus", "custom"].includes(String(value.kind))
    && Number.isInteger(value.remindBeforeMinutes) && typeof value.enabled === "boolean";
}

function payloadMatchesEntity(entity: EntityType, value: unknown): value is SyncedPayload {
  return entity === "task" ? isSyncedTask(value) : entity === "event" ? isSyncedEvent(value) : isSyncedRoutine(value);
}

function isLocalChange(value: unknown): value is LocalChange {
  if (!isRecord(value) || typeof value.id !== "string" || !["task", "event", "routine"].includes(String(value.entity))
    || typeof value.entityId !== "string" || !["upsert", "delete"].includes(String(value.operation))
    || typeof value.updatedAt !== "string") return false;
  const entity = value.entity as EntityType;
  return value.operation === "delete" ? value.payload === undefined : payloadMatchesEntity(entity, value.payload);
}

function isRemoteChange(value: unknown): value is RemoteSyncChange {
  if (!isRecord(value) || !Number.isInteger(value.sequence) || !["task", "event", "routine"].includes(String(value.entity))
    || typeof value.entityId !== "string" || !["upsert", "delete"].includes(String(value.operation))
    || typeof value.updatedAt !== "string") return false;
  const entity = value.entity as EntityType;
  return value.operation === "delete" ? value.payload === undefined : payloadMatchesEntity(entity, value.payload);
}

function readQueue(): LocalChange[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, MAX_LOCAL_OPERATIONS).filter(isLocalChange) : [];
  } catch { return []; }
}

function saveQueue(queue: LocalChange[]) { localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_LOCAL_OPERATIONS))); }

function readCursor() {
  const value = Number(localStorage.getItem(CURSOR_KEY) ?? 0);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function readVersions(): Record<string, number> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(VERSIONS_KEY) ?? "{}");
    if (!isRecord(parsed)) return {};
    return Object.entries(parsed).reduce<Record<string, number>>((versions, [key, value]) => {
      if (Number.isInteger(value) && Number(value) > 0) versions[key] = Number(value);
      return versions;
    }, {});
  } catch { return {}; }
}

function saveVersions(versions: Record<string, number>) { localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions)); }

function nextVersion(versions: Record<string, number>, entity: EntityType, id: string) {
  const key = entityKey(entity, id);
  const legacyTaskVersion = entity === "task" ? versions[id] ?? 0 : 0;
  const version = (versions[key] ?? legacyTaskVersion) + 1;
  versions[key] = version;
  return version;
}

function rememberVersion(versions: Record<string, number>, entity: EntityType, id: string, version: number) {
  const key = entityKey(entity, id);
  versions[key] = Math.max(versions[key] ?? 0, version);
}

function toSyncedTask(task: Task, updatedAt: string, syncVersion: number): SyncedTask {
  const simpleRecurrence = task.recurrence && task.recurrence.mode !== "custom" ? task.recurrence.mode : "none";
  return { id: task.id, title: task.title, completed: task.completed, dueAt: task.dueAt, priority: task.priority,
    category: task.category, reminderEnabled: task.reminderEnabled ?? false, remindBeforeMinutes: task.remindBeforeMinutes ?? 0,
    recurrence: simpleRecurrence, ...(task.recurrence ? { desktopRecurrence: task.recurrence } : {}),
    ...(task.snoozedUntil ? { snoozedUntil: task.snoozedUntil } : {}), updatedAt, syncVersion };
}

function toSyncedEvent(event: CalendarEvent, updatedAt: string, syncVersion: number): SyncedEvent {
  return { id: event.id, title: event.title, startsAt: event.startsAt, endsAt: event.endsAt, type: event.type,
    ...(event.location ? { location: event.location } : {}), remindBeforeMinutes: event.remindBeforeMinutes ?? 0,
    reminderEnabled: event.reminderEnabled ?? event.remindBeforeMinutes > 0,
    ...(event.allDay ? { allDay: true, allDayStartDate: event.allDayStartDate, allDayEndDate: event.allDayEndDate } : {}),
    updatedAt, syncVersion };
}

function toSyncedRoutine(routine: Routine, updatedAt: string, syncVersion: number): SyncedRoutine {
  return { id: routine.id, title: routine.title, time: routine.time, days: routine.days, kind: routine.kind,
    remindBeforeMinutes: routine.remindBeforeMinutes, enabled: routine.enabled, updatedAt, syncVersion };
}

function fromSyncedTask(task: SyncedTask): Task {
  const recurrence = task.desktopRecurrence ?? (task.recurrence === "none" ? undefined
    : { mode: task.recurrence, days: [], seriesId: `sync:${task.id}` });
  return { id: task.id, title: task.title, completed: task.completed, dueAt: task.dueAt, priority: task.priority,
    category: task.category, reminderEnabled: task.reminderEnabled, remindBeforeMinutes: task.remindBeforeMinutes,
    recurrence, snoozedUntil: task.snoozedUntil };
}

function fromSyncedEvent(event: SyncedEvent): CalendarEvent {
  return { id: event.id, title: event.title, startsAt: event.startsAt, endsAt: event.endsAt, type: event.type,
    location: event.location, remindBeforeMinutes: event.remindBeforeMinutes, reminderEnabled: event.reminderEnabled,
    allDay: event.allDay, allDayStartDate: event.allDayStartDate, allDayEndDate: event.allDayEndDate };
}

function fromSyncedRoutine(routine: SyncedRoutine): Routine {
  return { id: routine.id, title: routine.title, time: routine.time, days: routine.days, kind: routine.kind,
    remindBeforeMinutes: routine.remindBeforeMinutes, enabled: routine.enabled };
}

export function createSyncSnapshot(state: Pick<AppState, "tasks" | "events" | "routines">): SyncSnapshot {
  return { tasks: state.tasks, events: state.events.filter((event) => !event.calendar && !event.routineId), routines: state.routines ?? [] };
}

function entityRecords(snapshot: SyncSnapshot): EntityRecord[] {
  return [
    ...snapshot.tasks.map((task) => ({ entity: "task" as const, entityId: task.id, comparable: JSON.stringify(task),
      payload: (updatedAt: string, syncVersion: number) => toSyncedTask(task, updatedAt, syncVersion) })),
    ...snapshot.events.map((event) => ({ entity: "event" as const, entityId: event.id, comparable: JSON.stringify(event),
      payload: (updatedAt: string, syncVersion: number) => toSyncedEvent(event, updatedAt, syncVersion) })),
    ...snapshot.routines.map((routine) => ({ entity: "routine" as const, entityId: routine.id, comparable: JSON.stringify(routine),
      payload: (updatedAt: string, syncVersion: number) => toSyncedRoutine(routine, updatedAt, syncVersion) })),
  ];
}

function enqueue(queue: LocalChange[], change: LocalChange) {
  return [...queue.filter((item) => item.entity !== change.entity || item.entityId !== change.entityId), change];
}

function makeUpsert(record: EntityRecord, versions: Record<string, number>): LocalChange {
  const updatedAt = new Date().toISOString();
  const syncVersion = nextVersion(versions, record.entity, record.entityId);
  return { id: uid(), entity: record.entity, entityId: record.entityId, operation: "upsert", updatedAt,
    payload: record.payload(updatedAt, syncVersion) };
}

export function recordSyncChanges(previous: SyncSnapshot, current: SyncSnapshot) {
  const beforeRecords = entityRecords(previous);
  const before = new Map(beforeRecords.map((record) => [entityKey(record.entity, record.entityId), record]));
  const afterRecords = entityRecords(current);
  const after = new Map(afterRecords.map((record) => [entityKey(record.entity, record.entityId), record]));
  const versions = readVersions();
  let queue = readQueue();
  let changed = false;
  for (const record of afterRecords) {
    const old = before.get(entityKey(record.entity, record.entityId));
    if (!old || old.comparable !== record.comparable) { queue = enqueue(queue, makeUpsert(record, versions)); changed = true; }
  }
  for (const record of beforeRecords) {
    if (after.has(entityKey(record.entity, record.entityId))) continue;
    const updatedAt = new Date().toISOString();
    queue = enqueue(queue, { id: uid(), entity: record.entity, entityId: record.entityId, operation: "delete", updatedAt });
    changed = true;
  }
  if (changed) { saveQueue(queue); saveVersions(versions); }
}

function queueRecords(records: EntityRecord[]) {
  const versions = readVersions();
  let queue = readQueue();
  for (const record of records) queue = enqueue(queue, makeUpsert(record, versions));
  saveQueue(queue);
  saveVersions(versions);
}

export function mergeRemoteChanges(snapshot: SyncSnapshot, changes: RemoteSyncChange[]): SyncSnapshot {
  const pending = new Map(readQueue().map((operation) => [entityKey(operation.entity, operation.entityId), operation]));
  const versions = readVersions();
  const tasks = [...snapshot.tasks]; const events = [...snapshot.events]; const routines = [...snapshot.routines];
  for (const change of changes) {
    const local = pending.get(entityKey(change.entity, change.entityId));
    if (local && local.updatedAt.localeCompare(change.updatedAt) > 0) continue;
    const collection = change.entity === "task" ? tasks : change.entity === "event" ? events : routines;
    const index = collection.findIndex((item) => item.id === change.entityId);
    if (change.operation === "delete") { if (index >= 0) collection.splice(index, 1); continue; }
    if (!change.payload || !payloadMatchesEntity(change.entity, change.payload)) continue;
    rememberVersion(versions, change.entity, change.entityId, change.payload.syncVersion);
    if (change.entity === "task") {
      const incoming = fromSyncedTask(change.payload as SyncedTask); if (index >= 0) tasks[index] = incoming; else tasks.push(incoming);
    } else if (change.entity === "event") {
      const incoming = fromSyncedEvent(change.payload as SyncedEvent); if (index >= 0) events[index] = incoming; else events.push(incoming);
    } else {
      const incoming = fromSyncedRoutine(change.payload as SyncedRoutine); if (index >= 0) routines[index] = incoming; else routines.push(incoming);
    }
  }
  saveVersions(versions);
  return { tasks: tasks.sort((a, b) => a.dueAt.localeCompare(b.dueAt)), events: events.sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    routines: routines.sort((a, b) => a.time.localeCompare(b.time)) };
}

export async function getDesktopSyncStatus(): Promise<SyncDeviceStatus | undefined> {
  if (!isDesktopApp()) return undefined;
  return (await invokeDesktop<SyncDeviceStatus | null>("sync_device_status")) ?? undefined;
}

export async function registerDesktopSyncDevice(apiUrl: string, setupCode: string, deviceName: string) {
  if (!isDesktopApp()) throw new Error("Подключение доступно в настольном приложении DayDesk");
  const result = await invokeDesktop<SyncDeviceStatus>("register_sync_device", {
    input: { apiUrl: apiUrl.trim(), setupCode: setupCode.trim(), deviceName: deviceName.trim() },
  });
  localStorage.setItem(CURSOR_KEY, "0"); localStorage.removeItem(ENTITY_SET_KEY);
  return result;
}

async function performSync(snapshot: SyncSnapshot): Promise<DesktopSyncResult | undefined> {
  if (!isDesktopApp() || !(await getDesktopSyncStatus())) return undefined;
  const initialCursor = readCursor();
  const records = entityRecords(snapshot);
  if (initialCursor > 0 && localStorage.getItem(ENTITY_SET_KEY) !== "ready") {
    queueRecords(records.filter((record) => record.entity !== "task"));
    localStorage.setItem(ENTITY_SET_KEY, "ready");
  }
  const allChanges: RemoteSyncChange[] = []; const remoteEntityKeys = new Set<string>();
  let serverTime = new Date().toISOString(); let initialReconciliation = initialCursor === 0; let reconciled = false;
  for (let round = 0; round < 20; round += 1) {
    const cursor = readCursor(); const changes = readQueue().slice(0, 500);
    const rawResponse = await invokeDesktop<unknown>("exchange_sync_changes", { request: { cursor, changes } });
    if (!isRecord(rawResponse) || !Number.isInteger(rawResponse.cursor) || !Array.isArray(rawResponse.acceptedOperationIds)
      || !rawResponse.acceptedOperationIds.every((id) => typeof id === "string") || !Array.isArray(rawResponse.changes)
      || !rawResponse.changes.every(isRemoteChange) || typeof rawResponse.hasMore !== "boolean" || typeof rawResponse.serverTime !== "string") {
      throw new Error("Сервер вернул некорректный ответ синхронизации");
    }
    const response = rawResponse as unknown as SyncResponse;
    const accepted = new Set(response.acceptedOperationIds);
    saveQueue(readQueue().filter((change) => !accepted.has(change.id)));
    localStorage.setItem(CURSOR_KEY, String(response.cursor));
    response.changes.forEach((change) => remoteEntityKeys.add(entityKey(change.entity, change.entityId)));
    allChanges.push(...response.changes); serverTime = response.serverTime;
    if (initialReconciliation && !response.hasMore && !reconciled) {
      queueRecords(records.filter((record) => !remoteEntityKeys.has(entityKey(record.entity, record.entityId))));
      localStorage.setItem(ENTITY_SET_KEY, "ready"); reconciled = true; initialReconciliation = false;
    }
    if (!response.hasMore && readQueue().length === 0) break;
  }
  return { changes: allChanges, serverTime };
}

export function syncDesktopData(snapshot: SyncSnapshot) {
  if (!activeSync) activeSync = performSync(snapshot).finally(() => { activeSync = undefined; });
  return activeSync;
}

export async function disconnectDesktopSyncDevice() {
  if (!isDesktopApp()) return;
  await invokeDesktop<void>("disconnect_sync_device");
  localStorage.setItem(CURSOR_KEY, "0"); localStorage.removeItem(ENTITY_SET_KEY); saveQueue([]);
}
