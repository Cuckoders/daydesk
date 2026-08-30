import { Pressable, StyleSheet, Text, View } from 'react-native';

import { useAppColors } from '@/src/theme';

interface Props {
  title: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function SectionHeader({ title, actionLabel, onAction }: Props) {
  const colors = useAppColors();
  return (
    <View style={styles.row}>
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {actionLabel && onAction ? (
        <Pressable
          accessibilityLabel={actionLabel}
          accessibilityRole="button"
          hitSlop={8}
          onPress={onAction}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          <Text style={[styles.actionText, { color: colors.primary }]}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 20, lineHeight: 26, fontWeight: '700' },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  actionText: { fontSize: 15, fontWeight: '600' },
  pressed: { opacity: 0.55 },
});
