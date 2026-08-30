import { memo, useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { categoryColors, priorityColors, useAppColors } from '@/src/theme';
import type { Task } from '@/src/types';
import { formatTime, timeUntil } from '@/src/utils/date';

interface Props {
  task: Task;
  onToggle: (id: string) => void;
  onEdit: (id: string) => void;
  compact?: boolean;
}

export const TaskCard = memo(function TaskCard({ task, onToggle, onEdit, compact = false }: Props) {
  const colors = useAppColors();
  const toggle = useCallback(() => {
    void Haptics.notificationAsync(task.completed ? Haptics.NotificationFeedbackType.Warning : Haptics.NotificationFeedbackType.Success);
    onToggle(task.id);
  }, [onToggle, task.completed, task.id]);

  return (
    <View style={[styles.card, compact && styles.compactCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.priority, { backgroundColor: priorityColors[task.priority] }]} />
      <Pressable
        accessibilityLabel={task.completed ? `Вернуть задачу ${task.title}` : `Завершить задачу ${task.title}`}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: task.completed }}
        android_ripple={{ color: colors.primarySoft, borderless: true, radius: 24 }}
        hitSlop={4}
        onPress={toggle}
        style={({ pressed }) => [styles.checkButton, pressed && Platform.OS === 'ios' && styles.pressed]}
      >
        <View style={[styles.checkbox, { borderColor: task.completed ? colors.primary : colors.textMuted, backgroundColor: task.completed ? colors.primary : 'transparent' }]}>
          {task.completed ? <Ionicons name="checkmark" size={18} color={colors.onPrimary} /> : null}
        </View>
      </Pressable>

      <Pressable
        accessibilityLabel={`Открыть задачу ${task.title}`}
        accessibilityRole="button"
        android_ripple={{ color: colors.primarySoft }}
        onPress={() => onEdit(task.id)}
        style={({ pressed }) => [styles.body, pressed && Platform.OS === 'ios' && styles.pressed]}
      >
        <View style={styles.titleRow}>
          <Text numberOfLines={2} style={[styles.title, { color: colors.text }, task.completed && styles.completed]}>
            {task.title}
          </Text>
          <View style={[styles.categoryDot, { backgroundColor: categoryColors[task.category] ?? colors.info }]} />
        </View>
        <View style={styles.metaRow}>
          <Ionicons name="time-outline" size={15} color={colors.textMuted} />
          <Text style={[styles.meta, { color: colors.textMuted }]}>{formatTime(task.dueAt)}</Text>
          <Text style={[styles.dot, { color: colors.textMuted }]}>•</Text>
          <Text numberOfLines={1} style={[styles.meta, styles.grow, { color: colors.textMuted }]}>
            {task.completed ? 'готово' : timeUntil(task.dueAt)}
          </Text>
          {task.reminderEnabled ? <Ionicons accessibilityLabel="Напоминание включено" name="notifications-outline" size={16} color={colors.primary} /> : null}
        </View>
      </Pressable>
      <Pressable
        accessibilityLabel={`Изменить задачу ${task.title}`}
        accessibilityRole="button"
        hitSlop={4}
        onPress={() => onEdit(task.id)}
        style={({ pressed }) => [styles.editButton, pressed && styles.pressed]}
      >
        <Ionicons name="chevron-forward" size={21} color={colors.textMuted} />
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    minHeight: 82,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 18,
    flexDirection: 'row',
    overflow: 'hidden',
  },
  compactCard: { minHeight: 76 },
  priority: { width: 4 },
  checkButton: { width: 56, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  checkbox: { minWidth: 26, minHeight: 26, borderRadius: 9, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  body: { flex: 1, paddingVertical: 14, justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flexShrink: 1, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  completed: { opacity: 0.55, textDecorationLine: 'line-through' },
  categoryDot: { width: 7, height: 7, borderRadius: 4 },
  metaRow: { marginTop: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
  meta: { fontSize: 13, lineHeight: 18 },
  dot: { fontSize: 12 },
  grow: { flex: 1 },
  editButton: { width: 46, minHeight: 56, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
