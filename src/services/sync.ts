import type { Task, TaskRecurrence } from "../types";

const QUEUE_KEY = "daydesk:sync:queue:v1";
const CURSOR_KEY = "daydesk:sync:cursor:v1";
const VERSIONS_KEY = "daydesk:sync:versions:v1";
const MAX_LOCAL_OPERATIONS = 5_000;

export interface SyncDeviceStatus {
  apiUrl: string;
  deviceId: string;
  deviceName: string;
}

interface SyncedTask {
  id: string;
  title: string;
  completed: boolean;
  dueAt: string;
  priority: Task["priority"];
  category: string;
  reminderEnabled: boolean;
  remindBeforeMinutes: number;
  recurrence: "none" | "daily" | "weekdays" | "weekly";
  desktopRecurrence?: TaskRecurrence;
  snoozedUntil?: string;
  updatedAt: string;
  syncVersion: number;
}

interface LocalChange {
  id: string;
  entity: "task";
  entityId: string;
  operation: "upsert" | "delete";
  updatedAt: string;
  payload?: SyncedTask;
}

export interface RemoteTaskChange {
  sequence: number;
  entity: "task";
  entityId: string;
  operation: "upsert" | "delete";
  updatedAt: string;
  payload?: SyncedTask;
}

interface SyncResponse {
  cursor: number;
  acceptedOperationIds: string[];
  changes: RemoteTaskChange[];
  hasMore: boolean;
  serverTime: string;
}

export interface DesktopSyncResult {
  changes: RemoteTaskChange[];
  serverTime: string;
}

let activeSync: Promise<DesktopSyncResult | undefined> | undefined;

const uid = () => crypto.randomUUID?.() ?? `sync-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const isDesktopApp = () => "__TAURI_INTERNALS__" in window;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

async function invokeDesktop<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, payload);
}

function isSyncedTask(value: unknown): value is SyncedTask {
  if (!isRecord(value)) return false;
  const recurrence = value.desktopRecurrence;
  const validDesktopRecurrence = recurrence === undefined || (isRecord(recurrence)
    && ["daily", "weekdays", "weekly", "custom"].includes(String(recurrence.mode))
    && Array.isArray(recurrence.days)
    && recurrence.days.length <= 7
    && recurrence.days.every((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)
    && typeof recurrence.seriesId === "string");
  return typeof value.id === "string"
    && typeof value.title === "string"
    && typeof value.completed === "boolean"
    && typeof value.dueAt === "string"
    && ["high", "medium", "low"].includes(String(value.priority))
    && typeof value.category === "string"
    && typeof value.reminderEnabled === "boolean"
    && Number.isInteger(value.remindBeforeMinutes)
    && ["none", "daily", "weekdays", "weekly"].includes(String(value.recurrence))
    && validDesktopRecurrence
    && (value.snoozedUntil === undefined || typeof value.snoozedUntil === "string")
    && typeof value.updatedAt === "string"
    && Number.isInteger(value.syncVersion);
}

function isLocalChange(value: unknown): value is LocalChange {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || value.entity !== "task"
    || typeof value.entityId !== "string"
    || !["upsert", "delete"].includes(String(value.operation))
    || typeof value.updatedAt !== "string") return false;
  return value.operation === "delete" ? value.payload === undefined : isSyncedTask(value.payload);
}

function readQueue(): LocalChange[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(0, MAX_LOCAL_OPERATIONS).filter(isLocalChange) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: LocalChange[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_LOCAL_OPERATIONS)));
}

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
  } catch {
    return {};
  }
}

function saveVersions(versions: Record<string, number>) {
  localStorage.setItem(VERSIONS_KEY, JSON.stringify(versions));
}

function toSyncedTask(task: Task, updatedAt: string, syncVersion: number): SyncedTask {
  const simpleRecurrence = task.recurrence && task.recurrence.mode !== "custom" ? task.recurrence.mode : "none";
  return {
    id: task.id,
    title: task.title,
    completed: task.completed,
    dueAt: task.dueAt,
    priority: task.priority,
    category: task.category,
    reminderEnabled: task.reminderEnabled ?? false,
    remindBeforeMinutes: task.remindBeforeMinutes ?? 0,
    recurrence: simpleRecurrence,
    ...(task.recurrence ? { desktopRecurrence: task.recurrence } : {}),
    ...(task.snoozedUntil ? { snoozedUntil: task.snoozedUntil } : {}),
    updatedAt,
    syncVersion,
  };
}

function fromSyncedTask(task: SyncedTask): Task {
  const recurrence = task.desktopRecurrence ?? (task.recurrence === "none" ? undefined : {
    mode: task.recurrence,
    days: [],
    seriesId: `sync:${task.id}`,
  });
  return {
    id: task.id,
    title: task.title,
    completed: task.completed,
    dueAt: task.dueAt,
    priority: task.priority,
    category: task.category,
    reminderEnabled: task.reminderEnabled,
    remindBeforeMinutes: task.remindBeforeMinutes,
    recurrence,
    snoozedUntil: task.snoozedUntil,
  };
}

function comparableTask(task: Task) {
  return JSON.stringify({
    id: task.id,
    title: task.title,
    completed: task.completed,
    dueAt: task.dueAt,
    priority: task.priority,
    category: task.category,
    reminderEnabled: task.reminderEnabled ?? false,
    remindBeforeMinutes: task.remindBeforeMinutes ?? 0,
    recurrence: task.recurrence,
    snoozedUntil: task.snoozedUntil,
  });
}

function enqueue(queue: LocalChange[], change: LocalChange) {
  return [...queue.filter((item) => item.entityId !== change.entityId), change];
}

function makeUpsert(task: Task, versions: Record<string, number>): LocalChange {
  const updatedAt = new Date().toISOString();
  const syncVersion = (versions[task.id] ?? 0) + 1;
  versions[task.id] = syncVersion;
  return {
    id: uid(),
    entity: "task",
    entityId: task.id,
    operation: "upsert",
    updatedAt,
    payload: toSyncedTask(task, updatedAt, syncVersion),
  };
}

export function recordTaskChanges(previous: Task[], current: Task[]) {
  const before = new Map(previous.map((task) => [task.id, task]));
  const after = new Map(current.map((task) => [task.id, task]));
  const versions = readVersions();
  let queue = readQueue();
  let changed = false;
  for (const task of current) {
    const old = before.get(task.id);
    if (!old || comparableTask(old) !== comparableTask(task)) {
      queue = enqueue(queue, makeUpsert(task, versions));
      changed = true;
    }
  }
  for (const task of previous) {
    if (after.has(task.id)) continue;
    const updatedAt = new Date().toISOString();
    queue = enqueue(queue, { id: uid(), entity: "task", entityId: task.id, operation: "delete", updatedAt });
    changed = true;
  }
  if (changed) {
    saveQueue(queue);
    saveVersions(versions);
  }
}

function queueTasks(tasks: Task[]) {
  const versions = readVersions();
  let queue = readQueue();
  for (const task of tasks) queue = enqueue(queue, makeUpsert(task, versions));
  saveQueue(queue);
  saveVersions(versions);
}

export function mergeRemoteTaskChanges(tasks: Task[], changes: RemoteTaskChange[]): Task[] {
  const pending = new Map(readQueue().map((operation) => [operation.entityId, operation]));
  const versions = readVersions();
  const next = [...tasks];
  for (const change of changes) {
    const local = pending.get(change.entityId);
    if (local && local.updatedAt.localeCompare(change.updatedAt) > 0) continue;
    const index = next.findIndex((task) => task.id === change.entityId);
    if (change.operation === "delete") {
      if (index >= 0) next.splice(index, 1);
      continue;
    }
    if (!change.payload) continue;
    versions[change.entityId] = Math.max(versions[change.entityId] ?? 0, change.payload.syncVersion);
    const incoming = fromSyncedTask(change.payload);
    if (index >= 0) next[index] = incoming;
    else next.push(incoming);
  }
  saveVersions(versions);
  return next.sort((left, right) => left.dueAt.localeCompare(right.dueAt));
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
  localStorage.setItem(CURSOR_KEY, "0");
  return result;
}

async function performSync(tasks: Task[]): Promise<DesktopSyncResult | undefined> {
  if (!isDesktopApp() || !(await getDesktopSyncStatus())) return undefined;
  const allChanges: RemoteTaskChange[] = [];
  const remoteEntityIds = new Set<string>();
  let serverTime = new Date().toISOString();
  let initialReconciliation = readCursor() === 0;
  let reconciled = false;
  for (let round = 0; round < 20; round += 1) {
    const cursor = readCursor();
    const changes = readQueue().slice(0, 500);
    const response = await invokeDesktop<SyncResponse>("exchange_sync_changes", { request: { cursor, changes } });
    const accepted = new Set(response.acceptedOperationIds);
    saveQueue(readQueue().filter((change) => !accepted.has(change.id)));
    localStorage.setItem(CURSOR_KEY, String(response.cursor));
    response.changes.forEach((change) => remoteEntityIds.add(change.entityId));
    allChanges.push(...response.changes);
    serverTime = response.serverTime;
    if (initialReconciliation && !response.hasMore && !reconciled) {
      queueTasks(tasks.filter((task) => !remoteEntityIds.has(task.id)));
      reconciled = true;
      initialReconciliation = false;
    }
    if (!response.hasMore && readQueue().length === 0) break;
  }
  return { changes: allChanges, serverTime };
}

export function syncDesktopTasks(tasks: Task[]) {
  if (!activeSync) activeSync = performSync(tasks).finally(() => { activeSync = undefined; });
  return activeSync;
}

export async function disconnectDesktopSyncDevice() {
  if (!isDesktopApp()) return;
  await invokeDesktop<void>("disconnect_sync_device");
  localStorage.setItem(CURSOR_KEY, "0");
  saveQueue([]);
}
