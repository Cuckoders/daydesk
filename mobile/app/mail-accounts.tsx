import { useCallback, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { FloatingAddButton } from '@/components/FloatingAddButton';
import { disconnectMailAccount, loadMailAccounts, synchronizeMail } from '@/src/services/mail';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';

export default function MailAccountsScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const accounts = useDayDeskStore((state) => state.accounts);
  const setMailSnapshot = useDayDeskStore((state) => state.setMailSnapshot);
  const removeLocal = useDayDeskStore((state) => state.removeMailAccount);
  const [working, setWorking] = useState(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    void loadMailAccounts().then((loaded) => {
      if (active) setMailSnapshot(loaded, useDayDeskStore.getState().messages.filter((message) => loaded.some((account) => account.id === message.accountId)));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [setMailSnapshot]));

  const refresh = async () => {
    setWorking(true);
    try {
      const snapshot = await synchronizeMail();
      setMailSnapshot(snapshot.accounts, snapshot.messages);
    } catch (error) {
      Alert.alert('Не удалось обновить почту', error instanceof Error ? error.message : 'Попробуйте ещё раз.');
    } finally { setWorking(false); }
  };

  const confirmDelete = (accountId: string, address: string) => Alert.alert('Отключить аккаунт?', `Пароль приложения для ${address} будет безвозвратно удалён с сервера.`, [
    { text: 'Отмена', style: 'cancel' },
    { text: 'Отключить', style: 'destructive', onPress: () => void disconnectMailAccount(accountId).then(() => removeLocal(accountId)).catch((error) => Alert.alert('Не удалось отключить', error instanceof Error ? error.message : 'Попробуйте ещё раз.')) },
  ]);

  return <AppScreen>
    <View style={[styles.navigation, { borderBottomColor: colors.border }]}><Pressable accessibilityLabel="Назад" accessibilityRole="button" onPress={() => router.back()} style={styles.navButton}><Ionicons name="chevron-back" size={26} color={colors.text} /></Pressable><Text style={[styles.navTitle, { color: colors.text }]}>Почтовые аккаунты</Text><Pressable accessibilityLabel="Обновить все аккаунты" accessibilityRole="button" disabled={working || !accounts.length} onPress={() => void refresh()} style={styles.navButton}><Ionicons name="refresh" size={22} color={working ? colors.textMuted : colors.primary} /></Pressable></View>
    <FlatList
      contentContainerStyle={styles.content} data={accounts} keyExtractor={(item) => item.id} ItemSeparatorComponent={() => <View style={styles.separator} />}
      ListHeaderComponent={<View><View style={[styles.security, { backgroundColor: colors.primarySoft }]}><Ionicons name="shield-checkmark-outline" size={23} color={colors.primary} /><Text style={[styles.securityText, { color: colors.textMuted }]}>Пароль передаётся серверу по защищённому соединению, шифруется AES-256-GCM и никогда не сохраняется на телефоне.</Text></View><Text style={[styles.sectionTitle, { color: colors.text }]}>Подключено</Text></View>}
      ListEmptyComponent={<View style={[styles.empty, { backgroundColor: colors.surface }]}><Ionicons name="at-outline" size={34} color={colors.textMuted} /><Text style={[styles.emptyTitle, { color: colors.text }]}>Нет аккаунтов</Text><Text style={[styles.emptyText, { color: colors.textMuted }]}>Поддерживаются Yandex, Mail.ru, iCloud, Gmail с паролем приложения и другие IMAP-серверы.</Text></View>}
      renderItem={({ item }) => <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}><View style={[styles.icon, { backgroundColor: colors.primarySoft }]}><Ionicons name="server-outline" size={22} color={colors.primary} /></View><View style={styles.copy}><Text numberOfLines={1} style={[styles.label, { color: colors.text }]}>{item.label}</Text><Text numberOfLines={1} style={[styles.address, { color: colors.textMuted }]}>{item.address}</Text><Text numberOfLines={1} style={[styles.host, { color: colors.textMuted }]}>{item.host}:993</Text></View><Pressable accessibilityLabel={`Отключить ${item.address}`} accessibilityRole="button" onPress={() => confirmDelete(item.id, item.address)} style={styles.deleteButton}><Ionicons name="trash-outline" size={20} color={colors.danger} /></Pressable></View>}
      showsVerticalScrollIndicator={false}
    />
    <FloatingAddButton label="Добавить почту" onPress={() => router.push('/mail-account-editor' as Href)} />
  </AppScreen>;
}

const styles = StyleSheet.create({
  navigation: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, navButton: { width: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' }, navTitle: { fontSize: 17, fontWeight: '700' },
  content: { padding: 16, paddingBottom: 104 }, security: { minHeight: 82, borderRadius: 19, padding: 15, flexDirection: 'row', alignItems: 'flex-start', gap: 11 }, securityText: { flex: 1, fontSize: 13, lineHeight: 19 }, sectionTitle: { marginTop: 23, marginBottom: 11, fontSize: 20, fontWeight: '700' }, separator: { height: 9 },
  card: { minHeight: 88, borderWidth: StyleSheet.hairlineWidth, borderRadius: 19, padding: 13, flexDirection: 'row', alignItems: 'center' }, icon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }, copy: { flex: 1, marginLeft: 12 }, label: { fontSize: 16, fontWeight: '700' }, address: { marginTop: 3, fontSize: 13 }, host: { marginTop: 2, fontSize: 11 }, deleteButton: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
  empty: { minHeight: 220, borderRadius: 22, padding: 26, alignItems: 'center', justifyContent: 'center' }, emptyTitle: { marginTop: 11, fontSize: 18, fontWeight: '700' }, emptyText: { marginTop: 7, fontSize: 14, lineHeight: 21, textAlign: 'center' },
});
