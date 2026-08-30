import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { initialState } from '@/src/data';
import { cancelReminder, cancelReminders, requestReminderPermission, scheduleEventReminder, scheduleRoutineReminders, scheduleTaskReminder } from '@/src/services/notifications';
import type { CalendarEvent, DayDeskState, NewEventInput, NewRoutineInput, NewTaskInput, RemoteSyncChange, Routine, RoutineKind, SyncOperation, SyncStatus, Task } from '@/src/types';
import { nextDueDate, nextDueDateForDays } from '@/src/utils/date';

interface DayDeskActions {
  addTask: (input: NewTaskInput) => Promise<Task>;
  updateTask: (id: string, input: NewTaskInput) => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  addEvent: (input: NewEventInput) => Promise<CalendarEvent>;
  updateEvent: (id: string, input: NewEventInput) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  addRoutine: (input: NewRoutineInput) => Promise<Routine>;
  updateRoutine: (id: string, input: NewRoutineInput) => Promise<void>;
  deleteRoutine: (id: string) => Promise<void>;
  toggleRoutine: (id: string) => Promise<void>;
  enableAllRoutines: () => Promise<void>;
  setMailSnapshot: (accounts: DayDeskState['accounts'], messages: DayDeskState['messages']) => void;
  removeMailAccount: (id: string) => void;
  markMailRead: (accountId: string, id: string) => void;
  setSyncStatus: (status: SyncStatus, error?: string) => void;
  queueEntitiesForSync: (entities: { entity: SyncOperation['entity']; entityId: string }[]) => void;
  applySyncResult: (changes: RemoteSyncChange[], acceptedOperationIds: string[], cursor: number, serverTime: string) => Promise<void>;
  markHydrated: () => void;
}

type DayDeskStore = DayDeskState & DayDeskActions;

const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const recurringTaskId = (seriesId: string, dueAt: string) => `repeat-${seriesId.slice(0, 100)}-${new Date(dueAt).getTime().toString(36)}`;
const routineKinds = new Set<RoutineKind>(['water', 'meal', 'break', 'focus', 'custom']);
const routineReminderOptions = new Set([0, 5, 10, 15, 30]);
const controlCharacters = /[\u0000-\u001f\u007f]/;

const normalizeRoutineInput = (input: NewRoutineInput): NewRoutineInput => {
  const title = input.title.trim();
  if (!title || title.length > 100 || controlCharacters.test(title)) throw new Error('Проверьте название ритуала.');
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(input.time)) throw new Error('Укажите время в формате ЧЧ:ММ.');
  if (!routineKinds.has(input.kind)) throw new Error('Выберите тип ритуала.');
  if (!routineReminderOptions.has(input.remindBeforeMinutes)) throw new Error('Выберите доступное время напоминания.');
  const days = [...new Set(input.days)].sort((left, right) => left - right);
  if (!days.length || days.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) throw new Error('Выберите хотя бы один день недели.');
  return { ...input, title, days };
};

const queueOperation = (entity: SyncOperation['entity'], entityId: string, operation: 'upsert' | 'delete') => ({
  id: id('sync'),
  entity,
  entityId,
  operation,
  createdAt: new Date().toISOString(),
});

const enqueueLatest = (queue: DayDeskState['syncQueue'], operation: ReturnType<typeof queueOperation>) => [
  ...queue.filter((item) => !(item.entity === operation.entity && item.entityId === operation.entityId)),
  operation,
];

export const useDayDeskStore = create<DayDeskStore>()(
  persist(
    (set, get) => ({
      ...initialState,
      addTask: async (input) => {
        const taskId = id('task');
        const task: Task = {
          ...input,
          id: taskId,
          completed: false,
          desktopRecurrence: input.recurrence === 'none' ? undefined : { mode: input.recurrence, days: [], seriesId: taskId },
          updatedAt: new Date().toISOString(),
          syncVersion: 1,
        };
        if (task.reminderEnabled) task.notificationId = await scheduleTaskReminder(task);
        set((state) => ({
          tasks: [task, ...state.tasks],
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('task', task.id, 'upsert')),
        }));
        return task;
      },
      updateTask: async (taskId, input) => {
        const current = get().tasks.find((task) => task.id === taskId);
        if (!current) return;
        await cancelReminder(current.notificationId);
        const updated: Task = {
          ...current,
          ...input,
          desktopRecurrence: input.recurrence === 'none'
            ? input.recurrence === current.recurrence ? current.desktopRecurrence : undefined
            : input.recurrence === current.recurrence && current.desktopRecurrence
              ? current.desktopRecurrence
              : { mode: input.recurrence, days: [], seriesId: current.desktopRecurrence?.seriesId ?? current.id },
          updatedAt: new Date().toISOString(),
          syncVersion: current.syncVersion + 1,
          notificationId: undefined,
        };
        if (!updated.completed && updated.reminderEnabled) updated.notificationId = await scheduleTaskReminder(updated);
        set((state) => ({
          tasks: state.tasks.map((task) => (task.id === taskId ? updated : task)),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('task', taskId, 'upsert')),
        }));
      },
      toggleTask: async (taskId) => {
        const current = get().tasks.find((task) => task.id === taskId);
        if (!current) return;
        await cancelReminder(current.notificationId);
        const completed = !current.completed;
        const updated: Task = {
          ...current,
          completed,
          notificationId: undefined,
          updatedAt: new Date().toISOString(),
          syncVersion: current.syncVersion + 1,
        };
        const additions: Task[] = [];
        const nextRecurringDueAt = current.desktopRecurrence?.mode === 'custom'
          ? nextDueDateForDays(current.dueAt, current.desktopRecurrence.days)
          : current.recurrence !== 'none'
            ? nextDueDate(current.dueAt, current.recurrence)
            : undefined;
        const seriesId = current.desktopRecurrence?.seriesId ?? current.id;
        const nextTaskId = nextRecurringDueAt ? recurringTaskId(seriesId, nextRecurringDueAt) : undefined;
        if (completed && nextRecurringDueAt && nextTaskId && !get().tasks.some((task) => task.id === nextTaskId)) {
          const repeated: Task = {
            ...current,
            id: nextTaskId,
            completed: false,
            dueAt: nextRecurringDueAt,
            desktopRecurrence: current.desktopRecurrence ?? (current.recurrence === 'none' ? undefined : { mode: current.recurrence, days: [], seriesId }),
            notificationId: undefined,
            updatedAt: new Date().toISOString(),
            syncVersion: 1,
          };
          if (repeated.reminderEnabled) repeated.notificationId = await scheduleTaskReminder(repeated);
          additions.push(repeated);
        } else if (!completed && updated.reminderEnabled) {
          updated.notificationId = await scheduleTaskReminder(updated);
        }
        set((state) => ({
          tasks: [...additions, ...state.tasks.map((task) => (task.id === taskId ? updated : task))],
          syncQueue: additions.reduce(
            (queue, task) => enqueueLatest(queue, queueOperation('task', task.id, 'upsert')),
            enqueueLatest(state.syncQueue, queueOperation('task', taskId, 'upsert')),
          ),
        }));
      },
      deleteTask: async (taskId) => {
        const current = get().tasks.find((task) => task.id === taskId);
        await cancelReminder(current?.notificationId);
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== taskId),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('task', taskId, 'delete')),
        }));
      },
      addEvent: async (input) => {
        const event: CalendarEvent = {
          ...input,
          id: id('event'),
          updatedAt: new Date().toISOString(),
          syncVersion: 1,
        };
        if (event.reminderEnabled) event.notificationId = await scheduleEventReminder(event);
        set((state) => ({
          events: [...state.events, event].sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('event', event.id, 'upsert')),
        }));
        return event;
      },
      updateEvent: async (eventId, input) => {
        const current = get().events.find((event) => event.id === eventId);
        if (!current) return;
        await cancelReminder(current.notificationId);
        const updated: CalendarEvent = {
          ...current,
          ...input,
          notificationId: undefined,
          updatedAt: new Date().toISOString(),
          syncVersion: (current.syncVersion ?? 0) + 1,
        };
        if (updated.reminderEnabled) updated.notificationId = await scheduleEventReminder(updated);
        set((state) => ({
          events: state.events.map((event) => event.id === eventId ? updated : event).sort((left, right) => left.startsAt.localeCompare(right.startsAt)),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('event', eventId, 'upsert')),
        }));
      },
      deleteEvent: async (eventId) => {
        const current = get().events.find((event) => event.id === eventId);
        await cancelReminder(current?.notificationId);
        set((state) => ({
          events: state.events.filter((event) => event.id !== eventId),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('event', eventId, 'delete')),
        }));
      },
      addRoutine: async (input) => {
        const normalized = normalizeRoutineInput(input);
        const routine: Routine = {
          ...normalized,
          id: id('routine'),
          updatedAt: new Date().toISOString(),
          syncVersion: 1,
        };
        if (routine.enabled) routine.notificationIds = await scheduleRoutineReminders(routine);
        set((state) => ({
          routines: [...state.routines, routine].sort((left, right) => left.time.localeCompare(right.time)),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('routine', routine.id, 'upsert')),
        }));
        return routine;
      },
      updateRoutine: async (routineId, input) => {
        const normalized = normalizeRoutineInput(input);
        const current = get().routines.find((routine) => routine.id === routineId);
        if (!current) return;
        await cancelReminders([current.notificationId, ...(current.notificationIds ?? [])]);
        const updated: Routine = {
          ...current,
          ...normalized,
          notificationId: undefined,
          notificationIds: undefined,
          updatedAt: new Date().toISOString(),
          syncVersion: (current.syncVersion ?? 0) + 1,
        };
        if (updated.enabled) updated.notificationIds = await scheduleRoutineReminders(updated);
        set((state) => ({
          routines: state.routines.map((routine) => routine.id === routineId ? updated : routine).sort((left, right) => left.time.localeCompare(right.time)),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('routine', routineId, 'upsert')),
        }));
      },
      deleteRoutine: async (routineId) => {
        const current = get().routines.find((routine) => routine.id === routineId);
        await cancelReminders([current?.notificationId, ...(current?.notificationIds ?? [])]);
        set((state) => ({
          routines: state.routines.filter((routine) => routine.id !== routineId),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('routine', routineId, 'delete')),
        }));
      },
      toggleRoutine: async (routineId) => {
        const current = get().routines.find((routine) => routine.id === routineId);
        if (!current) return;
        await cancelReminders([current.notificationId, ...(current.notificationIds ?? [])]);
        const updated: Routine = {
          ...current,
          days: current.days?.length ? current.days : [0, 1, 2, 3, 4, 5, 6],
          remindBeforeMinutes: current.remindBeforeMinutes ?? 0,
          enabled: !current.enabled,
          notificationId: undefined,
          notificationIds: undefined,
          updatedAt: new Date().toISOString(),
          syncVersion: (current.syncVersion ?? 0) + 1,
        };
        if (updated.enabled) updated.notificationIds = await scheduleRoutineReminders(updated);
        set((state) => ({
          routines: state.routines.map((routine) => (routine.id === routineId ? updated : routine)),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation('routine', routineId, 'upsert')),
        }));
      },
      enableAllRoutines: async () => {
        const canSchedule = await requestReminderPermission();
        const routines = await Promise.all(get().routines.map(async (routine) => {
          await cancelReminders([routine.notificationId, ...(routine.notificationIds ?? [])]);
          const enabled: Routine = {
            ...routine,
            days: routine.days?.length ? routine.days : [0, 1, 2, 3, 4, 5, 6],
            remindBeforeMinutes: routine.remindBeforeMinutes ?? 0,
            enabled: true,
            notificationId: undefined,
            notificationIds: undefined,
            updatedAt: new Date().toISOString(),
            syncVersion: (routine.syncVersion ?? 0) + 1,
          };
          if (canSchedule) enabled.notificationIds = await scheduleRoutineReminders(enabled, false);
          return enabled;
        }));
        set((state) => ({
          routines,
          syncQueue: routines.reduce(
            (queue, routine) => enqueueLatest(queue, queueOperation('routine', routine.id, 'upsert')),
            state.syncQueue,
          ),
        }));
      },
      setMailSnapshot: (accounts, messages) => set({ accounts, messages }),
      removeMailAccount: (accountId) => set((state) => ({
        accounts: state.accounts.filter((account) => account.id !== accountId),
        messages: state.messages.filter((message) => message.accountId !== accountId),
      })),
      markMailRead: (accountId, messageId) => set((state) => ({ messages: state.messages.map((message) => message.accountId === accountId && message.id === messageId && message.unread ? { ...message, unread: false } : message) })),
      setSyncStatus: (syncStatus, syncError) => set({ syncStatus, ...(syncError ? { syncError } : { syncError: undefined }) }),
      queueEntitiesForSync: (entities) => set((state) => ({
        syncQueue: entities.reduce(
          (queue, item) => enqueueLatest(queue, queueOperation(item.entity, item.entityId, 'upsert')),
          state.syncQueue,
        ),
      })),
      applySyncResult: async (changes, acceptedOperationIds, syncCursor, serverTime) => {
        const accepted = new Set(acceptedOperationIds);
        const remindersToCancel: string[] = [];
        const tasksToSchedule: Task[] = [];
        const eventsToSchedule: CalendarEvent[] = [];
        const routinesToSchedule: Routine[] = [];
        set((state) => {
          const nextTasks = [...state.tasks];
          const nextEvents = [...state.events];
          const nextRoutines = [...state.routines];
          for (const change of changes) {
            const pending = state.syncQueue.find((operation) => operation.entity === change.entity && operation.entityId === change.entityId && !accepted.has(operation.id));
            if (pending && pending.createdAt.localeCompare(change.updatedAt) > 0) continue;
            if (change.entity === 'task') {
              const index = nextTasks.findIndex((task) => task.id === change.entityId);
              const current = index >= 0 ? nextTasks[index] : undefined;
              if (current && (current.updatedAt ?? '').localeCompare(change.updatedAt) > 0) continue;
              if (current?.notificationId) remindersToCancel.push(current.notificationId);
              if (change.operation === 'delete') { if (index >= 0) nextTasks.splice(index, 1); continue; }
              if (!change.payload) continue;
              const incoming: Task = { ...change.payload, notificationId: undefined };
              if (!incoming.completed && incoming.reminderEnabled) tasksToSchedule.push(incoming);
              if (index >= 0) nextTasks[index] = incoming; else nextTasks.push(incoming);
            } else if (change.entity === 'event') {
              const index = nextEvents.findIndex((event) => event.id === change.entityId);
              const current = index >= 0 ? nextEvents[index] : undefined;
              if (current && (current.updatedAt ?? '').localeCompare(change.updatedAt) > 0) continue;
              if (current?.notificationId) remindersToCancel.push(current.notificationId);
              if (change.operation === 'delete') { if (index >= 0) nextEvents.splice(index, 1); continue; }
              if (!change.payload) continue;
              const incoming: CalendarEvent = { ...change.payload, notificationId: undefined };
              if (incoming.reminderEnabled) eventsToSchedule.push(incoming);
              if (index >= 0) nextEvents[index] = incoming; else nextEvents.push(incoming);
            } else {
              const index = nextRoutines.findIndex((routine) => routine.id === change.entityId);
              const current = index >= 0 ? nextRoutines[index] : undefined;
              if (current && (current.updatedAt ?? '').localeCompare(change.updatedAt) > 0) continue;
              if (current) remindersToCancel.push(current.notificationId ?? '', ...(current.notificationIds ?? []));
              if (change.operation === 'delete') { if (index >= 0) nextRoutines.splice(index, 1); continue; }
              if (!change.payload) continue;
              const incoming: Routine = { ...change.payload, notificationId: undefined, notificationIds: undefined };
              if (incoming.enabled) routinesToSchedule.push(incoming);
              if (index >= 0) nextRoutines[index] = incoming; else nextRoutines.push(incoming);
            }
          }
          return {
            tasks: nextTasks,
            events: nextEvents,
            routines: nextRoutines,
            syncQueue: state.syncQueue.filter((operation) => !accepted.has(operation.id)),
            syncCursor,
            syncStatus: 'idle',
            syncError: undefined,
            lastSyncedAt: serverTime,
          };
        });
        await cancelReminders(remindersToCancel);
        for (const task of tasksToSchedule) {
          const notificationId = await scheduleTaskReminder(task, false);
          if (notificationId && !get().tasks.some((current) => current.id === task.id && current.updatedAt === task.updatedAt)) {
            await cancelReminder(notificationId);
            continue;
          }
          set((state) => ({ tasks: state.tasks.map((current) => current.id === task.id && current.updatedAt === task.updatedAt ? { ...current, notificationId } : current) }));
        }
        for (const event of eventsToSchedule) {
          const notificationId = await scheduleEventReminder(event, false);
          if (notificationId && !get().events.some((current) => current.id === event.id && current.updatedAt === event.updatedAt)) {
            await cancelReminder(notificationId);
            continue;
          }
          set((state) => ({ events: state.events.map((current) => current.id === event.id && current.updatedAt === event.updatedAt ? { ...current, notificationId } : current) }));
        }
        for (const routine of routinesToSchedule) {
          const notificationIds = await scheduleRoutineReminders(routine, false);
          if (notificationIds && !get().routines.some((current) => current.id === routine.id && current.updatedAt === routine.updatedAt)) {
            await cancelReminders(notificationIds);
            continue;
          }
          set((state) => ({ routines: state.routines.map((current) => current.id === routine.id && current.updatedAt === routine.updatedAt ? { ...current, notificationIds } : current) }));
        }
      },
      markHydrated: () => set({ hydrated: true }),
    }),
    {
      name: 'daydesk-mobile-v1',
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ tasks, events, routines, syncQueue, syncCursor, lastSyncedAt }) => ({
        tasks,
        events,
        routines,
        syncQueue,
        syncCursor,
        lastSyncedAt,
      }),
      migrate: (persistedState) => {
        const state = persistedState as Partial<DayDeskState>;
        return { ...state, accounts: [], messages: [] } as unknown as DayDeskStore;
      },
      onRehydrateStorage: () => (state) => state?.markHydrated(),
    },
  ),
);
