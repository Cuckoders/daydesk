import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import type { Routine, Task } from '@/src/types';

const CHANNEL_ID = 'daydesk-reminders';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

async function ensureChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Напоминания DayDesk',
    importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 200, 120, 200],
    lightColor: '#167654',
  });
}

export async function requestReminderPermission() {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export async function cancelReminder(identifier?: string) {
  if (!identifier) return;
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => undefined);
}

export async function scheduleTaskReminder(task: Pick<Task, 'id' | 'title' | 'dueAt' | 'remindBeforeMinutes'>) {
  const reminderDate = new Date(new Date(task.dueAt).getTime() - task.remindBeforeMinutes * 60_000);
  if (reminderDate.getTime() <= Date.now()) return undefined;
  if (!(await requestReminderPermission())) return undefined;
  await ensureChannel();
  return Notifications.scheduleNotificationAsync({
    content: {
      title: 'Задача скоро начнётся',
      body: task.title,
      data: { url: `/task-editor?id=${task.id}`, taskId: task.id },
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: reminderDate,
      channelId: CHANNEL_ID,
    },
  });
}

export async function scheduleRoutineReminder(routine: Routine) {
  if (!(await requestReminderPermission())) return undefined;
  await ensureChannel();
  const [hour, minute] = routine.time.split(':').map(Number);
  return Notifications.scheduleNotificationAsync({
    content: {
      title: routine.title,
      body: 'Пора сделать небольшую паузу по плану DayDesk.',
      data: { url: '/(tabs)' },
      sound: true,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour,
      minute,
      channelId: CHANNEL_ID,
    },
  });
}
