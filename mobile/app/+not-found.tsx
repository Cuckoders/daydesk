import { Ionicons } from '@expo/vector-icons';
import { Link, Stack } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { useAppColors } from '@/src/theme';

export default function NotFoundScreen() {
  const colors = useAppColors();
  return (
    <AppScreen>
      <Stack.Screen options={{ title: 'Страница не найдена' }} />
      <View style={styles.container}>
        <Ionicons name="compass-outline" size={42} color={colors.textMuted} />
        <Text style={[styles.title, { color: colors.text }]}>Здесь ничего нет</Text>
        <Text style={[styles.subtitle, { color: colors.textMuted }]}>Вернитесь к плану дня и продолжайте работу.</Text>
        <Link href="/" style={[styles.link, { backgroundColor: colors.primary, color: colors.onPrimary }]}>На главный экран</Link>
      </View>
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  title: {
    fontSize: 20,
    marginTop: 14,
    fontWeight: '700',
  },
  subtitle: { marginTop: 7, maxWidth: 300, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  link: {
    minHeight: 48,
    marginTop: 22,
    borderRadius: 16,
    paddingHorizontal: 18,
    paddingVertical: 14,
    overflow: 'hidden',
    fontSize: 15,
    fontWeight: '700',
  },
});
