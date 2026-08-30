import { Platform } from 'react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { compareAndRecordMailSnapshot, clearMailCheckpoints } from '@/src/services/mail-checkpoint';
import { loadMailAccounts, synchronizeMail } from '@/src/services/mail';
import { clearNewMailNotification, notifyNewMail, requestReminderPermission } from '@/src/services/notifications';

const TASK_NAME = 'daydesk-background-mail-v1';
const MINIMUM_INTERVAL_MINUTES = 15;

async function performMailCheck() {
  const snapshot = await synchronizeMail(undefined, 'inbox', false);
  const newUnread = await compareAndRecordMailSnapshot(snapshot.messages, snapshot.accounts);
  if (newUnread > 0 && await requestReminderPermission(false)) await notifyNewMail(newUnread);
}

if (Platform.OS !== 'web' && !TaskManager.isTaskDefined(TASK_NAME)) {
  TaskManager.defineTask(TASK_NAME, async () => {
    try {
      await performMailCheck();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function getMailBackgroundState() {
  if (Platform.OS === 'web') return { available: false, enabled: false };
  const [taskManagerAvailable, status, enabled] = await Promise.all([
    TaskManager.isAvailableAsync(), BackgroundTask.getStatusAsync(), TaskManager.isTaskRegisteredAsync(TASK_NAME),
  ]);
  return { available: taskManagerAvailable && status === BackgroundTask.BackgroundTaskStatus.Available, enabled };
}

export async function enableMailBackgroundNotifications() {
  if (Platform.OS === 'web') throw new Error('Фоновая почта доступна только в приложении iOS или Android');
  const state = await getMailBackgroundState();
  if (!state.available) throw new Error('Фоновые задачи недоступны. Используйте development или production build на реальном устройстве');
  if (!(await loadMailAccounts()).length) throw new Error('Сначала подключите хотя бы один почтовый аккаунт');
  if (!(await requestReminderPermission(true))) throw new Error('Разрешите уведомления в системных настройках');
  await synchronizeMail(undefined, 'inbox');
  if (!state.enabled) await BackgroundTask.registerTaskAsync(TASK_NAME, { minimumInterval: MINIMUM_INTERVAL_MINUTES });
}

export async function disableMailBackgroundNotifications() {
  let failure: unknown;
  try {
    if (Platform.OS !== 'web' && await TaskManager.isTaskRegisteredAsync(TASK_NAME)) await BackgroundTask.unregisterTaskAsync(TASK_NAME);
  } catch (error) { failure = error; }
  await Promise.all([clearMailCheckpoints(), clearNewMailNotification()]);
  if (failure) throw failure;
}
