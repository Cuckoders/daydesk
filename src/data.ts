import type { AppState } from "./types";

const todayAt = (hours: number, minutes = 0) => {
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
};

export const initialState: AppState = {
  tasks: [
    { id: "t1", title: "Подготовить презентацию", completed: false, dueAt: todayAt(11, 30), priority: "high", category: "Работа" },
    { id: "t2", title: "Ответить команде", completed: true, dueAt: todayAt(10), priority: "medium", category: "Работа" },
    { id: "t3", title: "Заказать продукты", completed: false, dueAt: todayAt(18, 30), priority: "low", category: "Личное" },
    { id: "t4", title: "Записаться к стоматологу", completed: false, dueAt: todayAt(16), priority: "medium", category: "Здоровье" },
  ],
  events: [
    { id: "e1", title: "Утренняя планёрка", startsAt: todayAt(9, 30), endsAt: todayAt(10), type: "meeting", location: "Google Meet", remindBeforeMinutes: 10 },
    { id: "e2", title: "Обед", startsAt: todayAt(13), endsAt: todayAt(13, 45), type: "meal", remindBeforeMinutes: 10 },
    { id: "e3", title: "Встреча с Анной", startsAt: todayAt(15), endsAt: todayAt(16), type: "meeting", location: "Переговорная 2", remindBeforeMinutes: 10 },
    { id: "e4", title: "Фокус-время", startsAt: todayAt(17), endsAt: todayAt(18, 30), type: "focus", remindBeforeMinutes: 5 },
    { id: "e5", title: "Ужин", startsAt: todayAt(20), endsAt: todayAt(20, 45), type: "meal", remindBeforeMinutes: 10 },
  ],
  accounts: [],
  messages: [],
};
