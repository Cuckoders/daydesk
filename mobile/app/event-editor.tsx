import { useEffect, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { discardTransientEventDraft, readTransientEventDraft } from '@/src/services/editor-drafts';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { CalendarEventType, NewEventInput } from '@/src/types';

const eventTypes: { value: CalendarEventType; label: string }[] = [
  { value: 'meeting', label: 'Встреча' },
  { value: 'focus', label: 'Фокус' },
  { value: 'meal', label: 'Приём пищи' },
  { value: 'personal', label: 'Личное' },
];

const dateInput = (value: Date) => `${value.getFullYear()}-${`${value.getMonth() + 1}`.padStart(2, '0')}-${`${value.getDate()}`.padStart(2, '0')}`;
const timeInput = (value: Date) => `${`${value.getHours()}`.padStart(2, '0')}:${`${value.getMinutes()}`.padStart(2, '0')}`;

function parseLocalDateTime(dateValue: string, timeValue: string) {
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  const timeMatch = /^(\d{2}):(\d{2})$/.exec(timeValue);
  if (!dateMatch || !timeMatch) return undefined;
  const [, yearValue, monthValue, dayValue] = dateMatch;
  const [, hourValue, minuteValue] = timeMatch;
  const year = Number(yearValue); const month = Number(monthValue); const day = Number(dayValue);
  const hour = Number(hourValue); const minute = Number(minuteValue);
  const value = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (year < 1970 || year > 2100 || value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day
    || value.getHours() !== hour || value.getMinutes() !== minute) return undefined;
  return value;
}

export default function EventEditorScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string; draftId?: string }>();
  const event = useDayDeskStore((state) => state.events.find((item) => item.id === params.id));
  const [draft] = useState(() => params.id ? undefined : readTransientEventDraft(params.draftId));
  const addEvent = useDayDeskStore((state) => state.addEvent);
  const updateEvent = useDayDeskStore((state) => state.updateEvent);
  const deleteEvent = useDayDeskStore((state) => state.deleteEvent);
  const defaults = useMemo(() => {
    const source = event ?? draft;
    const startsAt = source ? new Date(source.startsAt) : new Date(Date.now() + 60 * 60_000);
    startsAt.setSeconds(0, 0);
    const endsAt = source ? new Date(source.endsAt) : new Date(startsAt.getTime() + 60 * 60_000);
    return {
      startsAt, endsAt,
      startDate: source?.allDayStartDate ?? dateInput(startsAt),
      endDate: source?.allDayEndDate ?? dateInput(endsAt),
    };
  }, [draft, event]);
  const [title, setTitle] = useState(event?.title ?? draft?.title ?? '');
  const [startDate, setStartDate] = useState(defaults.startDate);
  const [endDate, setEndDate] = useState(defaults.endDate);
  const [startTime, setStartTime] = useState(timeInput(defaults.startsAt));
  const [endTime, setEndTime] = useState(timeInput(defaults.endsAt));
  const [type, setType] = useState<CalendarEventType>(event?.type ?? 'meeting');
  const [location, setLocation] = useState(event?.location ?? draft?.location ?? '');
  const [allDay, setAllDay] = useState(event?.allDay ?? draft?.allDay ?? false);
  const [reminderEnabled, setReminderEnabled] = useState(event?.reminderEnabled ?? !draft?.allDay);
  const [remindBeforeMinutes, setRemindBeforeMinutes] = useState(event?.remindBeforeMinutes ?? (draft ? 15 : 10));
  const [saving, setSaving] = useState(false);

  useEffect(() => { discardTransientEventDraft(params.draftId); }, [params.draftId]);

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed) { Alert.alert('Добавьте название', 'Напишите, что запланировано.'); return; }
    const startsAt = parseLocalDateTime(startDate, allDay ? '00:00' : startTime);
    const endsAt = parseLocalDateTime(endDate, allDay ? '00:00' : endTime);
    if (!startsAt || !endsAt || endsAt <= startsAt) {
      Alert.alert('Проверьте время', 'Окончание события должно быть позже его начала.'); return;
    }
    setSaving(true);
    const input: NewEventInput = { title: trimmed, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString(), type,
      location: location.trim() || undefined, reminderEnabled, remindBeforeMinutes, allDay,
      allDayStartDate: allDay ? startDate : undefined, allDayEndDate: allDay ? endDate : undefined };
    try {
      if (event) await updateEvent(event.id, input); else await addEvent(input);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch { setSaving(false); Alert.alert('Не удалось сохранить событие', 'Попробуйте ещё раз.'); }
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
          {draft?.source === 'mail-invitation' ? <View style={[styles.importNotice, { backgroundColor: colors.primarySoft }]}><Ionicons name="calendar-outline" size={21} color={colors.primary} /><Text style={[styles.importNoticeText, { color: colors.text }]}>Данные получены из письма. Проверьте название, даты и место перед сохранением.</Text></View> : null}
          <Text style={[styles.label, { color: colors.text }]}>Название</Text>
          <TextInput accessibilityLabel="Название события" autoFocus={!event && !draft} maxLength={300} onChangeText={setTitle} placeholder="Например, встреча с командой" placeholderTextColor={colors.textMuted} style={[styles.textInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={title} />

          <View style={[styles.setting, styles.allDaySetting, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: colors.text }]}>Весь день</Text><Text style={[styles.settingSubtitle, { color: colors.textMuted }]}>Без конкретного времени начала</Text></View><Switch accessibilityLabel="Событие на весь день" onValueChange={setAllDay} trackColor={{ false: colors.border, true: colors.primarySoft }} thumbColor={allDay ? colors.primary : colors.textMuted} value={allDay} /></View>

          <Text style={[styles.label, { color: colors.text }]}>Начало</Text>
          <View style={styles.inputRow}><TextInput accessibilityLabel="Дата начала" maxLength={10} onChangeText={setStartDate} keyboardType="numbers-and-punctuation" style={[styles.textInput, styles.half, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={startDate} />{!allDay ? <TextInput accessibilityLabel="Время начала" maxLength={5} onChangeText={setStartTime} keyboardType="numbers-and-punctuation" style={[styles.textInput, styles.half, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={startTime} /> : null}</View>
          <Text style={[styles.label, { color: colors.text }]}>{allDay ? 'Окончание (дата не включается)' : 'Окончание'}</Text>
          <View style={styles.inputRow}><TextInput accessibilityLabel="Дата окончания" maxLength={10} onChangeText={setEndDate} keyboardType="numbers-and-punctuation" style={[styles.textInput, styles.half, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={endDate} />{!allDay ? <TextInput accessibilityLabel="Время окончания" maxLength={5} onChangeText={setEndTime} keyboardType="numbers-and-punctuation" style={[styles.textInput, styles.half, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={endTime} /> : null}</View>

          <Text style={[styles.label, { color: colors.text }]}>Тип события</Text>
          <View style={styles.wrapRow}>{eventTypes.map((item) => <Pressable key={item.value} accessibilityRole="radio" accessibilityState={{ checked: type === item.value }} onPress={() => setType(item.value)} style={[styles.choice, { backgroundColor: type === item.value ? colors.primarySoft : colors.surface, borderColor: type === item.value ? colors.primary : colors.border }]}><Text style={[styles.choiceText, { color: type === item.value ? colors.primary : colors.text }]}>{item.label}</Text></Pressable>)}</View>

          <Text style={[styles.label, { color: colors.text }]}>Место или ссылка</Text>
          <TextInput accessibilityLabel="Место события" maxLength={500} onChangeText={setLocation} placeholder="Необязательно" placeholderTextColor={colors.textMuted} style={[styles.textInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={location} />

          <View style={[styles.setting, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={styles.settingCopy}><Text style={[styles.settingTitle, { color: colors.text }]}>Напомнить</Text><Text style={[styles.settingSubtitle, { color: colors.textMuted }]}>Локальное уведомление на этом устройстве</Text></View><Switch accessibilityLabel="Включить напоминание" onValueChange={setReminderEnabled} trackColor={{ false: colors.border, true: colors.primarySoft }} thumbColor={reminderEnabled ? colors.primary : colors.textMuted} value={reminderEnabled} /></View>
          {reminderEnabled ? <View style={styles.wrapRow}>{[0, 5, 10, 15, 30, 60].map((minutes) => <Pressable key={minutes} accessibilityRole="radio" accessibilityState={{ checked: remindBeforeMinutes === minutes }} onPress={() => setRemindBeforeMinutes(minutes)} style={[styles.choice, { backgroundColor: remindBeforeMinutes === minutes ? colors.primarySoft : colors.surface, borderColor: remindBeforeMinutes === minutes ? colors.primary : colors.border }]}><Text style={[styles.choiceText, { color: remindBeforeMinutes === minutes ? colors.primary : colors.text }]}>{minutes === 0 ? 'В момент' : `За ${minutes} мин`}</Text></Pressable>)}</View> : null}

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
  setting: { minHeight: 70, marginTop: 22, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center' }, allDaySetting: { marginTop: 18 }, settingCopy: { flex: 1 }, settingTitle: { fontSize: 16, fontWeight: '700' }, settingSubtitle: { marginTop: 3, fontSize: 12 },
  importNotice: { minHeight: 68, borderRadius: 17, padding: 13, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, importNoticeText: { flex: 1, fontSize: 13, lineHeight: 19 },
  saveButton: { minHeight: 54, marginTop: 28, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }, saveText: { fontSize: 16, fontWeight: '700' }, deleteButton: { minHeight: 52, marginTop: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, deleteText: { fontSize: 15, fontWeight: '600' }, pressed: { opacity: .72 }, disabled: { opacity: .5 },
});
