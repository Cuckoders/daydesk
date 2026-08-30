import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import type { RemoteSyncChange, Task } from '@/src/types';

const API_URL_KEY = 'daydesk.sync.api-url';
const DEVICE_ID_KEY = 'daydesk.sync.device-id';
const DEVICE_TOKEN_KEY = 'daydesk.sync.device-token';
const DEVICE_NAME_KEY = 'daydesk.sync.device-name';
const REQUEST_TIMEOUT_MS = 12_000;

export interface SyncConfiguration {
  apiUrl: string;
  deviceId: string;
  deviceToken: string;
  deviceName: string;
}

interface SyncPayload {
  cursor: number;
  acceptedOperationIds: string[];
  changes: RemoteSyncChange[];
  hasMore: boolean;
  serverTime: string;
}

let activeSync: Promise<boolean> | undefined;

const withoutNotification = ({ notificationId: _notificationId, ...task }: Task) => task;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function readRegistrationResponse(value: unknown) {
  if (!isRecord(value) || value.status !== 'success' || !isRecord(value.data) || typeof value.data.id !== 'string' || typeof value.data.token !== 'string') {
    throw new Error('Сервер вернул некорректный ответ регистрации');
  }
  return { id: value.data.id, token: value.data.token };
}

function isRemoteChange(value: unknown): value is RemoteSyncChange {
  if (!isRecord(value) || !Number.isInteger(value.sequence) || value.entity !== 'task' || typeof value.entityId !== 'string' || typeof value.updatedAt !== 'string') return false;
  if (value.operation === 'delete') return true;
  if (value.operation !== 'upsert' || !isRecord(value.payload)) return false;
  const payload = value.payload;
  const desktopRecurrence = payload.desktopRecurrence;
  const recurrenceIsValid = desktopRecurrence === undefined || (isRecord(desktopRecurrence)
    && ['daily', 'weekdays', 'weekly', 'custom'].includes(String(desktopRecurrence.mode))
    && Array.isArray(desktopRecurrence.days)
    && desktopRecurrence.days.length <= 7
    && desktopRecurrence.days.every((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)
    && typeof desktopRecurrence.seriesId === 'string');
  return typeof payload.id === 'string'
    && typeof payload.title === 'string'
    && typeof payload.completed === 'boolean'
    && typeof payload.dueAt === 'string'
    && ['high', 'medium', 'low'].includes(String(payload.priority))
    && typeof payload.category === 'string'
    && typeof payload.reminderEnabled === 'boolean'
    && Number.isInteger(payload.remindBeforeMinutes)
    && ['none', 'daily', 'weekdays', 'weekly'].includes(String(payload.recurrence))
    && recurrenceIsValid
    && (payload.snoozedUntil === undefined || typeof payload.snoozedUntil === 'string')
    && typeof payload.updatedAt === 'string'
    && Number.isInteger(payload.syncVersion);
}

function readSyncResponse(value: unknown): SyncPayload {
  if (!isRecord(value) || value.status !== 'success' || !isRecord(value.data)) throw new Error('Сервер вернул некорректный ответ синхронизации');
  const data = value.data;
  if (!Number.isInteger(data.cursor)
    || !Array.isArray(data.acceptedOperationIds)
    || !data.acceptedOperationIds.every((item) => typeof item === 'string')
    || !Array.isArray(data.changes)
    || !data.changes.every(isRemoteChange)
    || typeof data.hasMore !== 'boolean'
    || typeof data.serverTime !== 'string') {
    throw new Error('Сервер вернул некорректный ответ синхронизации');
  }
  return data as unknown as SyncPayload;
}

function normalizeApiUrl(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Некорректный адрес сервера');
  }
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.startsWith('10.') || url.hostname.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
  if (url.protocol !== 'https:' && !localHost) throw new Error('Для внешнего сервера необходим HTTPS');
  return url.toString().replace(/\/$/, '');
}

async function nativeOnly() {
  if (Platform.OS === 'web') throw new Error('Защищённая синхронизация доступна в приложении iOS или Android');
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json', ...init.headers } });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Сервер отклонил авторизацию устройства');
      if (response.status === 429) throw new Error('Слишком много запросов. Попробуйте позже');
      throw new Error('Сервер синхронизации временно недоступен');
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Сервер не ответил вовремя');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getSyncConfiguration(): Promise<SyncConfiguration | undefined> {
  if (Platform.OS === 'web') return undefined;
  const [apiUrl, deviceId, deviceToken, deviceName] = await Promise.all([
    SecureStore.getItemAsync(API_URL_KEY),
    SecureStore.getItemAsync(DEVICE_ID_KEY),
    SecureStore.getItemAsync(DEVICE_TOKEN_KEY),
    SecureStore.getItemAsync(DEVICE_NAME_KEY),
  ]);
  if (!apiUrl || !deviceId || !deviceToken) return undefined;
  return { apiUrl, deviceId, deviceToken, deviceName: deviceName || 'DayDesk Mobile' };
}

export async function registerSyncDevice(apiUrlInput: string, setupCode: string, deviceName: string) {
  await nativeOnly();
  const apiUrl = normalizeApiUrl(apiUrlInput);
  if (setupCode.trim().length < 12) throw new Error('Setup-код должен содержать не меньше 12 символов');
  if (!deviceName.trim()) throw new Error('Укажите название устройства');
  const response = await request<unknown>(`${apiUrl}/v1/devices/register`, {
    method: 'POST',
    body: JSON.stringify({ setupCode: setupCode.trim(), name: deviceName.trim() }),
  });
  const device = readRegistrationResponse(response);
  await Promise.all([
    SecureStore.setItemAsync(API_URL_KEY, apiUrl),
    SecureStore.setItemAsync(DEVICE_ID_KEY, device.id),
    SecureStore.setItemAsync(DEVICE_TOKEN_KEY, device.token),
    SecureStore.setItemAsync(DEVICE_NAME_KEY, deviceName.trim()),
  ]);
  useDayDeskStore.setState({ syncCursor: 0 });
  return device;
}

async function performSync() {
  if (!useDayDeskStore.getState().hydrated) return false;
  const configuration = await getSyncConfiguration();
  if (!configuration) return false;
  const store = useDayDeskStore.getState();
  store.setSyncStatus('syncing');
  try {
    let hasMore = true;
    let rounds = 0;
    const initialState = useDayDeskStore.getState();
    const initialReconciliation = initialState.syncCursor === 0;
    const initialTaskIds = initialState.tasks.map((task) => task.id);
    const remoteEntityIds = new Set<string>();
    let reconciled = false;
    while (hasMore && rounds < 20) {
      rounds += 1;
      const state = useDayDeskStore.getState();
      const operations = state.syncQueue.slice(0, 500);
      const changes = operations.flatMap((operation) => {
        const envelope = {
          id: operation.id,
          entity: operation.entity,
          entityId: operation.entityId,
          operation: operation.operation,
          updatedAt: operation.createdAt,
        };
        if (operation.operation === 'delete') return [envelope];
        const task = state.tasks.find((item) => item.id === operation.entityId);
        return task ? [{ ...envelope, updatedAt: task.updatedAt, payload: withoutNotification(task) }] : [];
      });
      const response = readSyncResponse(await request<unknown>(`${configuration.apiUrl}/v1/sync`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${configuration.deviceToken}`,
          'x-device-id': configuration.deviceId,
        },
        body: JSON.stringify({ cursor: state.syncCursor, changes }),
      }));
      response.changes.forEach((change) => remoteEntityIds.add(change.entityId));
      await useDayDeskStore.getState().applySyncResult(
        response.changes,
        response.acceptedOperationIds,
        response.cursor,
        response.serverTime,
      );
      if (initialReconciliation && !response.hasMore && !reconciled) {
        useDayDeskStore.getState().queueTasksForSync(initialTaskIds.filter((taskId) => !remoteEntityIds.has(taskId)));
        reconciled = true;
      }
      hasMore = response.hasMore || useDayDeskStore.getState().syncQueue.length > 0;
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Не удалось синхронизировать данные';
    useDayDeskStore.getState().setSyncStatus('error', message);
    return false;
  }
}

export function syncNow() {
  if (!activeSync) activeSync = performSync().finally(() => { activeSync = undefined; });
  return activeSync;
}

export async function disconnectSyncDevice() {
  const configuration = await getSyncConfiguration();
  if (configuration) {
    try {
      await request<void>(`${configuration.apiUrl}/v1/devices/current`, {
        method: 'DELETE',
        headers: {
          authorization: `Bearer ${configuration.deviceToken}`,
          'x-device-id': configuration.deviceId,
        },
      });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Сервер отклонил авторизацию устройства') throw error;
    }
  }
  if (Platform.OS !== 'web') {
    await Promise.all([
      SecureStore.deleteItemAsync(API_URL_KEY),
      SecureStore.deleteItemAsync(DEVICE_ID_KEY),
      SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY),
      SecureStore.deleteItemAsync(DEVICE_NAME_KEY),
    ]);
  }
  useDayDeskStore.setState({ syncCursor: 0, syncQueue: [], syncStatus: 'idle', syncError: undefined, lastSyncedAt: undefined });
}
