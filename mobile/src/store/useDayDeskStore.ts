import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { initialState } from '@/src/data';
import { cancelReminder, scheduleRoutineReminder, scheduleTaskReminder } from '@/src/services/notifications';
import type { DayDeskState, NewTaskInput, RemoteSyncChange, Routine, SyncStatus, Task } from '@/src/types';
import { nextDueDate, nextDueDateForDays } from '@/src/utils/date';

interface DayDeskActions {
  addTask: (input: NewTaskInput) => Promise<Task>;
  updateTask: (id: string, input: NewTaskInput) => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  toggleRoutine: (id: string) => Promise<void>;
  enableAllRoutines: () => Promise<void>;
  setSyncStatus: (status: SyncStatus, error?: string) => void;
  queueTasksForSync: (taskIds: string[]) => void;
  applySyncResult: (changes: RemoteSyncChange[], acceptedOperationIds: string[], cursor: number, serverTime: string) => Promise<void>;
  markHydrated: () => void;
}

type DayDeskStore = DayDeskState & DayDeskActions;

const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const recurringTaskId = (seriesId: string, dueAt: string) => `repeat-${seriesId.slice(0, 100)}-${new Date(dueAt).getTime().toString(36)}`;

const queueOperation = (entityId: string, operation: 'upsert' | 'delete') => ({
  id: id('sync'),
  entity: 'task' as const,
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
          syncQueue: enqueueLatest(state.syncQueue, queueOperation(task.id, 'upsert')),
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
          syncQueue: enqueueLatest(state.syncQueue, queueOperation(taskId, 'upsert')),
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
            (queue, task) => enqueueLatest(queue, queueOperation(task.id, 'upsert')),
            enqueueLatest(state.syncQueue, queueOperation(taskId, 'upsert')),
          ),
        }));
      },
      deleteTask: async (taskId) => {
        const current = get().tasks.find((task) => task.id === taskId);
        await cancelReminder(current?.notificationId);
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== taskId),
          syncQueue: enqueueLatest(state.syncQueue, queueOperation(taskId, 'delete')),
        }));
      },
      toggleRoutine: async (routineId) => {
        const current = get().routines.find((routine) => routine.id === routineId);
        if (!current) return;
        await cancelReminder(current.notificationId);
        const updated: Routine = { ...current, enabled: !current.enabled, notificationId: undefined };
        if (updated.enabled) updated.notificationId = await scheduleRoutineReminder(updated);
        set((state) => ({ routines: state.routines.map((routine) => (routine.id === routineId ? updated : routine)) }));
      },
      enableAllRoutines: async () => {
        const routines = await Promise.all(get().routines.map(async (routine) => {
          await cancelReminder(routine.notificationId);
          const enabled: Routine = { ...routine, enabled: true, notificationId: undefined };
          enabled.notificationId = await scheduleRoutineReminder(enabled);
          return enabled;
        }));
        set({ routines });
      },
      setSyncStatus: (syncStatus, syncError) => set({ syncStatus, ...(syncError ? { syncError } : { syncError: undefined }) }),
      queueTasksForSync: (taskIds) => set((state) => {
        const selected = new Set(taskIds);
        return {
          syncQueue: state.tasks.filter((task) => selected.has(task.id)).reduce(
            (queue, task) => enqueueLatest(queue, queueOperation(task.id, 'upsert')),
            state.syncQueue,
          ),
        };
      }),
      applySyncResult: async (changes, acceptedOperationIds, syncCursor, serverTime) => {
        const accepted = new Set(acceptedOperationIds);
        const remindersToCancel: string[] = [];
        const remindersToSchedule: Task[] = [];
        set((state) => {
          const nextTasks = [...state.tasks];
          for (const change of changes) {
            const pending = state.syncQueue.find((operation) => operation.entityId === change.entityId && !accepted.has(operation.id));
            if (pending && pending.createdAt.localeCompare(change.updatedAt) > 0) continue;
            const index = nextTasks.findIndex((task) => task.id === change.entityId);
            const current = index >= 0 ? nextTasks[index] : undefined;
            if (current && current.updatedAt.localeCompare(change.updatedAt) > 0) continue;
            if (current?.notificationId) remindersToCancel.push(current.notificationId);
            if (change.operation === 'delete') {
              if (index >= 0) nextTasks.splice(index, 1);
              continue;
            }
            if (!change.payload) continue;
            const incoming: Task = { ...change.payload, notificationId: undefined };
            if (!incoming.completed && incoming.reminderEnabled) remindersToSchedule.push(incoming);
            if (index >= 0) nextTasks[index] = incoming;
            else nextTasks.push(incoming);
          }
          return {
            tasks: nextTasks,
            syncQueue: state.syncQueue.filter((operation) => !accepted.has(operation.id)),
            syncCursor,
            syncStatus: 'idle',
            syncError: undefined,
            lastSyncedAt: serverTime,
          };
        });
        await Promise.all(remindersToCancel.map((identifier) => cancelReminder(identifier)));
        for (const task of remindersToSchedule) {
          const notificationId = await scheduleTaskReminder(task);
          set((state) => ({
            tasks: state.tasks.map((current) => current.id === task.id && current.updatedAt === task.updatedAt
              ? { ...current, notificationId }
              : current),
          }));
        }
      },
      markHydrated: () => set({ hydrated: true }),
    }),
    {
      name: 'daydesk-mobile-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ tasks, events, routines, accounts, messages, syncQueue, syncCursor, lastSyncedAt }) => ({
        tasks,
        events,
        routines,
        accounts,
        messages,
        syncQueue,
        syncCursor,
        lastSyncedAt,
      }),
      onRehydrateStorage: () => (state) => state?.markHydrated(),
    },
  ),
);
