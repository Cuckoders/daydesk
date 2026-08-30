import { useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { Priority, TaskRecurrenceMode } from '@/src/types';

const priorities: { value: Priority; label: string; color: string }[] = [
  { value: 'high', label: 'Высокий', color: '#D64545' },
  { value: 'medium', label: 'Средний', color: '#D98B16' },
  { value: 'low', label: 'Низкий', color: '#2E7D66' },
];

const categories = ['Работа', 'Личное', 'Здоровье'];

const recurrences: { value: TaskRecurrenceMode; label: string }[] = [
  { value: 'none', label: 'Не повторять' },
  { value: 'daily', label: 'Каждый день' },
  { value: 'weekdays', label: 'По будням' },
  { value: 'weekly', label: 'Раз в неделю' },
];

function dateInput(value: Date) {
  const year = value.getFullYear();
  const month = `${value.getMonth() + 1}`.padStart(2, '0');
  const day = `${value.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function timeInput(value: Date) {
  return `${`${value.getHours()}`.padStart(2, '0')}:${`${value.getMinutes()}`.padStart(2, '0')}`;
}

export default function TaskEditorScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const task = useDayDeskStore((state) => state.tasks.find((item) => item.id === params.id));
  const addTask = useDayDeskStore((state) => state.addTask);
  const updateTask = useDayDeskStore((state) => state.updateTask);
  const deleteTask = useDayDeskStore((state) => state.deleteTask);
  const initialDue = useMemo(() => task ? new Date(task.dueAt) : new Date(Date.now() + 60 * 60_000), [task]);
  const [title, setTitle] = useState(task?.title ?? '');
  const [date, setDate] = useState(dateInput(initialDue));
  const [time, setTime] = useState(timeInput(initialDue));
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium');
  const [category, setCategory] = useState(task?.category ?? 'Работа');
  const [reminderEnabled, setReminderEnabled] = useState(task?.reminderEnabled ?? true);
  const [remindBeforeMinutes, setRemindBeforeMinutes] = useState(task?.remindBeforeMinutes ?? 10);
  const [recurrence, setRecurrence] = useState<TaskRecurrenceMode>(task?.recurrence ?? 'none');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      Alert.alert('Добавьте название', 'Напишите, что нужно сделать.');
      return;
    }
    const due = new Date(`${date}T${time}:00`);
    if (Number.isNaN(due.getTime())) {
      Alert.alert('Проверьте дату', 'Используйте формат ГГГГ-ММ-ДД и время ЧЧ:ММ.');
      return;
    }
    setSaving(true);
    const input = { title: trimmed, dueAt: due.toISOString(), priority, category, reminderEnabled, remindBeforeMinutes, recurrence };
    if (task) await updateTask(task.id, input);
    else await addTask(input);
    await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    router.back();
  };

  const confirmDelete = () => {
    if (!task) return;
    Alert.alert('Удалить задачу?', 'Это действие нельзя отменить.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: () => void deleteTask(task.id).then(() => router.back()),
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
        <View style={[styles.navigation, { borderBottomColor: colors.border }]}>
          <Pressable accessibilityLabel="Закрыть" accessibilityRole="button" onPress={() => router.back()} style={styles.navButton}>
            <Ionicons name="close" size={25} color={colors.text} />
          </Pressable>
          <Text style={[styles.navTitle, { color: colors.text }]}>{task ? 'Изменить задачу' : 'Новая задача'}</Text>
          <Pressable accessibilityLabel="Сохранить задачу" accessibilityRole="button" disabled={saving} onPress={() => void save()} style={styles.navButton}>
            <Text style={[styles.done, { color: colors.primary }, saving && styles.disabled]}>Готово</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Text style={[styles.label, { color: colors.text }]}>Что нужно сделать</Text>
          <TextInput
            accessibilityLabel="Название задачи"
            autoFocus={!task}
            multiline
            onChangeText={setTitle}
            placeholder="Например, подготовить отчёт"
            placeholderTextColor={colors.textMuted}
            style={[styles.titleInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
            value={title}
          />

          <Text style={[styles.label, { color: colors.text }]}>Срок</Text>
          <View style={styles.inputRow}>
            <View style={styles.inputColumn}>
              <Text style={[styles.inputCaption, { color: colors.textMuted }]}>Дата</Text>
              <TextInput
                accessibilityLabel="Дата задачи"
                autoCapitalize="none"
                keyboardType="numbers-and-punctuation"
                maxLength={10}
                onChangeText={setDate}
                placeholder="2026-08-30"
                placeholderTextColor={colors.textMuted}
                style={[styles.textInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                value={date}
              />
            </View>
            <View style={styles.inputColumn}>
              <Text style={[styles.inputCaption, { color: colors.textMuted }]}>Время</Text>
              <TextInput
                accessibilityLabel="Время задачи"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                onChangeText={setTime}
                placeholder="18:30"
                placeholderTextColor={colors.textMuted}
                style={[styles.textInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
                value={time}
              />
            </View>
          </View>

          <Text style={[styles.label, { color: colors.text }]}>Приоритет</Text>
          <View style={styles.wrapRow}>
            {priorities.map((item) => {
              const active = priority === item.value;
              return (
                <Pressable
                  key={item.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                  onPress={() => setPriority(item.value)}
                  style={[styles.choice, { backgroundColor: active ? `${item.color}1F` : colors.surface, borderColor: active ? item.color : colors.border }]}
                >
                  <View style={[styles.choiceDot, { backgroundColor: item.color }]} />
                  <Text style={[styles.choiceText, { color: colors.text }]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={[styles.label, { color: colors.text }]}>Категория</Text>
          <View style={styles.wrapRow}>
            {categories.map((item) => {
              const active = category === item;
              return (
                <Pressable
                  key={item}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                  onPress={() => setCategory(item)}
                  style={[styles.choice, { backgroundColor: active ? colors.primarySoft : colors.surface, borderColor: active ? colors.primary : colors.border }]}
                >
                  <Text style={[styles.choiceText, { color: active ? colors.primary : colors.text }]}>{item}</Text>
                </Pressable>
              );
            })}
          </View>

          <View style={[styles.setting, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.settingCopy}>
              <Text style={[styles.settingTitle, { color: colors.text }]}>Напомнить</Text>
              <Text style={[styles.settingSubtitle, { color: colors.textMuted }]}>Разрешение запросим при сохранении</Text>
            </View>
            <Switch
              accessibilityLabel="Включить напоминание"
              onValueChange={setReminderEnabled}
              trackColor={{ false: colors.border, true: colors.primarySoft }}
              thumbColor={reminderEnabled ? colors.primary : colors.textMuted}
              value={reminderEnabled}
            />
          </View>
          {reminderEnabled ? (
            <View style={styles.wrapRow}>
              {[0, 10, 30, 60].map((minutes) => {
                const active = remindBeforeMinutes === minutes;
                return (
                  <Pressable
                    key={minutes}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    onPress={() => setRemindBeforeMinutes(minutes)}
                    style={[styles.choice, { backgroundColor: active ? colors.primarySoft : colors.surface, borderColor: active ? colors.primary : colors.border }]}
                  >
                    <Text style={[styles.choiceText, { color: active ? colors.primary : colors.text }]}>{minutes === 0 ? 'В момент' : `За ${minutes} мин`}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          <Text style={[styles.label, { color: colors.text }]}>Повтор</Text>
          <View style={styles.wrapRow}>
            {recurrences.map((item) => {
              const active = recurrence === item.value;
              return (
                <Pressable
                  key={item.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: active }}
                  onPress={() => setRecurrence(item.value)}
                  style={[styles.choice, { backgroundColor: active ? colors.primarySoft : colors.surface, borderColor: active ? colors.primary : colors.border }]}
                >
                  <Text style={[styles.choiceText, { color: active ? colors.primary : colors.text }]}>{item.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            accessibilityRole="button"
            disabled={saving}
            onPress={() => void save()}
            style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary }, pressed && styles.pressed, saving && styles.disabled]}
          >
            <Text style={[styles.saveText, { color: colors.onPrimary }]}>{saving ? 'Сохраняем…' : task ? 'Сохранить изменения' : 'Добавить задачу'}</Text>
          </Pressable>
          {task ? (
            <Pressable accessibilityRole="button" onPress={confirmDelete} style={styles.deleteButton}>
              <Ionicons name="trash-outline" size={19} color={colors.danger} />
              <Text style={[styles.deleteText, { color: colors.danger }]}>Удалить задачу</Text>
            </Pressable>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  flex: { flex: 1 },
  navigation: { height: 58, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  navButton: { minWidth: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  navTitle: { fontSize: 17, fontWeight: '700' },
  done: { fontSize: 15, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 38 },
  label: { marginTop: 18, marginBottom: 9, fontSize: 16, fontWeight: '700' },
  titleInput: { minHeight: 96, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 16, fontSize: 18, lineHeight: 25, textAlignVertical: 'top' },
  inputRow: { flexDirection: 'row', gap: 10 },
  inputColumn: { flex: 1 },
  inputCaption: { marginBottom: 5, fontSize: 12, fontWeight: '600' },
  textInput: { minHeight: 52, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, fontSize: 16 },
  wrapRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  choiceDot: { width: 8, height: 8, borderRadius: 4 },
  choiceText: { fontSize: 14, fontWeight: '600' },
  setting: { minHeight: 72, marginTop: 22, marginBottom: 10, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center' },
  settingCopy: { flex: 1, paddingRight: 10 },
  settingTitle: { fontSize: 16, fontWeight: '700' },
  settingSubtitle: { marginTop: 3, fontSize: 12, lineHeight: 17 },
  saveButton: { minHeight: 56, marginTop: 28, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  saveText: { fontSize: 16, fontWeight: '800' },
  deleteButton: { minHeight: 52, marginTop: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  deleteText: { fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.76 },
  disabled: { opacity: 0.5 },
});
