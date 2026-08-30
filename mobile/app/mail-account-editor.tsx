import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { connectImap, loadMailOAuthProviders, startMailOAuth, synchronizeMail, waitForMailOAuth, type OAuthMailProvider } from '@/src/services/mail';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';

const presets = [
  { id: 'yandex', label: 'Yandex', host: 'imap.yandex.ru' },
  { id: 'mailru', label: 'Mail.ru', host: 'imap.mail.ru' },
  { id: 'icloud', label: 'iCloud', host: 'imap.mail.me.com' },
  { id: 'gmail', label: 'Gmail (пароль)', host: 'imap.gmail.com' },
  { id: 'custom', label: 'Другой', host: '' },
] as const;

export default function MailAccountEditorScreen() {
  const colors = useAppColors(); const router = useRouter();
  const setMailSnapshot = useDayDeskStore((state) => state.setMailSnapshot);
  const [preset, setPreset] = useState<(typeof presets)[number]['id']>('yandex');
  const [label, setLabel] = useState('Yandex'); const [address, setAddress] = useState(''); const [host, setHost] = useState('imap.yandex.ru'); const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [saving, setSaving] = useState(false);
  const [oauthProviders, setOauthProviders] = useState<OAuthMailProvider[]>([]); const [oauthWorking, setOauthWorking] = useState<OAuthMailProvider>();
  const choosePreset = (item: (typeof presets)[number]) => { setPreset(item.id); setLabel(item.id === 'custom' ? '' : item.label); setHost(item.host); };
  const updateAddress = (value: string) => { setAddress(value); if (!username || username === address) setUsername(value); };

  useEffect(() => { let active = true; void loadMailOAuthProviders().then((providers) => { if (active) setOauthProviders(providers); }).catch(() => undefined); return () => { active = false; }; }, []);

  const connectOAuth = async (provider: OAuthMailProvider) => {
    setOauthWorking(provider);
    try {
      const flow = await startMailOAuth(provider);
      await WebBrowser.openBrowserAsync(flow.authorizationUrl, { presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET });
      const account = await waitForMailOAuth(flow);
      const snapshot = await synchronizeMail(account.id);
      const current = useDayDeskStore.getState();
      setMailSnapshot([...current.accounts.filter((item) => item.id !== account.id), ...snapshot.accounts],
        [...current.messages.filter((item) => item.accountId !== account.id), ...snapshot.messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)));
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      router.back();
    } catch (error) { Alert.alert('Не удалось войти в почту', error instanceof Error ? error.message : 'Повторите подключение.'); }
    finally { setOauthWorking(undefined); }
  };

  const save = async () => {
    setSaving(true);
    try {
      const result = await connectImap({ label, address, host, port: 993, username, password });
      const current = useDayDeskStore.getState();
      setMailSnapshot([...current.accounts.filter((item) => item.id !== result.account.id), result.account], [...current.messages.filter((item) => item.accountId !== result.account.id), ...result.messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)));
      setPassword('');
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      router.back();
    } catch (error) { Alert.alert('Не удалось подключить почту', error instanceof Error ? error.message : 'Проверьте настройки и пароль приложения.'); }
    finally { setPassword(''); setSaving(false); }
  };

  return <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
    <View style={[styles.navigation, { borderBottomColor: colors.border }]}><Pressable accessibilityLabel="Закрыть" accessibilityRole="button" onPress={() => router.back()} style={styles.navButton}><Ionicons name="close" size={25} color={colors.text} /></Pressable><Text style={[styles.navTitle, { color: colors.text }]}>Подключить почту</Text><Pressable accessibilityLabel="Подключить IMAP-аккаунт" accessibilityRole="button" disabled={saving || Boolean(oauthWorking)} onPress={() => void save()} style={styles.navButton}><Text style={[styles.done, { color: colors.primary }, (saving || oauthWorking) && styles.disabled]}>IMAP</Text></Pressable></View>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Text style={[styles.sectionTitle, { color: colors.text }]}>Gmail и Outlook</Text><Text style={[styles.sectionCopy, { color: colors.textMuted }]}>Войдите на официальной странице провайдера. DayDesk получит только доступ на чтение почты.</Text>
      <View style={styles.oauthList}>{([
        { provider: 'gmail' as const, label: 'Gmail', icon: 'logo-google' as const, color: '#D93025' },
        { provider: 'outlook' as const, label: 'Outlook', icon: 'logo-microsoft' as const, color: '#0A64AD' },
      ]).map((item) => { const available = oauthProviders.includes(item.provider); const working = oauthWorking === item.provider; return <Pressable key={item.provider} accessibilityHint={available ? 'Откроет защищённую страницу входа' : 'Провайдер не настроен на сервере'} accessibilityLabel={`Подключить ${item.label}`} accessibilityRole="button" accessibilityState={{ disabled: !available || Boolean(oauthWorking) }} disabled={!available || Boolean(oauthWorking)} onPress={() => void connectOAuth(item.provider)} style={({ pressed }) => [styles.oauthButton, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed, (!available || oauthWorking) && styles.disabled]}><View style={[styles.oauthIcon, { backgroundColor: `${item.color}18` }]}><Ionicons name={item.icon} size={23} color={item.color} /></View><View style={styles.oauthCopy}><Text style={[styles.oauthTitle, { color: colors.text }]}>{working ? `Подключаем ${item.label}…` : `Подключить ${item.label}`}</Text><Text style={[styles.oauthStatus, { color: colors.textMuted }]}>{available ? 'OAuth 2.0 · без пароля в DayDesk' : 'Не настроено на сервере'}</Text></View><Ionicons name="open-outline" size={20} color={colors.textMuted} /></Pressable>; })}</View>
      <View style={styles.dividerRow}><View style={[styles.divider, { backgroundColor: colors.border }]} /><Text style={[styles.dividerText, { color: colors.textMuted }]}>IMAP с паролем приложения</Text><View style={[styles.divider, { backgroundColor: colors.border }]} /></View>
      <Text style={[styles.label, { color: colors.text }]}>Провайдер</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.presets}>{presets.map((item) => <Pressable key={item.id} accessibilityRole="radio" accessibilityState={{ checked: preset === item.id }} onPress={() => choosePreset(item)} style={[styles.preset, { backgroundColor: preset === item.id ? colors.primarySoft : colors.surface, borderColor: preset === item.id ? colors.primary : colors.border }]}><Text style={[styles.presetText, { color: preset === item.id ? colors.primary : colors.text }]}>{item.label}</Text></Pressable>)}</ScrollView>
      <Text style={[styles.label, { color: colors.text }]}>Название</Text><TextInput accessibilityLabel="Название аккаунта" maxLength={80} onChangeText={setLabel} placeholder="Рабочая почта" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={label} />
      <Text style={[styles.label, { color: colors.text }]}>Почтовый адрес</Text><TextInput accessibilityLabel="Почтовый адрес" autoCapitalize="none" autoComplete="email" autoCorrect={false} keyboardType="email-address" maxLength={320} onChangeText={updateAddress} placeholder="name@example.com" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={address} />
      <Text style={[styles.label, { color: colors.text }]}>IMAP-сервер</Text><View style={styles.row}><TextInput accessibilityLabel="IMAP-сервер" autoCapitalize="none" autoCorrect={false} editable={preset === 'custom'} maxLength={253} onChangeText={setHost} placeholder="imap.example.com" placeholderTextColor={colors.textMuted} style={[styles.input, styles.hostInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={host} /><View style={[styles.port, { backgroundColor: colors.surfaceRaised }]}><Text style={[styles.portText, { color: colors.textMuted }]}>TLS 993</Text></View></View>
      <Text style={[styles.label, { color: colors.text }]}>Имя пользователя</Text><TextInput accessibilityLabel="Имя пользователя IMAP" autoCapitalize="none" autoCorrect={false} maxLength={320} onChangeText={setUsername} placeholder="Обычно полный email" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={username} />
      <Text style={[styles.label, { color: colors.text }]}>Пароль приложения</Text><TextInput accessibilityLabel="Пароль приложения" autoCapitalize="none" autoCorrect={false} maxLength={1024} onChangeText={setPassword} placeholder="Не основной пароль при включённой 2FA" placeholderTextColor={colors.textMuted} secureTextEntry style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={password} />
      <View style={[styles.note, { backgroundColor: colors.primarySoft }]}><Ionicons name="key-outline" size={21} color={colors.primary} /><Text style={[styles.noteText, { color: colors.textMuted }]}>Для iCloud, Gmail, Yandex и Mail.ru создайте отдельный пароль приложения. Он не попадёт в AsyncStorage или логи.</Text></View>
      <Pressable accessibilityRole="button" disabled={saving} onPress={() => void save()} style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary }, pressed && styles.pressed, saving && styles.disabled]}><Text style={[styles.saveText, { color: colors.onPrimary }]}>{saving ? 'Проверяем подключение…' : 'Подключить аккаунт'}</Text></Pressable>
    </ScrollView>
  </KeyboardAvoidingView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 }, flex: { flex: 1 }, navigation: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, navButton: { minWidth: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' }, navTitle: { fontSize: 17, fontWeight: '700' }, done: { fontSize: 15, fontWeight: '700' }, content: { padding: 16, paddingBottom: 38 },
  sectionTitle: { fontSize: 22, fontWeight: '800' }, sectionCopy: { marginTop: 7, fontSize: 14, lineHeight: 21 }, oauthList: { marginTop: 15, gap: 9 }, oauthButton: { minHeight: 72, borderWidth: StyleSheet.hairlineWidth, borderRadius: 19, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center' }, oauthIcon: { width: 44, height: 44, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }, oauthCopy: { flex: 1, marginHorizontal: 12 }, oauthTitle: { fontSize: 15, fontWeight: '700' }, oauthStatus: { marginTop: 3, fontSize: 12 }, dividerRow: { marginTop: 27, marginBottom: 2, flexDirection: 'row', alignItems: 'center', gap: 10 }, divider: { flex: 1, height: StyleSheet.hairlineWidth }, dividerText: { fontSize: 12, fontWeight: '600' },
  label: { marginTop: 18, marginBottom: 9, fontSize: 15, fontWeight: '700' }, presets: { gap: 8 }, preset: { minHeight: 46, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' }, presetText: { fontSize: 14, fontWeight: '700' }, input: { minHeight: 52, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, fontSize: 16 }, row: { flexDirection: 'row', gap: 9 }, hostInput: { flex: 1 }, port: { minWidth: 76, borderRadius: 15, alignItems: 'center', justifyContent: 'center' }, portText: { fontSize: 13, fontWeight: '700' },
  note: { minHeight: 80, marginTop: 23, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, noteText: { flex: 1, fontSize: 13, lineHeight: 19 }, saveButton: { minHeight: 54, marginTop: 26, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }, saveText: { fontSize: 16, fontWeight: '700' }, pressed: { opacity: .72 }, disabled: { opacity: .5 },
});
