import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { initialState } from '@/src/data';
import { cancelReminder, scheduleRoutineReminder, scheduleTaskReminder } from '@/src/services/notifications';
import type { DayDeskState, NewTaskInput, Routine, Task } from '@/src/types';
import { nextDueDate } from '@/src/utils/date';

interface DayDeskActions {
  addTask: (input: NewTaskInput) => Promise<Task>;
  updateTask: (id: string, input: NewTaskInput) => Promise<void>;
  toggleTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  toggleRoutine: (id: string) => Promise<void>;
  enableAllRoutines: () => Promise<void>;
  markHydrated: () => void;
}

type DayDeskStore = DayDeskState & DayDeskActions;

const id = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const queueOperation = (entityId: string, operation: 'upsert' | 'delete') => ({
  id: id('sync'),
  entity: 'task' as const,
  entityId,
  operation,
  createdAt: new Date().toISOString(),
});

export const useDayDeskStore = create<DayDeskStore>()(
  persist(
    (set, get) => ({
      ...initialState,
      addTask: async (input) => {
        const task: Task = {
          ...input,
          id: id('task'),
          completed: false,
          updatedAt: new Date().toISOString(),
          syncVersion: 1,
        };
        if (task.reminderEnabled) task.notificationId = await scheduleTaskReminder(task);
        set((state) => ({
          tasks: [task, ...state.tasks],
          syncQueue: [...state.syncQueue, queueOperation(task.id, 'upsert')],
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
          updatedAt: new Date().toISOString(),
          syncVersion: current.syncVersion + 1,
          notificationId: undefined,
        };
        if (!updated.completed && updated.reminderEnabled) updated.notificationId = await scheduleTaskReminder(updated);
        set((state) => ({
          tasks: state.tasks.map((task) => (task.id === taskId ? updated : task)),
          syncQueue: [...state.syncQueue, queueOperation(taskId, 'upsert')],
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
        if (completed && current.recurrence !== 'none') {
          const repeated: Task = {
            ...current,
            id: id('task'),
            completed: false,
            dueAt: nextDueDate(current.dueAt, current.recurrence),
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
          syncQueue: [
            ...state.syncQueue,
            queueOperation(taskId, 'upsert'),
            ...additions.map((task) => queueOperation(task.id, 'upsert')),
          ],
        }));
      },
      deleteTask: async (taskId) => {
        const current = get().tasks.find((task) => task.id === taskId);
        await cancelReminder(current?.notificationId);
        set((state) => ({
          tasks: state.tasks.filter((task) => task.id !== taskId),
          syncQueue: [...state.syncQueue, queueOperation(taskId, 'delete')],
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
      markHydrated: () => set({ hydrated: true }),
    }),
    {
      name: 'daydesk-mobile-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ tasks, events, routines, accounts, messages, syncQueue }) => ({ tasks, events, routines, accounts, messages, syncQueue }),
      onRehydrateStorage: () => (state) => state?.markHydrated(),
    },
  ),
);
