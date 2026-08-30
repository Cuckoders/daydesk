import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import type { CalendarEvent, Routine, Task } from '@/src/types';

const CHANNEL_ID = 'daydesk-reminders';
const MAIL_CHANNEL_ID = 'daydesk-mail';
const MAIL_NOTIFICATION_ID = 'daydesk-mail-summary';

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

async function ensureMailChannel() {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(MAIL_CHANNEL_ID, {
    name: 'Новая почта',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#167654',
  });
}

export async function requestReminderPermission(allowRequest = true) {
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  if (!allowRequest) return false;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export async function cancelReminder(identifier?: string) {
  if (!identifier) return;
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => undefined);
}

export async function cancelReminders(identifiers: (string | undefined)[]) {
  await Promise.all(identifiers.map((identifier) => cancelReminder(identifier)));
}

export async function notifyNewMail(count: number) {
  if (!Number.isInteger(count) || count < 1 || count > 1_000) return undefined;
  await ensureMailChannel();
  return Notifications.scheduleNotificationAsync({
    identifier: MAIL_NOTIFICATION_ID,
    content: {
      title: count === 1 ? 'Новое письмо в DayDesk' : `Новые письма в DayDesk · ${count}`,
      body: 'Откройте единую почту, чтобы посмотреть обновления.',
      data: { url: '/mail' },
      sound: true,
    },
    trigger: null,
  });
}

export async function clearNewMailNotification() {
  await Promise.all([
    Notifications.cancelScheduledNotificationAsync(MAIL_NOTIFICATION_ID).catch(() => undefined),
    Notifications.dismissNotificationAsync(MAIL_NOTIFICATION_ID).catch(() => undefined),
  ]);
}

export async function scheduleTaskReminder(task: Pick<Task, 'id' | 'title' | 'dueAt' | 'remindBeforeMinutes'>, allowPermissionRequest = true) {
  const reminderDate = new Date(new Date(task.dueAt).getTime() - task.remindBeforeMinutes * 60_000);
  if (reminderDate.getTime() <= Date.now()) return undefined;
  if (!(await requestReminderPermission(allowPermissionRequest))) return undefined;
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

export async function scheduleEventReminder(event: Pick<CalendarEvent, 'id' | 'title' | 'startsAt' | 'remindBeforeMinutes'>, allowPermissionRequest = true) {
  const reminderDate = new Date(new Date(event.startsAt).getTime() - event.remindBeforeMinutes * 60_000);
  if (reminderDate.getTime() <= Date.now()) return undefined;
  if (!(await requestReminderPermission(allowPermissionRequest))) return undefined;
  await ensureChannel();
  return Notifications.scheduleNotificationAsync({
    content: {
      title: 'Событие скоро начнётся',
      body: event.title,
      data: { url: '/calendar', eventId: event.id },
      sound: true,
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: reminderDate, channelId: CHANNEL_ID },
  });
}

export async function scheduleRoutineReminders(routine: Routine, allowPermissionRequest = true) {
  if (!(await requestReminderPermission(allowPermissionRequest))) return undefined;
  await ensureChannel();
  const [hour, minute] = routine.time.split(':').map(Number);
  return Promise.all(routine.days.map((day) => {
    const minuteOfWeek = (day * 24 * 60 + hour * 60 + minute - routine.remindBeforeMinutes + 7 * 24 * 60) % (7 * 24 * 60);
    return Notifications.scheduleNotificationAsync({
      content: {
        title: routine.title,
        body: 'Пора сделать небольшую паузу по плану DayDesk.',
        data: { url: `/routine-editor?id=${routine.id}`, routineId: routine.id },
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
        weekday: Math.floor(minuteOfWeek / (24 * 60)) + 1,
        hour: Math.floor((minuteOfWeek % (24 * 60)) / 60),
        minute: minuteOfWeek % 60,
        channelId: CHANNEL_ID,
      },
    });
  }));
}
