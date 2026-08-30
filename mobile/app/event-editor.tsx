import { useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { CalendarEventType } from '@/src/types';

const eventTypes: { value: CalendarEventType; label: string }[] = [
  { value: 'meeting', label: 'Встреча' },
  { value: 'focus', label: 'Фокус' },
  { value: 'meal', label: 'Приём пищи' },
  { value: 'personal', label: 'Личное' },
];

const dateInput = (value: Date) => `${value.getFullYear()}-${`${value.getMonth() + 1}`.padStart(2, '0')}-${`${value.getDate()}`.padStart(2, '0')}`;
const timeInput = (value: Date) => `${`${value.getHours()}`.padStart(2, '0')}:${`${value.getMinutes()}`.padStart(2, '0')}`;

export default function EventEditorScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const event = useDayDeskStore((state) => state.events.find((item) => item.id === params.id));
  const addEvent = useDayDeskStore((state) => state.addEvent);
  const updateEvent = useDayDeskStore((state) => state.updateEvent);
  const deleteEvent = useDayDeskStore((state) => state.deleteEvent);
  const defaults = useMemo(() => {
    const startsAt = event ? new Date(event.startsAt) : new Date(Date.now() + 60 * 60_000);
    startsAt.setSeconds(0, 0);
    const endsAt = event ? new Date(event.endsAt) : new Date(startsAt.getTime() + 60 * 60_000);
    return { startsAt, endsAt };
  }, [event]);
  const [title, setTitle] = useState(event?.title ?? '');
  const [startDate, setStartDate] = useState(dateInput(defaults.startsAt));
  const [endDate, setEndDate] = useState(dateInput(defaults.endsAt));
  const [startTime, setStartTime] = useState(timeInput(defaults.startsAt));
  const [endTime, setEndTime] = useState(timeInput(defaults.endsAt));
  const [type, setType] = useState<CalendarEventType>(event?.type ?? 'meeting');
  const [location, setLocation] = useState(event?.location ?? '');
  const [reminderEnabled, setReminderEnabled] = useState(event?.reminderEnabled ?? true);
  const [remindBeforeMinutes, setRemindBeforeMinutes] = useState(event?.remindBeforeMinutes ?? 10);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed) { Alert.alert('Добавьте название', 'Напишите, что запланировано.'); return; }
    const startsAt = new Date(`${startDate}T${startTime}:00`);
    const endsAt = new Date(`${endDate}T${endTime}:00`);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()) || endsAt <= startsAt) {
      Alert.alert('Проверьте время', 'Окончание события должно быть позже его начала.'); return;
    }
    setSaving(true);
    const input = { title: trimmed, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), type,
      location: location.trim() || undefined, reminderEnabled, remindBeforeMinutes };
    if (event) await updateEvent(event.id, input); else await addEvent(input);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const confirmDelete = () => {
    if (!event) return;
    Alert.alert('Удалить событие?', 'Оно исчезнет со всех подключённых устройств.', [
      { text: 'Отмена', style: 'cancel' },
      { text: 'Удалить', style: 'destructive', onPress: () => void deleteEvent(event.id).then(() => router.back()) },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <View style={[styles.navigation, { borderBottomColor: colors.border }]}>
          <Pressable accessibilityLabel="Закрыть" accessibilityRole="button" onPress={() => router.back()} style={styles.navButton}><Ionicons name="close" size={25} color={colors.text} /></Pressable>
          <Text style={[styles.navTitle, { color: colors.text }]}>{event ? 'Изменить событие' : 'Новое событие'}</Text>
          <Pressable accessibilityLabel="Сохранить событие" accessibilityRole="button" disabled={saving} onPress={() => void save()} style={styles.navButton}><Text style={[styles.done, { color: colors.primary }, saving && styles.disabled]}>Готово</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={[styles.label, { color: colors.text }]}>Название</Text>
          <TextInput accessibilityLabel="Название события" autoFocus={!event} maxLength={300} onChangeText={setTitle} placeholder="Например, встреча с командой" placeholderTextColor={colors.textMuted} style={[styles.textInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={title} />

          <Text style={[styles.label, { color: colors.text }]}>Начало</Text>
          <View style={styles.inputRow}><TextInput accessibilityLabel="Дата начала" maxLength={10} onChangeText={setStartDate} keyboardType="numbers-and-punctuation" style={[styles.textInput, styles.half, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={startDate} /><TextInput accessibilityLabel="Время начала" maxLength={5} onChangeText={setStartTime} keyboardType="numbers-and-punctuation" style={[styles.textInput, styles.half, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={startTime} /></View>
          <Text style={[styles.label, { color: colors.text }]}>Окончание</Text>
          <View style={styles.inputRow}><TextInput accessibilityLabel="Дата окончания" maxLength={10} onChangeText={setEndDate} keyboardType="numbers-and-punctuation" style={[styles.textInput, styles.half, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={endDate} /><TextInput accessibilityLabel="Время окончания" maxLength={5} onChangeText={setEndTime} keyboardType="numbers-and-punctuation" style={[styles.textInput, styles.half, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={endTime} /></View>

          <Text style={[styles.label, { color: colors.text }]}>Тип события</Text>
          <View style={styles.wrapRow}>{eventTypes.map((item) => <Pressable key={item.value} accessibilityRole="radio" accessibilityState={{ checked: type === item.value }} onPress={() => setType(item.value)} style={[styles.choice, { backgroundColor: type === item.value ? colors.primarySoft : colors.surface, borderColor: type === item.value ? colors.primary : colors.border }]}><Text style={[styles.choiceText, { color: type === item.value ? colors.primary : colors.text }]}>{item.label}</Text></Pressable>)}</View>

          <Text style={[styles.label, { color: colors.text }]}>Место или ссылка</Text>
          <TextInput accessibilityLabel="Место события" maxLength={500} onChangeText={setLocation} placeholder="Необязательно" placeholderTextColor={colors.textMuted} style={[styles.textInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={location} />

          <View style={[styles.setting, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: colors.text }]}>Напомнить</Text><Text style={[styles.settingSubtitle, { color: colors.textMuted }]}>Локальное уведомление на этом устройстве</Text></View><Switch accessibilityLabel="Включить напоминание" onValueChange={setReminderEnabled} trackColor={{ false: colors.border, true: colors.primarySoft }} thumbColor={reminderEnabled ? colors.primary : colors.textMuted} value={reminderEnabled} /></View>
          {reminderEnabled ? <View style={styles.wrapRow}>{[0, 5, 10, 30, 60].map((minutes) => <Pressable key={minutes} accessibilityRole="radio" accessibilityState={{ checked: remindBeforeMinutes === minutes }} onPress={() => setRemindBeforeMinutes(minutes)} style={[styles.choice, { backgroundColor: remindBeforeMinutes === minutes ? colors.primarySoft : colors.surface, borderColor: remindBeforeMinutes === minutes ? colors.primary : colors.border }]}><Text style={[styles.choiceText, { color: remindBeforeMinutes === minutes ? colors.primary : colors.text }]}>{minutes === 0 ? 'В момент' : `За ${minutes} мин`}</Text></Pressable>)}</View> : null}

          <Pressable accessibilityRole="button" disabled={saving} onPress={() => void save()} style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary }, pressed && styles.pressed, saving && styles.disabled]}><Text style={[styles.saveText, { color: colors.onPrimary }]}>{saving ? 'Сохраняем…' : event ? 'Сохранить изменения' : 'Добавить событие'}</Text></Pressable>
          {event ? <Pressable accessibilityRole="button" onPress={confirmDelete} style={styles.deleteButton}><Ionicons name="trash-outline" size={19} color={colors.danger} /><Text style={[styles.deleteText, { color: colors.danger }]}>Удалить событие</Text></Pressable> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 }, flex: { flex: 1 }, navigation: { height: 58, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  navButton: { minWidth: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' }, navTitle: { fontSize: 17, fontWeight: '700' }, done: { fontSize: 15, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 38 }, label: { marginTop: 18, marginBottom: 9, fontSize: 16, fontWeight: '700' },
  textInput: { minHeight: 52, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, fontSize: 16 }, inputRow: { flexDirection: 'row', gap: 10 }, half: { flex: 1 },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, choice: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, alignItems: 'center', justifyContent: 'center' }, choiceText: { fontSize: 14, fontWeight: '600' },
  setting: { minHeight: 70, marginTop: 22, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center' }, settingCopy: { flex: 1 }, settingTitle: { fontSize: 16, fontWeight: '700' }, settingSubtitle: { marginTop: 3, fontSize: 12 },
  saveButton: { minHeight: 54, marginTop: 28, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }, saveText: { fontSize: 16, fontWeight: '700' }, deleteButton: { minHeight: 52, marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, deleteText: { fontSize: 15, fontWeight: '600' }, pressed: { opacity: .72 }, disabled: { opacity: .5 },
});
