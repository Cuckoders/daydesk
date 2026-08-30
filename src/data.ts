import type { AppState } from "./types";

const todayAt = (hours: number, minutes = 0) => {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
};

export const initialState: AppState = {
  tasks: [
    { id: "t1", title: "Подготовить презентацию", completed: false, dueAt: todayAt(11, 30), priority: "high", category: "Работа", remindBeforeMinutes: 10, reminderEnabled: true },
    { id: "t2", title: "Ответить команде", completed: true, dueAt: todayAt(10), priority: "medium", category: "Работа", remindBeforeMinutes: 0, reminderEnabled: false },
    { id: "t3", title: "Заказать продукты", completed: false, dueAt: todayAt(18, 30), priority: "low", category: "Личное", remindBeforeMinutes: 30, reminderEnabled: true },
    { id: "t4", title: "Записаться к стоматологу", completed: false, dueAt: todayAt(16), priority: "medium", category: "Здоровье", remindBeforeMinutes: 60, reminderEnabled: true },
  ],
  events: [
    { id: "e1", title: "Утренняя планёрка", startsAt: todayAt(9, 30), endsAt: todayAt(10), type: "meeting", location: "Google Meet", remindBeforeMinutes: 10 },
    { id: "e3", title: "Встреча с Анной", startsAt: todayAt(15), endsAt: todayAt(16), type: "meeting", location: "Переговорная 2", remindBeforeMinutes: 10 },
    { id: "e4", title: "Фокус-время", startsAt: todayAt(17), endsAt: todayAt(18, 30), type: "focus", remindBeforeMinutes: 5 },
  ],
  routines: [
    { id: "r-water", title: "Выпить воды", time: "10:30", days: [1, 2, 3, 4, 5], kind: "water", remindBeforeMinutes: 0, enabled: true },
    { id: "r-lunch", title: "Обед", time: "13:00", days: [1, 2, 3, 4, 5], kind: "meal", remindBeforeMinutes: 10, enabled: true },
    { id: "r-break", title: "Перерыв и разминка", time: "16:00", days: [1, 2, 3, 4, 5], kind: "break", remindBeforeMinutes: 0, enabled: true },
    { id: "r-dinner", title: "Ужин", time: "20:00", days: [0, 1, 2, 3, 4, 5, 6], kind: "meal", remindBeforeMinutes: 10, enabled: true },
  ],
  accounts: [],
  messages: [],
};
