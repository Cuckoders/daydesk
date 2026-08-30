import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import type { CalendarEvent, RemoteSyncChange, Routine, SyncOperation, Task } from '@/src/types';

const API_URL_KEY = 'daydesk.sync.api-url';
const DEVICE_ID_KEY = 'daydesk.sync.device-id';
const DEVICE_TOKEN_KEY = 'daydesk.sync.device-token';
const DEVICE_NAME_KEY = 'daydesk.sync.device-name';
const ENTITY_SET_KEY = 'daydesk.sync.entities-v2';
const REQUEST_TIMEOUT_MS = 12_000;

export interface SyncConfiguration { apiUrl: string; deviceId: string; deviceToken: string; deviceName: string }

interface SyncPayload {
  cursor: number; acceptedOperationIds: string[]; changes: RemoteSyncChange[]; hasMore: boolean; serverTime: string;
}

let activeSync: Promise<boolean> | undefined;

const entityKey = (entity: SyncOperation['entity'], entityId: string) => `${entity}:${entityId}`;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasMetadata = (value: Record<string, unknown>) => typeof value.updatedAt === 'string' && Number.isInteger(value.syncVersion);

function withoutTaskNotification({ notificationId: _notificationId, ...task }: Task) { return task; }
function withoutEventNotification({ notificationId: _notificationId, ...event }: CalendarEvent) { return event; }
function withoutRoutineNotifications({ notificationId: _notificationId, notificationIds: _notificationIds, ...routine }: Routine) { return routine; }

function readRegistrationResponse(value: unknown) {
  if (!isRecord(value) || value.status !== 'success' || !isRecord(value.data) || typeof value.data.id !== 'string' || typeof value.data.token !== 'string') {
    throw new Error('Сервер вернул некорректный ответ регистрации');
  }
  return { id: value.data.id, token: value.data.token };
}

function isTaskPayload(payload: Record<string, unknown>) {
  const recurrence = payload.desktopRecurrence;
  const recurrenceIsValid = recurrence === undefined || (isRecord(recurrence)
    && ['daily', 'weekdays', 'weekly', 'custom'].includes(String(recurrence.mode))
    && Array.isArray(recurrence.days) && recurrence.days.length <= 7
    && recurrence.days.every((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)
    && typeof recurrence.seriesId === 'string');
  return hasMetadata(payload) && typeof payload.id === 'string' && typeof payload.title === 'string'
    && typeof payload.completed === 'boolean' && typeof payload.dueAt === 'string'
    && ['high', 'medium', 'low'].includes(String(payload.priority)) && typeof payload.category === 'string'
    && typeof payload.reminderEnabled === 'boolean' && Number.isInteger(payload.remindBeforeMinutes)
    && ['none', 'daily', 'weekdays', 'weekly'].includes(String(payload.recurrence)) && recurrenceIsValid
    && (payload.snoozedUntil === undefined || typeof payload.snoozedUntil === 'string');
}

function isEventPayload(payload: Record<string, unknown>) {
  return hasMetadata(payload) && typeof payload.id === 'string' && typeof payload.title === 'string'
    && typeof payload.startsAt === 'string' && typeof payload.endsAt === 'string'
    && ['meeting', 'meal', 'focus', 'personal'].includes(String(payload.type))
    && (payload.location === undefined || typeof payload.location === 'string')
    && typeof payload.reminderEnabled === 'boolean' && Number.isInteger(payload.remindBeforeMinutes)
    && (payload.allDay === undefined || typeof payload.allDay === 'boolean')
    && (payload.allDayStartDate === undefined || typeof payload.allDayStartDate === 'string')
    && (payload.allDayEndDate === undefined || typeof payload.allDayEndDate === 'string');
}

function isRoutinePayload(payload: Record<string, unknown>) {
  return hasMetadata(payload) && typeof payload.id === 'string' && typeof payload.title === 'string' && typeof payload.time === 'string'
    && Array.isArray(payload.days) && payload.days.length > 0 && payload.days.length <= 7
    && payload.days.every((day) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6)
    && ['water', 'meal', 'break', 'focus', 'custom'].includes(String(payload.kind))
    && Number.isInteger(payload.remindBeforeMinutes) && typeof payload.enabled === 'boolean';
}

function isRemoteChange(value: unknown): value is RemoteSyncChange {
  if (!isRecord(value) || !Number.isInteger(value.sequence) || !['task', 'event', 'routine'].includes(String(value.entity))
    || typeof value.entityId !== 'string' || typeof value.updatedAt !== 'string') return false;
  if (value.operation === 'delete') return value.payload === undefined;
  if (value.operation !== 'upsert' || !isRecord(value.payload)) return false;
  return value.entity === 'task' ? isTaskPayload(value.payload) : value.entity === 'event' ? isEventPayload(value.payload) : isRoutinePayload(value.payload);
}

function readSyncResponse(value: unknown): SyncPayload {
  if (!isRecord(value) || value.status !== 'success' || !isRecord(value.data)) throw new Error('Сервер вернул некорректный ответ синхронизации');
  const data = value.data;
  if (!Number.isInteger(data.cursor) || !Array.isArray(data.acceptedOperationIds)
    || !data.acceptedOperationIds.every((item) => typeof item === 'string') || !Array.isArray(data.changes)
    || !data.changes.every(isRemoteChange) || typeof data.hasMore !== 'boolean' || typeof data.serverTime !== 'string') {
    throw new Error('Сервер вернул некорректный ответ синхронизации');
  }
  return data as unknown as SyncPayload;
}

function normalizeApiUrl(value: string) {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Некорректный адрес сервера');
  const localHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.startsWith('10.')
    || url.hostname.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
  if (url.protocol !== 'https:' && !localHost) throw new Error('Для внешнего сервера необходим HTTPS');
  return url.toString().replace(/\/$/, '');
}

async function nativeOnly() {
  if (Platform.OS === 'web') throw new Error('Защищённая синхронизация доступна в приложении iOS или Android');
}

async function request<T>(url: string, init: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { 'content-type': 'application/json', ...init.headers } });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Сервер отклонил авторизацию устройства');
      if (response.status === 429) throw new Error('Слишком много запросов. Попробуйте позже');
      if (response.status === 404) throw new Error('Запрошенные данные не найдены');
      if (response.status === 400 && url.includes('/attachments/') && url.includes('/invitation')) throw new Error('Приглашение повреждено или пока не поддерживается');
      if (response.status === 422) throw new Error(url.endsWith('/v1/mail/send') ? 'Почтовый сервис отклонил отправку. OAuth-аккаунт может потребовать переподключения' : 'Почтовый сервер отклонил подключение');
      if (response.status === 503) throw new Error('Почтовый коннектор не настроен на сервере');
      throw new Error('Сервер синхронизации временно недоступен');
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('Сервер не ответил вовремя');
    throw error;
  } finally { clearTimeout(timeout); }
}

export async function authenticatedRequest<T>(path: string, init: RequestInit = {}) {
  await nativeOnly();
  const configuration = await getSyncConfiguration();
  if (!configuration) throw new Error('Сначала подключите мобильное приложение к DayDesk Sync');
  if (!path.startsWith('/v1/')) throw new Error('Некорректный путь API');
  return request<T>(`${configuration.apiUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${configuration.deviceToken}`, 'x-device-id': configuration.deviceId, ...init.headers },
  }, path.startsWith('/v1/mail/') ? 60_000 : REQUEST_TIMEOUT_MS);
}

export async function getSyncConfiguration(): Promise<SyncConfiguration | undefined> {
  if (Platform.OS === 'web') return undefined;
  const [apiUrl, deviceId, deviceToken, deviceName] = await Promise.all([
    SecureStore.getItemAsync(API_URL_KEY), SecureStore.getItemAsync(DEVICE_ID_KEY),
    SecureStore.getItemAsync(DEVICE_TOKEN_KEY), SecureStore.getItemAsync(DEVICE_NAME_KEY),
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
    method: 'POST', body: JSON.stringify({ setupCode: setupCode.trim(), name: deviceName.trim() }),
  });
  const device = readRegistrationResponse(response);
  await Promise.all([
    SecureStore.setItemAsync(API_URL_KEY, apiUrl), SecureStore.setItemAsync(DEVICE_ID_KEY, device.id),
    SecureStore.setItemAsync(DEVICE_TOKEN_KEY, device.token), SecureStore.setItemAsync(DEVICE_NAME_KEY, deviceName.trim()),
    AsyncStorage.removeItem(ENTITY_SET_KEY),
  ]);
  useDayDeskStore.setState({ syncCursor: 0 });
  return device;
}

function allLocalEntities() {
  const state = useDayDeskStore.getState();
  return [
    ...state.tasks.map((item) => ({ entity: 'task' as const, entityId: item.id })),
    ...state.events.map((item) => ({ entity: 'event' as const, entityId: item.id })),
    ...state.routines.map((item) => ({ entity: 'routine' as const, entityId: item.id })),
  ];
}

function operationChange(operation: SyncOperation) {
  const state = useDayDeskStore.getState();
  const envelope = { id: operation.id, entity: operation.entity, entityId: operation.entityId, operation: operation.operation, updatedAt: operation.createdAt };
  if (operation.operation === 'delete') return envelope;
  if (operation.entity === 'task') {
    const task = state.tasks.find((item) => item.id === operation.entityId);
    return task ? { ...envelope, updatedAt: task.updatedAt ?? operation.createdAt, payload: { ...withoutTaskNotification(task), updatedAt: task.updatedAt ?? operation.createdAt, syncVersion: task.syncVersion ?? 1 } } : undefined;
  }
  if (operation.entity === 'event') {
    const event = state.events.find((item) => item.id === operation.entityId);
    return event ? { ...envelope, updatedAt: event.updatedAt ?? operation.createdAt, payload: { ...withoutEventNotification(event), updatedAt: event.updatedAt ?? operation.createdAt, syncVersion: event.syncVersion ?? 1,
      reminderEnabled: event.reminderEnabled ?? false, remindBeforeMinutes: event.remindBeforeMinutes ?? 0 } } : undefined;
  }
  const routine = state.routines.find((item) => item.id === operation.entityId);
  return routine ? { ...envelope, updatedAt: routine.updatedAt ?? operation.createdAt, payload: { ...withoutRoutineNotifications(routine), updatedAt: routine.updatedAt ?? operation.createdAt,
    syncVersion: routine.syncVersion ?? 1, days: routine.days?.length ? routine.days : [0, 1, 2, 3, 4, 5, 6], remindBeforeMinutes: routine.remindBeforeMinutes ?? 0 } } : undefined;
}

async function performSync() {
  if (!useDayDeskStore.getState().hydrated) return false;
  const configuration = await getSyncConfiguration(); if (!configuration) return false;
  useDayDeskStore.getState().setSyncStatus('syncing');
  try {
    const initialState = useDayDeskStore.getState();
    const initialReconciliation = initialState.syncCursor === 0;
    const initialEntities = allLocalEntities();
    if (!initialReconciliation && await AsyncStorage.getItem(ENTITY_SET_KEY) !== 'ready') {
      useDayDeskStore.getState().queueEntitiesForSync(initialEntities.filter((item) => item.entity !== 'task'));
      await AsyncStorage.setItem(ENTITY_SET_KEY, 'ready');
    }
    const remoteEntityKeys = new Set<string>(); let reconciled = false; let hasMore = true; let rounds = 0;
    while (hasMore && rounds < 20) {
      rounds += 1;
      const state = useDayDeskStore.getState(); const operations = state.syncQueue.slice(0, 500);
      const changes = operations.flatMap((operation) => { const change = operationChange(operation); return change ? [change] : []; });
      const response = readSyncResponse(await request<unknown>(`${configuration.apiUrl}/v1/sync`, {
        method: 'POST', headers: { authorization: `Bearer ${configuration.deviceToken}`, 'x-device-id': configuration.deviceId },
        body: JSON.stringify({ cursor: state.syncCursor, changes }),
      }));
      response.changes.forEach((change) => remoteEntityKeys.add(entityKey(change.entity, change.entityId)));
      await useDayDeskStore.getState().applySyncResult(response.changes, response.acceptedOperationIds, response.cursor, response.serverTime);
      if (initialReconciliation && !response.hasMore && !reconciled) {
        useDayDeskStore.getState().queueEntitiesForSync(initialEntities.filter((item) => !remoteEntityKeys.has(entityKey(item.entity, item.entityId))));
        await AsyncStorage.setItem(ENTITY_SET_KEY, 'ready'); reconciled = true;
      }
      hasMore = response.hasMore || useDayDeskStore.getState().syncQueue.length > 0;
    }
    return true;
  } catch (error) {
    useDayDeskStore.getState().setSyncStatus('error', error instanceof Error ? error.message : 'Не удалось синхронизировать данные');
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
      await request<void>(`${configuration.apiUrl}/v1/devices/current`, { method: 'DELETE', headers: {
        authorization: `Bearer ${configuration.deviceToken}`, 'x-device-id': configuration.deviceId,
      } });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'Сервер отклонил авторизацию устройства') throw error;
    }
  }
  if (Platform.OS !== 'web') await Promise.all([
    SecureStore.deleteItemAsync(API_URL_KEY), SecureStore.deleteItemAsync(DEVICE_ID_KEY), SecureStore.deleteItemAsync(DEVICE_TOKEN_KEY),
    SecureStore.deleteItemAsync(DEVICE_NAME_KEY), AsyncStorage.removeItem(ENTITY_SET_KEY),
  ]);
  useDayDeskStore.setState({ syncCursor: 0, syncQueue: [], syncStatus: 'idle', syncError: undefined, lastSyncedAt: undefined });
}
