import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { disconnectSyncDevice, getSyncConfiguration, registerSyncDevice, syncNow, type SyncConfiguration } from '@/src/services/sync';
import { disableMailBackgroundNotifications, enableMailBackgroundNotifications, getMailBackgroundState } from '@/src/services/mail-background';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import { formatShortDate, formatTime } from '@/src/utils/date';

export default function SyncSettingsScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const syncStatus = useDayDeskStore((state) => state.syncStatus);
  const syncError = useDayDeskStore((state) => state.syncError);
  const syncQueueLength = useDayDeskStore((state) => state.syncQueue.length);
  const lastSyncedAt = useDayDeskStore((state) => state.lastSyncedAt);
  const [configuration, setConfiguration] = useState<SyncConfiguration>();
  const [apiUrl, setApiUrl] = useState('http://127.0.0.1:4310');
  const [setupCode, setSetupCode] = useState('');
  const [deviceName, setDeviceName] = useState(Platform.OS === 'ios' ? 'Мой iPhone' : 'Мой Android');
  const [working, setWorking] = useState(false);
  const [mailWorking, setMailWorking] = useState(false);
  const [mailNotifications, setMailNotifications] = useState(false);
  const [mailBackgroundAvailable, setMailBackgroundAvailable] = useState(false);

  useEffect(() => {
    void getSyncConfiguration().then((saved) => {
      setConfiguration(saved);
      if (saved) {
        setApiUrl(saved.apiUrl);
        setDeviceName(saved.deviceName);
      }
    });
    void getMailBackgroundState().then((state) => { setMailNotifications(state.enabled); setMailBackgroundAvailable(state.available); }).catch(() => undefined);
  }, []);

  const toggleMailNotifications = async (enabled: boolean) => {
    setMailWorking(true);
    try {
      if (enabled) await enableMailBackgroundNotifications(); else await disableMailBackgroundNotifications();
      setMailNotifications(enabled);
      if (enabled) await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    } catch (error) {
      setMailNotifications((await getMailBackgroundState().catch(() => ({ enabled: false }))).enabled);
      Alert.alert('Не удалось изменить фоновую почту', error instanceof Error ? error.message : 'Попробуйте ещё раз.');
    } finally { setMailWorking(false); }
  };

  const connect = async () => {
    setWorking(true);
    try {
      await registerSyncDevice(apiUrl, setupCode, deviceName);
      const saved = await getSyncConfiguration();
      setConfiguration(saved);
      setSetupCode('');
      await syncNow();
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (error) {
      Alert.alert('Не удалось подключиться', error instanceof Error ? error.message : 'Проверьте адрес и setup-код.');
    } finally {
      setWorking(false);
    }
  };

  const synchronize = async () => {
    setWorking(true);
    const success = await syncNow();
    setWorking(false);
    if (success) await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  };

  const disconnect = () => {
    Alert.alert('Отключить устройство?', 'Локальные задачи останутся на телефоне, но токен устройства будет отозван.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Отключить',
        style: 'destructive',
        onPress: () => void disableMailBackgroundNotifications().catch(() => undefined).then(() => disconnectSyncDevice())
          .then(() => { setConfiguration(undefined); setMailNotifications(false); })
          .catch((error) => Alert.alert('Не удалось отключить устройство', error instanceof Error ? error.message : 'Попробуйте ещё раз.')),
      },
    ]);
  };

  const statusLabel = syncStatus === 'syncing'
    ? 'Синхронизация…'
    : syncStatus === 'offline'
      ? 'Нет соединения'
      : syncStatus === 'error'
        ? 'Требуется внимание'
        : 'Готово к синхронизации';

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <View style={[styles.navigation, { borderBottomColor: colors.border }]}>
        <Pressable accessibilityLabel="Закрыть" accessibilityRole="button" onPress={() => router.back()} style={styles.navButton}>
          <Ionicons name="close" size={25} color={colors.text} />
        </Pressable>
        <Text style={[styles.navTitle, { color: colors.text }]}>Синхронизация</Text>
        <View style={styles.navButton} />
      </View>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={[styles.hero, { backgroundColor: colors.primarySoft }]}>
          <View style={[styles.heroIcon, { backgroundColor: colors.surface }]}>
            <Ionicons name="sync" size={25} color={colors.primary} />
          </View>
          <View style={styles.heroCopy}>
            <Text style={[styles.heroTitle, { color: colors.text }]}>{statusLabel}</Text>
            <Text style={[styles.heroText, { color: colors.textMuted }]}>
              {lastSyncedAt ? `Последний обмен: ${formatShortDate(lastSyncedAt)}, ${formatTime(lastSyncedAt)}` : 'Изменения пока хранятся только на устройстве'}
            </Text>
          </View>
          <View style={[styles.queueBadge, { backgroundColor: colors.surface }]}>
            <Text style={[styles.queueText, { color: colors.primary }]}>{syncQueueLength}</Text>
          </View>
        </View>

        {syncError ? (
          <View style={[styles.errorBox, { borderColor: colors.danger }]}>
            <Ionicons name="alert-circle-outline" size={21} color={colors.danger} />
            <Text style={[styles.errorText, { color: colors.danger }]}>{syncError}</Text>
          </View>
        ) : null}

        {configuration ? (
          <>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Подключённое устройство</Text>
            <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.detailRow}>
                <Ionicons name="phone-portrait-outline" size={21} color={colors.primary} />
                <View style={styles.detailCopy}>
                  <Text style={[styles.detailTitle, { color: colors.text }]}>{configuration.deviceName}</Text>
                  <Text numberOfLines={1} style={[styles.detailText, { color: colors.textMuted }]}>{configuration.apiUrl}</Text>
                </View>
              </View>
            </View>
            <Pressable
              accessibilityRole="button"
              disabled={working}
              onPress={() => void synchronize()}
              style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed, working && styles.disabled]}
            >
              <Ionicons name="sync" size={21} color={colors.onPrimary} />
              <Text style={[styles.primaryText, { color: colors.onPrimary }]}>{working ? 'Синхронизируем…' : 'Синхронизировать сейчас'}</Text>
            </Pressable>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Фоновая почта</Text>
            <View style={[styles.setting, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.settingCopy}>
                <Text style={[styles.settingTitle, { color: colors.text }]}>Уведомлять о новых письмах</Text>
                <Text style={[styles.settingText, { color: colors.textMuted }]}>{mailBackgroundAvailable ? 'Приватная проверка входящих в системном фоне' : 'Нужен development или production build на реальном устройстве'}</Text>
              </View>
              <Switch accessibilityLabel="Фоновые уведомления о почте" disabled={mailWorking || (!mailNotifications && !mailBackgroundAvailable)} onValueChange={(value) => void toggleMailNotifications(value)} trackColor={{ false: colors.border, true: colors.primarySoft }} thumbColor={mailNotifications ? colors.primary : colors.textMuted} value={mailNotifications} />
            </View>
            <Text style={[styles.backgroundNote, { color: colors.textMuted }]}>iOS и Android сами выбирают время запуска. Минимальный интервал — 15 минут; доставка не гарантируется сразу.</Text>
            <Pressable accessibilityRole="button" onPress={disconnect} style={styles.disconnectButton}>
              <Ionicons name="unlink-outline" size={19} color={colors.danger} />
              <Text style={[styles.disconnectText, { color: colors.danger }]}>Отключить устройство</Text>
            </Pressable>
          </>
        ) : (
          <>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Подключить сервер</Text>
            <Text style={[styles.description, { color: colors.textMuted }]}>Запустите `server/` на компьютере. Setup-код используется один раз и никогда не сохраняется на телефоне.</Text>
            <Text style={[styles.label, { color: colors.text }]}>Адрес сервера</Text>
            <TextInput
              accessibilityLabel="Адрес сервера синхронизации"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={setApiUrl}
              placeholder="https://sync.example.com"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={apiUrl}
            />
            <Text style={[styles.label, { color: colors.text }]}>Setup-код</Text>
            <TextInput
              accessibilityLabel="Setup-код сервера"
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={setSetupCode}
              placeholder="Не меньше 12 символов"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={setupCode}
            />
            <Text style={[styles.label, { color: colors.text }]}>Название устройства</Text>
            <TextInput
              accessibilityLabel="Название устройства"
              maxLength={80}
              onChangeText={setDeviceName}
              placeholder="Мой телефон"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]}
              value={deviceName}
            />
            <Pressable
              accessibilityRole="button"
              disabled={working || Platform.OS === 'web'}
              onPress={() => void connect()}
              style={({ pressed }) => [styles.primaryButton, { backgroundColor: colors.primary }, pressed && styles.pressed, (working || Platform.OS === 'web') && styles.disabled]}
            >
              <Ionicons name="link-outline" size={21} color={colors.onPrimary} />
              <Text style={[styles.primaryText, { color: colors.onPrimary }]}>{working ? 'Подключаем…' : 'Подключить устройство'}</Text>
            </Pressable>
            {Platform.OS === 'web' ? <Text style={[styles.webNote, { color: colors.warning }]}>Токены не сохраняются в браузере. Откройте нативное приложение.</Text> : null}
          </>
        )}

        <View style={[styles.securityNote, { backgroundColor: colors.surfaceRaised }]}>
          <Ionicons name="shield-checkmark-outline" size={22} color={colors.primary} />
          <Text style={[styles.securityText, { color: colors.textMuted }]}>Device-token хранится в Keychain iOS или EncryptedSharedPreferences Android. Сервер сохраняет только его хеш.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  navigation: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  navButton: { minWidth: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  navTitle: { fontSize: 17, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 38 },
  hero: { minHeight: 106, borderRadius: 22, padding: 16, flexDirection: 'row', alignItems: 'center' },
  heroIcon: { minWidth: 48, minHeight: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  heroCopy: { flex: 1, marginLeft: 12 },
  heroTitle: { fontSize: 17, lineHeight: 23, fontWeight: '700' },
  heroText: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  queueBadge: { minWidth: 42, minHeight: 42, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  queueText: { fontSize: 15, fontWeight: '800' },
  errorBox: { minHeight: 56, marginTop: 12, borderWidth: 1, borderRadius: 16, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 9 },
  errorText: { flex: 1, fontSize: 14, lineHeight: 20 },
  sectionTitle: { marginTop: 24, marginBottom: 8, fontSize: 20, lineHeight: 27, fontWeight: '700' },
  description: { marginBottom: 8, fontSize: 14, lineHeight: 21 },
  label: { marginTop: 14, marginBottom: 7, fontSize: 14, fontWeight: '700' },
  input: { minHeight: 54, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 14, fontSize: 16 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 14 },
  setting: { minHeight: 82, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
  settingCopy: { flex: 1 },
  settingTitle: { fontSize: 15, fontWeight: '700' },
  settingText: { marginTop: 4, fontSize: 13, lineHeight: 18 },
  backgroundNote: { marginTop: 9, fontSize: 12, lineHeight: 18 },
  detailRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center' },
  detailCopy: { flex: 1, marginLeft: 11 },
  detailTitle: { fontSize: 16, fontWeight: '700' },
  detailText: { marginTop: 3, fontSize: 13 },
  primaryButton: { minHeight: 56, marginTop: 20, borderRadius: 18, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  primaryText: { fontSize: 16, fontWeight: '800' },
  disconnectButton: { minHeight: 52, marginTop: 8, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  disconnectText: { fontSize: 15, fontWeight: '700' },
  webNote: { marginTop: 10, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  securityNote: { minHeight: 82, marginTop: 24, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  securityText: { flex: 1, fontSize: 13, lineHeight: 19 },
  pressed: { opacity: 0.75 },
  disabled: { opacity: 0.5 },
});
