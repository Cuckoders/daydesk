import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { Platform, Pressable, StyleSheet, Text } from 'react-native';

import { useAppColors } from '@/src/theme';

export function FloatingAddButton({ onPress, label = 'Новая задача' }: { onPress: () => void; label?: string }) {
  const colors = useAppColors();
  const handlePress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onPress();
  };
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      android_ripple={{ color: 'rgba(255,255,255,0.24)' }}
      onPress={handlePress}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: colors.primary },
        pressed && Platform.OS === 'ios' && styles.pressed,
      ]}
    >
      <Ionicons name="add" size={24} color={colors.onPrimary} />
      <Text style={[styles.label, { color: colors.onPrimary }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    position: 'absolute',
    right: 18,
    bottom: 18,
    minHeight: 56,
    borderRadius: 20,
    paddingHorizontal: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 5 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 7,
  },
  label: { fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.78, transform: [{ scale: 0.98 }] },
});
