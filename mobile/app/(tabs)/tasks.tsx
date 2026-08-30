import { useCallback, useMemo, useState } from 'react';
import { useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { FloatingAddButton } from '@/components/FloatingAddButton';
import { TaskCard } from '@/components/TaskCard';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { Task } from '@/src/types';

type Filter = 'open' | 'all' | 'done';

const filters: { key: Filter; label: string }[] = [
  { key: 'open', label: 'Активные' },
  { key: 'all', label: 'Все' },
  { key: 'done', label: 'Готовые' },
];

export default function TasksScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>('open');
  const tasks = useDayDeskStore((state) => state.tasks);
  const toggleTask = useDayDeskStore((state) => state.toggleTask);
  const visible = useMemo(() => tasks
    .filter((task) => filter === 'all' || (filter === 'done' ? task.completed : !task.completed))
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt)), [filter, tasks]);
  const openEditor = useCallback((taskId?: string) => {
    router.push(taskId ? { pathname: '/task-editor', params: { id: taskId } } : '/task-editor');
  }, [router]);
  const onToggle = useCallback((taskId: string) => void toggleTask(taskId), [toggleTask]);
  const renderItem = useCallback(
    ({ item }: { item: Task }) => <TaskCard task={item} onToggle={onToggle} onEdit={openEditor} />,
    [onToggle, openEditor],
  );

  return (
    <AppScreen>
      <FlatList
        data={visible}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={(
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>Задачи</Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>{tasks.filter((task) => !task.completed).length} активных</Text>
            <View accessibilityRole="tablist" style={styles.filters}>
              {filters.map((item) => {
                const active = item.key === filter;
                return (
                  <Pressable
                    key={item.key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    android_ripple={{ color: colors.primarySoft }}
                    onPress={() => setFilter(item.key)}
                    style={[styles.filter, { backgroundColor: active ? colors.primary : colors.surface, borderColor: colors.border }]}
                  >
                    <Text style={[styles.filterText, { color: active ? colors.onPrimary : colors.text }]}>{item.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        )}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors.textMuted }]}>В этом разделе пока нет задач.</Text>}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.content}
        initialNumToRender={10}
        windowSize={5}
        showsVerticalScrollIndicator={false}
      />
      <FloatingAddButton onPress={() => openEditor()} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 96 },
  header: { paddingTop: 14, paddingBottom: 16 },
  title: { fontSize: 32, lineHeight: 39, fontWeight: '800' },
  subtitle: { marginTop: 3, fontSize: 15, lineHeight: 21 },
  filters: { flexDirection: 'row', gap: 8, marginTop: 18 },
  filter: { minHeight: 44, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 15, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  filterText: { fontSize: 14, fontWeight: '700' },
  separator: { minHeight: 10 },
  empty: { paddingVertical: 48, textAlign: 'center', fontSize: 16, lineHeight: 24 },
});
