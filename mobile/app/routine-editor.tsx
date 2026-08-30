import { useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { Routine, RoutineKind } from '@/src/types';

const kinds: { value: RoutineKind; label: string; icon: React.ComponentProps<typeof Ionicons>['name'] }[] = [
  { value: 'water', label: 'Вода', icon: 'water-outline' },
  { value: 'meal', label: 'Еда', icon: 'restaurant-outline' },
  { value: 'break', label: 'Перерыв', icon: 'walk-outline' },
  { value: 'focus', label: 'Фокус', icon: 'moon-outline' },
  { value: 'custom', label: 'Другое', icon: 'sparkles-outline' },
];
const days = [
  { value: 1, label: 'Пн' }, { value: 2, label: 'Вт' }, { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' }, { value: 5, label: 'Пт' }, { value: 6, label: 'Сб' }, { value: 0, label: 'Вс' },
];
const reminderOptions = [0, 5, 10, 15, 30] as const;
const validKinds = new Set<RoutineKind>(kinds.map((item) => item.value));
const controlCharacters = /[\u0000-\u001f\u007f]/;

function RoutineEditorForm({ routine }: { routine?: Routine }) {
  const colors = useAppColors();
  const router = useRouter();
  const addRoutine = useDayDeskStore((state) => state.addRoutine);
  const updateRoutine = useDayDeskStore((state) => state.updateRoutine);
  const deleteRoutine = useDayDeskStore((state) => state.deleteRoutine);
  const [title, setTitle] = useState(routine?.title ?? '');
  const [time, setTime] = useState(routine?.time ?? '09:00');
  const [selectedDays, setSelectedDays] = useState(routine?.days ?? [1, 2, 3, 4, 5]);
  const [kind, setKind] = useState<RoutineKind>(routine?.kind ?? 'custom');
  const [remindBeforeMinutes, setRemindBeforeMinutes] = useState(routine?.remindBeforeMinutes ?? 0);
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const toggleDay = (day: number) => setSelectedDays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day]);

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed || trimmed.length > 100 || controlCharacters.test(trimmed)) {
      Alert.alert('Проверьте название', 'Введите название длиной до 100 символов.'); return;
    }
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      Alert.alert('Проверьте время', 'Используйте 24-часовой формат ЧЧ:ММ, например 13:30.'); return;
    }
    const normalizedDays = [...new Set(selectedDays)].sort((left, right) => left - right);
    if (!normalizedDays.length || normalizedDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      Alert.alert('Выберите дни', 'Отметьте хотя бы один день недели.'); return;
    }
    if (!validKinds.has(kind) || !reminderOptions.includes(remindBeforeMinutes as typeof reminderOptions[number])) {
      Alert.alert('Проверьте расписание', 'Выберите тип и время напоминания из списка.'); return;
    }
    setSaving(true);
    try {
      const input = { title: trimmed, time, days: normalizedDays, kind, remindBeforeMinutes, enabled };
      if (routine) await updateRoutine(routine.id, input); else await addRoutine(input);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      router.back();
    } catch (error) {
      Alert.alert('Не удалось сохранить', error instanceof Error ? error.message : 'Проверьте данные и попробуйте ещё раз.');
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = () => {
    if (!routine) return;
    Alert.alert('Удалить ритуал?', 'Он исчезнет со всех подключённых устройств.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => void deleteRoutine(routine.id).then(() => router.back()).catch(() => Alert.alert('Не удалось удалить', 'Попробуйте ещё раз.')) },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <View style={[styles.navigation, { borderBottomColor: colors.border }]}>
          <Pressable accessibilityLabel="Закрыть" accessibilityRole="button" onPress={() => router.back()} style={styles.navButton}><Ionicons name="close" size={25} color={colors.text} /></Pressable>
          <Text style={[styles.navTitle, { color: colors.text }]}>{routine ? 'Изменить ритуал' : 'Новый ритуал'}</Text>
          <Pressable accessibilityLabel="Сохранить ритуал" accessibilityRole="button" disabled={saving} onPress={() => void save()} style={styles.navButton}><Text style={[styles.done, { color: colors.primary }, saving && styles.disabled]}>Готово</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={[styles.label, { color: colors.text }]}>Название</Text>
          <TextInput accessibilityLabel="Название ритуала" autoFocus={!routine} maxLength={100} onChangeText={setTitle} placeholder="Например, выпить воды" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={title} />

          <Text style={[styles.label, { color: colors.text }]}>Время</Text>
          <TextInput accessibilityLabel="Время ритуала" autoCapitalize="none" keyboardType="numbers-and-punctuation" maxLength={5} onChangeText={setTime} placeholder="09:00" placeholderTextColor={colors.textMuted} style={[styles.input, styles.timeInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={time} />

          <Text style={[styles.label, { color: colors.text }]}>Дни недели</Text>
          <View style={styles.daysRow}>{days.map((item) => {
            const selected = selectedDays.includes(item.value);
            return <Pressable key={item.value} accessibilityLabel={item.label} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => toggleDay(item.value)} style={[styles.day, { backgroundColor: selected ? colors.primary : colors.surface, borderColor: selected ? colors.primary : colors.border }]}><Text style={[styles.dayText, { color: selected ? colors.onPrimary : colors.text }]}>{item.label}</Text></Pressable>;
          })}</View>

          <Text style={[styles.label, { color: colors.text }]}>Тип</Text>
          <View style={styles.wrapRow}>{kinds.map((item) => {
            const selected = kind === item.value;
            return <Pressable key={item.value} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => setKind(item.value)} style={[styles.choice, { backgroundColor: selected ? colors.primarySoft : colors.surface, borderColor: selected ? colors.primary : colors.border }]}><Ionicons name={item.icon} size={18} color={selected ? colors.primary : colors.textMuted} /><Text style={[styles.choiceText, { color: selected ? colors.primary : colors.text }]}>{item.label}</Text></Pressable>;
          })}</View>

          <Text style={[styles.label, { color: colors.text }]}>Напомнить</Text>
          <View style={styles.wrapRow}>{reminderOptions.map((minutes) => {
            const selected = remindBeforeMinutes === minutes;
            return <Pressable key={minutes} accessibilityRole="radio" accessibilityState={{ checked: selected }} onPress={() => setRemindBeforeMinutes(minutes)} style={[styles.choice, { backgroundColor: selected ? colors.primarySoft : colors.surface, borderColor: selected ? colors.primary : colors.border }]}><Text style={[styles.choiceText, { color: selected ? colors.primary : colors.text }]}>{minutes === 0 ? 'В момент' : `За ${minutes} мин`}</Text></Pressable>;
          })}</View>

          <View style={[styles.setting, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: colors.text }]}>Напоминание активно</Text><Text style={[styles.settingSubtitle, { color: colors.textMuted }]}>Разрешение запрашивается только после сохранения</Text></View>
            <Switch accessibilityLabel="Включить напоминание" onValueChange={setEnabled} trackColor={{ false: colors.border, true: colors.primarySoft }} thumbColor={enabled ? colors.primary : colors.textMuted} value={enabled} />
          </View>

          <Pressable accessibilityRole="button" disabled={saving} onPress={() => void save()} style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary }, pressed && styles.pressed, saving && styles.disabled]}><Text style={[styles.saveText, { color: colors.onPrimary }]}>{saving ? 'Сохраняем…' : routine ? 'Сохранить изменения' : 'Добавить ритуал'}</Text></Pressable>
          {routine ? <Pressable accessibilityRole="button" disabled={saving} onPress={confirmDelete} style={styles.deleteButton}><Ionicons name="trash-outline" size={19} color={colors.danger} /><Text style={[styles.deleteText, { color: colors.danger }]}>Удалить ритуал</Text></Pressable> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export default function RoutineEditorScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const hydrated = useDayDeskStore((state) => state.hydrated);
  const routine = useDayDeskStore((state) => state.routines.find((item) => item.id === params.id));
  if (!hydrated) return <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]} />;
  if (params.id && !routine) return (
    <SafeAreaView style={[styles.safeArea, styles.missing, { backgroundColor: colors.background }]}>
      <Ionicons name="alert-circle-outline" size={36} color={colors.textMuted} />
      <Text style={[styles.missingTitle, { color: colors.text }]}>Ритуал не найден</Text>
      <Pressable accessibilityRole="button" onPress={() => router.back()} style={[styles.missingButton, { backgroundColor: colors.primary }]}><Text style={[styles.saveText, { color: colors.onPrimary }]}>Вернуться</Text></Pressable>
    </SafeAreaView>
  );
  return <RoutineEditorForm key={routine?.id ?? 'new'} routine={routine} />;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 }, flex: { flex: 1 },
  navigation: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navButton: { minWidth: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' }, navTitle: { fontSize: 17, fontWeight: '700' }, done: { fontSize: 15, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 38 }, label: { marginTop: 18, marginBottom: 9, fontSize: 16, fontWeight: '700' },
  input: { minHeight: 52, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, fontSize: 16 }, timeInput: { width: 126, fontVariant: ['tabular-nums'] },
  daysRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 5 }, day: { flex: 1, minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, dayText: { fontSize: 13, fontWeight: '700' },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, choice: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }, choiceText: { fontSize: 14, fontWeight: '600' },
  setting: { minHeight: 76, marginTop: 24, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center' }, settingCopy: { flex: 1, paddingRight: 8 }, settingTitle: { fontSize: 16, fontWeight: '700' }, settingSubtitle: { marginTop: 3, fontSize: 12, lineHeight: 17 },
  saveButton: { minHeight: 54, marginTop: 28, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }, saveText: { fontSize: 16, fontWeight: '700' }, deleteButton: { minHeight: 52, marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, deleteText: { fontSize: 15, fontWeight: '600' },
  missing: { alignItems: 'center', justifyContent: 'center', padding: 24 }, missingTitle: { marginTop: 12, fontSize: 20, fontWeight: '700' }, missingButton: { minWidth: 150, minHeight: 50, marginTop: 22, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.72 }, disabled: { opacity: 0.5 },
});
