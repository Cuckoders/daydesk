import { useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { type Href, useRouter } from 'expo-router';
import { FlatList, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { FloatingAddButton } from '@/components/FloatingAddButton';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { Routine } from '@/src/types';

const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const kindLabels: Record<Routine['kind'], string> = {
  water: 'Вода',
  meal: 'Приём пищи',
  break: 'Перерыв',
  focus: 'Фокус',
  custom: 'Свой ритуал',
};
const kindIcons: Record<Routine['kind'], React.ComponentProps<typeof Ionicons>['name']> = {
  water: 'water-outline',
  meal: 'restaurant-outline',
  break: 'walk-outline',
  focus: 'moon-outline',
  custom: 'sparkles-outline',
};

const describeDays = (days: number[]) => {
  const normalized = [...new Set(days)].sort((left, right) => left - right);
  if (normalized.length === 7) return 'Каждый день';
  if (normalized.join(',') === '1,2,3,4,5') return 'По будням';
  if (normalized.join(',') === '0,6') return 'По выходным';
  return normalized.map((day) => dayNames[day]).filter(Boolean).join(', ');
};

export default function RoutinesScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const routines = useDayDeskStore((state) => state.routines);
  const toggleRoutine = useDayDeskStore((state) => state.toggleRoutine);
  const enableAllRoutines = useDayDeskStore((state) => state.enableAllRoutines);
  const openEditor = useCallback((routineId?: string) => {
    router.push((routineId ? { pathname: '/routine-editor', params: { id: routineId } } : '/routine-editor') as Href);
  }, [router]);

  return (
    <AppScreen>
      <View style={[styles.navigation, { borderBottomColor: colors.border }]}>
        <Pressable accessibilityLabel="Назад" accessibilityRole="button" onPress={() => router.back()} style={styles.navButton}>
          <Ionicons name="chevron-back" size={26} color={colors.text} />
        </Pressable>
        <Text style={[styles.navTitle, { color: colors.text }]}>Ритм дня</Text>
        <Pressable accessibilityLabel="Включить все ритуалы" accessibilityRole="button" onPress={() => void enableAllRoutines()} style={styles.navAction}>
          <Text style={[styles.navActionText, { color: colors.primary }]}>Все</Text>
        </Pressable>
      </View>
      <FlatList
        contentContainerStyle={styles.content}
        data={routines}
        keyExtractor={(item) => item.id}
        ListHeaderComponent={<Text style={[styles.description, { color: colors.textMuted }]}>Настройте воду, питание, перерывы и фокус. Расписание работает локально и синхронизируется с другими устройствами.</Text>}
        ListEmptyComponent={<Text style={[styles.empty, { color: colors.textMuted }]}>Ритуалов пока нет. Добавьте первый пункт ритма дня.</Text>}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        renderItem={({ item }) => (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Pressable
              accessibilityHint="Открывает редактор ритуала"
              accessibilityLabel={`${item.title}, ${item.time}, ${describeDays(item.days)}`}
              accessibilityRole="button"
              onPress={() => openEditor(item.id)}
              style={({ pressed }) => [styles.cardMain, pressed && styles.pressed]}
            >
              <View style={[styles.icon, { backgroundColor: item.enabled ? colors.primarySoft : colors.surfaceRaised }]}>
                <Ionicons name={kindIcons[item.kind]} size={22} color={item.enabled ? colors.primary : colors.textMuted} />
              </View>
              <View style={styles.cardCopy}>
                <View style={styles.titleRow}>
                  <Text numberOfLines={1} style={[styles.title, { color: colors.text }]}>{item.title}</Text>
                  <Text style={[styles.time, { color: colors.primary }]}>{item.time}</Text>
                </View>
                <Text numberOfLines={1} style={[styles.meta, { color: colors.textMuted }]}>{describeDays(item.days)} · {kindLabels[item.kind]}</Text>
                <Text style={[styles.reminder, { color: colors.textMuted }]}>{item.remindBeforeMinutes ? `За ${item.remindBeforeMinutes} мин` : 'В момент события'}</Text>
              </View>
              <Ionicons name="chevron-forward" size={20} color={colors.textMuted} />
            </Pressable>
            <View style={[styles.toggleRow, { borderTopColor: colors.border }]}>
              <Text style={[styles.toggleLabel, { color: colors.textMuted }]}>{item.enabled ? 'Напоминание включено' : 'Напоминание выключено'}</Text>
              <Switch
                accessibilityLabel={`Напоминание «${item.title}»`}
                onValueChange={() => void toggleRoutine(item.id)}
                trackColor={{ false: colors.border, true: colors.primarySoft }}
                thumbColor={item.enabled ? colors.primary : colors.textMuted}
                value={item.enabled}
              />
            </View>
          </View>
        )}
        showsVerticalScrollIndicator={false}
      />
      <FloatingAddButton label="Новый ритуал" onPress={() => openEditor()} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  navigation: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navButton: { width: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  navTitle: { fontSize: 17, fontWeight: '700' },
  navAction: { minWidth: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  navActionText: { fontSize: 15, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 104 },
  description: { marginBottom: 18, fontSize: 14, lineHeight: 21 },
  separator: { height: 10 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, overflow: 'hidden' },
  cardMain: { minHeight: 92, padding: 14, flexDirection: 'row', alignItems: 'center' },
  icon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  cardCopy: { flex: 1, marginLeft: 12, marginRight: 8 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { flex: 1, fontSize: 16, lineHeight: 22, fontWeight: '700' },
  time: { fontSize: 16, fontWeight: '800' },
  meta: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  reminder: { marginTop: 2, fontSize: 12, lineHeight: 17 },
  toggleRow: { minHeight: 54, marginHorizontal: 14, borderTopWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center' },
  toggleLabel: { flex: 1, fontSize: 13 },
  empty: { minHeight: 180, paddingTop: 44, textAlign: 'center', fontSize: 15, lineHeight: 22 },
  pressed: { opacity: 0.7 },
});
