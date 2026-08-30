const ruDate = new Intl.DateTimeFormat('ru-RU', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

const ruShortDate = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'short',
});

const ruTime = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
});

export const formatLongDate = (date: Date) => ruDate.format(date);
export const formatShortDate = (value: string | Date) => ruShortDate.format(new Date(value));
export const formatTime = (value: string | Date) => ruTime.format(new Date(value));

export function isSameDay(left: string | Date, right: string | Date) {
  const a = new Date(left);
  const b = new Date(right);
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function todayAt(hours: number, minutes = 0) {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

export function tomorrowAt(hours: number, minutes = 0) {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

export function nextDueDate(dueAt: string, recurrence: 'daily' | 'weekdays' | 'weekly') {
  const next = new Date(dueAt);
  do {
    next.setDate(next.getDate() + (recurrence === 'weekly' ? 7 : 1));
    if (recurrence === 'weekdays') {
      while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
    }
  } while (next.getTime() <= Date.now());
  return next.toISOString();
}

export function nextDueDateForDays(dueAt: string, days: number[]) {
  if (days.length === 0) return undefined;
  const due = new Date(dueAt);
  const threshold = Math.max(due.getTime(), Date.now());
  for (let offset = 1; offset <= 370; offset += 1) {
    const candidate = new Date(due);
    candidate.setDate(due.getDate() + offset);
    if (candidate.getTime() > threshold && days.includes(candidate.getDay())) return candidate.toISOString();
  }
  return undefined;
}

export function timeUntil(value: string) {
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return 'срок прошёл';
  const minutes = Math.ceil(diff / 60_000);
  if (minutes < 60) return `через ${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `через ${hours} ч`;
  return formatShortDate(value);
}
