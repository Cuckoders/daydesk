import { memo } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppColors } from '@/src/theme';
import type { CalendarEvent } from '@/src/types';
import { formatTime } from '@/src/utils/date';

const eventColors = {
  meeting: '#3178C6',
  meal: '#D98B16',
  focus: '#167654',
  personal: '#8A4EA3',
};

export const EventCard = memo(function EventCard({ event, onPress }: { event: CalendarEvent; onPress?: (eventId: string) => void }) {
  const colors = useAppColors();
  return (
    <Pressable accessibilityLabel={`${event.title}, ${formatTime(event.startsAt)}`} accessibilityRole={onPress ? 'button' : undefined} disabled={!onPress} onPress={() => onPress?.(event.id)} style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}>
      <View style={[styles.marker, { backgroundColor: eventColors[event.type] }]} />
      <View style={styles.timeBlock}>
        <Text style={[styles.time, { color: colors.text }]}>{event.allDay ? 'Весь' : formatTime(event.startsAt)}</Text>
        <Text style={[styles.endTime, { color: colors.textMuted }]}>{event.allDay ? 'день' : formatTime(event.endsAt)}</Text>
      </View>
      <View style={styles.body}>
        <Text numberOfLines={2} style={[styles.title, { color: colors.text }]}>{event.title}</Text>
        {event.location ? (
          <View style={styles.locationRow}>
            <Ionicons name="location-outline" size={14} color={colors.textMuted} />
            <Text numberOfLines={1} style={[styles.location, { color: colors.textMuted }]}>{event.location}</Text>
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { minHeight: 76, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, flexDirection: 'row', overflow: 'hidden' },
  marker: { width: 4 },
  timeBlock: { width: 72, paddingLeft: 16, justifyContent: 'center' },
  time: { fontSize: 16, fontWeight: '700' },
  endTime: { marginTop: 2, fontSize: 12 },
  body: { flex: 1, paddingVertical: 14, paddingRight: 16, justifyContent: 'center' },
  title: { fontSize: 16, lineHeight: 21, fontWeight: '600' },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 5 },
  location: { flex: 1, fontSize: 13 },
  pressed: { opacity: .72 },
});
