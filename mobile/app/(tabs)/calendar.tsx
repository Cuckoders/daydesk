import { useCallback, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { type Href, useRouter } from 'expo-router';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { EventCard } from '@/components/EventCard';
import { FloatingAddButton } from '@/components/FloatingAddButton';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { CalendarEvent } from '@/src/types';
import { formatLongDate, isSameDay } from '@/src/utils/date';

const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });

function getDays() {
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() + index);
    return date;
  });
}

export default function CalendarScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const events = useDayDeskStore((state) => state.events);
  const days = useMemo(getDays, []);
  const [selectedDate, setSelectedDate] = useState(days[0]);
  const selectedEvents = useMemo(
    () => events.filter((event) => isSameDay(event.startsAt, selectedDate)).sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [events, selectedDate],
  );
  const openEditor = useCallback((eventId?: string) => {
    const target = eventId ? { pathname: '/event-editor', params: { id: eventId } } : '/event-editor';
    router.push(target as Href);
  }, [router]);
  const renderItem = useCallback(({ item }: { item: CalendarEvent }) => <EventCard event={item} onPress={openEditor} />, [openEditor]);

  return (
    <AppScreen>
      <FlatList
        data={selectedEvents}
        renderItem={renderItem}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.content}
        ListHeaderComponent={(
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View>
                <Text style={[styles.title, { color: colors.text }]}>Календарь</Text>
                <Text style={[styles.subtitle, { color: colors.textMuted }]}>Планы и встречи в одном месте</Text>
              </View>
              <View style={[styles.calendarIcon, { backgroundColor: colors.primarySoft }]}>
                <Ionicons name="calendar" size={22} color={colors.primary} />
              </View>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.days}>
              {days.map((date) => {
                const selected = isSameDay(date, selectedDate);
                return (
                  <Pressable
                    key={date.toISOString()}
                    accessibilityLabel={formatLongDate(date)}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setSelectedDate(date)}
                    style={[styles.day, { backgroundColor: selected ? colors.primary : colors.surface, borderColor: colors.border }]}
                  >
                    <Text style={[styles.weekday, { color: selected ? colors.onPrimary : colors.textMuted }]}>{weekday.format(date).replace('.', '')}</Text>
                    <Text style={[styles.dayNumber, { color: selected ? colors.onPrimary : colors.text }]}>{date.getDate()}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Text style={[styles.selectedTitle, { color: colors.text }]}>{formatLongDate(selectedDate)}</Text>
          </View>
        )}
        ListEmptyComponent={(
          <View style={[styles.empty, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Ionicons name="calendar-clear-outline" size={31} color={colors.textMuted} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>День свободен</Text>
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>Встреч и событий пока нет.</Text>
          </View>
        )}
        initialNumToRender={8}
        windowSize={5}
        showsVerticalScrollIndicator={false}
      />
      <FloatingAddButton onPress={() => openEditor()} />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  header: { paddingTop: 14, paddingBottom: 14 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 32, lineHeight: 39, fontWeight: '800' },
  subtitle: { marginTop: 3, fontSize: 15, lineHeight: 21 },
  calendarIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  days: { gap: 8, paddingTop: 20, paddingBottom: 16 },
  day: { width: 56, minHeight: 72, borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  weekday: { fontSize: 12, lineHeight: 16, fontWeight: '600', textTransform: 'uppercase' },
  dayNumber: { marginTop: 4, fontSize: 20, lineHeight: 25, fontWeight: '800' },
  selectedTitle: { fontSize: 20, lineHeight: 27, fontWeight: '700', textTransform: 'capitalize' },
  separator: { minHeight: 10 },
  empty: { marginTop: 8, minHeight: 180, borderWidth: StyleSheet.hairlineWidth, borderRadius: 20, alignItems: 'center', justifyContent: 'center', padding: 24 },
  emptyTitle: { marginTop: 10, fontSize: 18, fontWeight: '700' },
  emptyText: { marginTop: 4, fontSize: 14 },
});
