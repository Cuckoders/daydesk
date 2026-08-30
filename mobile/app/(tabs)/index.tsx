import { useCallback, useMemo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { EventCard } from '@/components/EventCard';
import { FloatingAddButton } from '@/components/FloatingAddButton';
import { SectionHeader } from '@/components/SectionHeader';
import { TaskCard } from '@/components/TaskCard';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { Routine, Task } from '@/src/types';
import { formatLongDate, isSameDay } from '@/src/utils/date';

const routineIcons: Record<Routine['kind'], React.ComponentProps<typeof Ionicons>['name']> = {
  water: 'water-outline',
  meal: 'restaurant-outline',
  break: 'walk-outline',
  focus: 'moon-outline',
};

export default function TodayScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const tasks = useDayDeskStore((state) => state.tasks);
  const events = useDayDeskStore((state) => state.events);
  const routines = useDayDeskStore((state) => state.routines);
  const syncQueueLength = useDayDeskStore((state) => state.syncQueue.length);
  const toggleTask = useDayDeskStore((state) => state.toggleTask);
  const toggleRoutine = useDayDeskStore((state) => state.toggleRoutine);
  const enableAllRoutines = useDayDeskStore((state) => state.enableAllRoutines);

  const todayTasks = useMemo(
    () => tasks.filter((task) => isSameDay(task.dueAt, new Date())).sort((a, b) => a.dueAt.localeCompare(b.dueAt)),
    [tasks],
  );
  const todayEvents = useMemo(
    () => events.filter((event) => isSameDay(event.startsAt, new Date())).sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [events],
  );
  const completed = todayTasks.filter((task) => task.completed).length;
  const openEditor = useCallback((taskId?: string) => {
    router.push(taskId ? { pathname: '/task-editor', params: { id: taskId } } : '/task-editor');
  }, [router]);
  const onToggle = useCallback((taskId: string) => void toggleTask(taskId), [toggleTask]);
  const renderTask = useCallback(
    ({ item }: { item: Task }) => <TaskCard task={item} onToggle={onToggle} onEdit={openEditor} compact />,
    [onToggle, openEditor],
  );

  const header = (
    <View>
      <View style={styles.header}>
        <View style={styles.headerCopy}>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>DAYDESK</Text>
          <Text style={[styles.title, { color: colors.text }]}>Добрый день</Text>
          <Text style={[styles.date, { color: colors.textMuted }]}>{formatLongDate(new Date())}</Text>
        </View>
        <View accessibilityLabel={`${syncQueueLength} изменений ожидают синхронизации`} style={[styles.syncBadge, { backgroundColor: colors.primarySoft }]}>
          <Ionicons name="cloud-offline-outline" size={19} color={colors.primary} />
          <Text style={[styles.syncText, { color: colors.primary }]}>{syncQueueLength}</Text>
        </View>
      </View>

      <View style={styles.statsRow}>
        <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.statValue, { color: colors.text }]}>{todayTasks.length - completed}</Text>
          <Text style={[styles.statLabel, { color: colors.textMuted }]}>осталось задач</Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.statValue, { color: colors.text }]}>{todayEvents.length}</Text>
          <Text style={[styles.statLabel, { color: colors.textMuted }]}>события сегодня</Text>
        </View>
        <View style={[styles.statCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.statValue, { color: colors.text }]}>{completed}/{todayTasks.length}</Text>
          <Text style={[styles.statLabel, { color: colors.textMuted }]}>выполнено</Text>
        </View>
      </View>

      <SectionHeader title="Ритм дня" actionLabel="Напоминать" onAction={() => void enableAllRoutines()} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.routines}>
        {routines.map((routine) => (
          <Pressable
            key={routine.id}
            accessibilityLabel={`${routine.title}, ${routine.time}`}
            accessibilityRole="switch"
            accessibilityState={{ checked: routine.enabled }}
            android_ripple={{ color: colors.primarySoft }}
            onPress={() => void toggleRoutine(routine.id)}
            style={({ pressed }) => [
              styles.routineCard,
              { backgroundColor: routine.enabled ? colors.primarySoft : colors.surface, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <View style={[styles.routineIcon, { backgroundColor: colors.surface }]}>
              <Ionicons name={routineIcons[routine.kind]} size={20} color={routine.enabled ? colors.primary : colors.textMuted} />
            </View>
            <Text style={[styles.routineTime, { color: colors.text }]}>{routine.time}</Text>
            <Text numberOfLines={2} style={[styles.routineTitle, { color: colors.textMuted }]}>{routine.title}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <SectionHeader title="Ближайшие события" actionLabel="Календарь" onAction={() => router.push('/calendar')} />
      <View style={styles.eventList}>
        {todayEvents.length ? todayEvents.slice(0, 3).map((event) => <EventCard key={event.id} event={event} />) : (
          <Text style={[styles.emptyText, { color: colors.textMuted }]}>На сегодня встреч больше нет.</Text>
        )}
      </View>

      <SectionHeader title="Задачи на сегодня" actionLabel="Все задачи" onAction={() => router.push('/tasks')} />
    </View>
  );

  return (
    <AppScreen>
      <FlatList
        data={todayTasks}
        renderItem={renderTask}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={header}
        ListEmptyComponent={<Text style={[styles.emptyText, { color: colors.textMuted }]}>Свободный день. Добавьте первую задачу.</Text>}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        initialNumToRender={8}
        windowSize={5}
      />
      <FloatingAddButton onPress={() => openEditor()} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 96 },
  header: { paddingTop: 12, paddingBottom: 18, flexDirection: 'row', alignItems: 'center' },
  headerCopy: { flex: 1 },
  eyebrow: { fontSize: 12, letterSpacing: 1.4, fontWeight: '800' },
  title: { marginTop: 3, fontSize: 30, lineHeight: 37, fontWeight: '800' },
  date: { marginTop: 3, fontSize: 15, lineHeight: 22, textTransform: 'capitalize' },
  syncBadge: { minWidth: 52, height: 48, borderRadius: 16, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5 },
  syncText: { fontSize: 13, fontWeight: '700' },
  statsRow: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  statCard: { flex: 1, minHeight: 86, padding: 12, borderRadius: 17, borderWidth: StyleSheet.hairlineWidth },
  statValue: { fontSize: 24, lineHeight: 30, fontWeight: '800' },
  statLabel: { marginTop: 4, fontSize: 12, lineHeight: 16 },
  routines: { gap: 10, paddingBottom: 12 },
  routineCard: { flexBasis: 124, minHeight: 124, padding: 12, borderRadius: 19, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  routineIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  routineTime: { marginTop: 10, fontSize: 16, fontWeight: '800' },
  routineTitle: { marginTop: 3, fontSize: 13, lineHeight: 17 },
  eventList: { gap: 9, paddingBottom: 7 },
  separator: { height: 9 },
  emptyText: { minHeight: 64, paddingVertical: 18, fontSize: 15, lineHeight: 22 },
  pressed: { opacity: 0.72 },
});
