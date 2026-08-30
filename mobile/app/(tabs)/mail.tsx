import { useCallback, useMemo, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { synchronizeMail } from '@/src/services/mail';
import { clearNewMailNotification } from '@/src/services/notifications';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { MailFolder, MailMessage } from '@/src/types';
import { formatShortDate, formatTime, isSameDay } from '@/src/utils/date';

export default function MailScreen() {
  const colors = useAppColors();
  const router = useRouter();
  const accounts = useDayDeskStore((state) => state.accounts);
  const messages = useDayDeskStore((state) => state.messages);
  const setMailSnapshot = useDayDeskStore((state) => state.setMailSnapshot);
  const [query, setQuery] = useState('');
  const [selectedAccount, setSelectedAccount] = useState<string>();
  const [folder, setFolder] = useState<MailFolder>('inbox');
  const [refreshing, setRefreshing] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);

  const refresh = useCallback(async (silent = false, targetFolder: MailFolder = folder) => {
    if (!silent) setRefreshing(true);
    try {
      const snapshot = await synchronizeMail(undefined, targetFolder);
      const current = useDayDeskStore.getState();
      setMailSnapshot(snapshot.accounts, [...current.messages.filter((item) => item.folder !== targetFolder), ...snapshot.messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)));
      setLoadedOnce(true);
    } catch (error) {
      setLoadedOnce(true);
      if (!silent) Alert.alert('Не удалось обновить почту', error instanceof Error ? error.message : 'Попробуйте ещё раз.');
    } finally {
      if (!silent) setRefreshing(false);
    }
  }, [folder, setMailSnapshot]);

  useFocusEffect(useCallback(() => {
    void clearNewMailNotification();
    if (!loadedOnce) void refresh(true);
  }, [loadedOnce, refresh]));

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('ru-RU');
    return messages.filter((message) => message.folder === folder && (!selectedAccount || message.accountId === selectedAccount)
      && (!normalized || [message.sender, message.subject, message.preview].some((value) => value.toLocaleLowerCase('ru-RU').includes(normalized))));
  }, [folder, messages, query, selectedAccount]);

  const openMessage = useCallback((message: MailMessage) => router.push({
    pathname: '/mail-reader', params: { accountId: message.accountId, messageId: message.id, folder: message.folder },
  } as unknown as Href), [router]);

  const renderMessage = useCallback(({ item }: { item: MailMessage }) => (
    <Pressable accessibilityLabel={`Письмо от ${item.sender}: ${item.subject}`} accessibilityRole="button" android_ripple={{ color: colors.primarySoft }} onPress={() => openMessage(item)} style={[styles.message, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={[styles.avatar, { backgroundColor: colors.primarySoft }]}><Text style={[styles.avatarText, { color: colors.primary }]}>{item.sender.slice(0, 1).toUpperCase()}</Text></View>
      <View style={styles.messageBody}>
        <View style={styles.messageTop}><Text numberOfLines={1} style={[styles.sender, { color: colors.text }, item.unread && styles.unreadText]}>{item.sender}</Text><Text style={[styles.messageTime, { color: colors.textMuted }]}>{isSameDay(item.receivedAt, new Date()) ? formatTime(item.receivedAt) : formatShortDate(item.receivedAt)}</Text></View>
        <Text numberOfLines={1} style={[styles.subject, { color: colors.text }, item.unread && styles.unreadText]}>{item.subject}</Text>
        <Text numberOfLines={2} style={[styles.preview, { color: colors.textMuted }]}>{item.preview || 'Откройте письмо, чтобы прочитать содержимое'}</Text>
      </View>
      {item.starred ? <Ionicons name="star" size={16} color={colors.warning} /> : item.unread ? <View accessibilityLabel="Непрочитано" style={[styles.unread, { backgroundColor: colors.primary }]} /> : null}
    </Pressable>
  ), [colors, openMessage]);

  return (
    <AppScreen>
      <FlatList
        data={filtered} renderItem={renderMessage} keyExtractor={(item) => `${item.accountId}:${item.id}`}
        ItemSeparatorComponent={() => <View style={styles.separator} />} contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.primary} colors={[colors.primary]} />}
        ListHeaderComponent={<View style={styles.header}>
          <View style={styles.titleRow}><View style={styles.titleCopy}><Text style={[styles.title, { color: colors.text }]}>Вся почта</Text><Text style={[styles.subtitle, { color: colors.textMuted }]}>{accounts.length ? `${accounts.length} аккаунтов · ${messages.filter((item) => item.folder === 'inbox' && item.unread).length} непрочитанных` : 'Соберите входящие в одном месте'}</Text></View>{accounts.length ? <Pressable accessibilityLabel="Новое письмо" accessibilityRole="button" onPress={() => router.push('/mail-compose' as Href)} style={[styles.settingsButton, { backgroundColor: colors.primarySoft }]}><Ionicons name="create-outline" size={22} color={colors.primary} /></Pressable> : null}<Pressable accessibilityLabel="Почтовые аккаунты" accessibilityRole="button" onPress={() => router.push('/mail-accounts' as Href)} style={[styles.settingsButton, { backgroundColor: colors.surface }]}><Ionicons name="settings-outline" size={22} color={colors.primary} /></Pressable></View>
          <View accessibilityRole="tablist" style={[styles.folderTabs, { backgroundColor: colors.surface }]}>{(['inbox', 'sent'] as const).map((item) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: folder === item }} onPress={() => { setFolder(item); void refresh(false, item); }} style={[styles.folderTab, folder === item && { backgroundColor: colors.primarySoft }]}><Ionicons name={item === 'inbox' ? 'mail-outline' : 'paper-plane-outline'} size={18} color={folder === item ? colors.primary : colors.textMuted} /><Text style={[styles.folderText, { color: folder === item ? colors.primary : colors.textMuted }]}>{item === 'inbox' ? 'Входящие' : 'Отправленные'}</Text></Pressable>)}</View>
          <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}><Ionicons name="search-outline" size={20} color={colors.textMuted} /><TextInput accessibilityLabel="Поиск по почте" autoCorrect={false} onChangeText={setQuery} placeholder="Отправитель, тема или текст" placeholderTextColor={colors.textMuted} returnKeyType="search" style={[styles.searchInput, { color: colors.text }]} value={query} />{query ? <Pressable accessibilityLabel="Очистить поиск" accessibilityRole="button" onPress={() => setQuery('')} style={styles.clearButton}><Ionicons name="close-circle" size={19} color={colors.textMuted} /></Pressable> : null}</View>
          {accounts.length > 1 ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}><Pressable accessibilityRole="radio" accessibilityState={{ checked: !selectedAccount }} onPress={() => setSelectedAccount(undefined)} style={[styles.filter, { backgroundColor: !selectedAccount ? colors.primarySoft : colors.surface, borderColor: !selectedAccount ? colors.primary : colors.border }]}><Text style={[styles.filterText, { color: !selectedAccount ? colors.primary : colors.text }]}>Все</Text></Pressable>{accounts.map((account) => <Pressable key={account.id} accessibilityRole="radio" accessibilityState={{ checked: selectedAccount === account.id }} onPress={() => setSelectedAccount(account.id)} style={[styles.filter, { backgroundColor: selectedAccount === account.id ? colors.primarySoft : colors.surface, borderColor: selectedAccount === account.id ? colors.primary : colors.border }]}><Text style={[styles.filterText, { color: selectedAccount === account.id ? colors.primary : colors.text }]}>{account.label}</Text></Pressable>)}</ScrollView> : null}
          <Text style={[styles.sectionTitle, { color: colors.text }]}>{folder === 'inbox' ? 'Входящие' : 'Отправленные'}</Text>
        </View>}
        ListEmptyComponent={<View style={[styles.empty, { backgroundColor: colors.surfaceRaised }]}><Ionicons name={query ? 'search-outline' : folder === 'inbox' ? 'mail-open-outline' : 'paper-plane-outline'} size={34} color={colors.textMuted} /><Text style={[styles.emptyTitle, { color: colors.text }]}>{query ? 'Ничего не найдено' : accounts.length ? folder === 'inbox' ? 'Входящие пусты' : 'Отправленных писем нет' : 'Почта пока не подключена'}</Text><Text style={[styles.emptyText, { color: colors.textMuted }]}>{accounts.length ? 'Потяните экран вниз, чтобы обновить письма.' : 'Подключите Gmail, Outlook или IMAP через защищённый DayDesk Sync Server.'}</Text>{!accounts.length ? <Pressable accessibilityRole="button" onPress={() => router.push('/mail-accounts' as Href)} style={[styles.connectButton, { backgroundColor: colors.primary }]}><Text style={[styles.connectText, { color: colors.onPrimary }]}>Подключить почту</Text></Pressable> : null}</View>}
        initialNumToRender={12} windowSize={7} showsVerticalScrollIndicator={false}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 32 }, header: { paddingTop: 14, paddingBottom: 14 }, titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 }, titleCopy: { flex: 1 }, title: { fontSize: 32, lineHeight: 39, fontWeight: '800' }, subtitle: { marginTop: 3, fontSize: 14, lineHeight: 20 }, settingsButton: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  search: { minHeight: 52, marginTop: 18, borderWidth: StyleSheet.hairlineWidth, borderRadius: 17, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center' }, searchInput: { flex: 1, minHeight: 50, marginLeft: 9, fontSize: 15 }, clearButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  folderTabs: { minHeight: 52, marginTop: 14, borderRadius: 17, padding: 4, flexDirection: 'row', gap: 4 }, folderTab: { flex: 1, minHeight: 44, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 }, folderText: { fontSize: 13, fontWeight: '700' },
  filters: { gap: 8, paddingTop: 12 }, filter: { minHeight: 44, borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center' }, filterText: { fontSize: 13, fontWeight: '700' }, sectionTitle: { marginTop: 20, fontSize: 20, lineHeight: 27, fontWeight: '700' },
  message: { minHeight: 94, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 12, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' }, avatar: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center' }, avatarText: { fontSize: 18, fontWeight: '800' }, messageBody: { flex: 1, marginLeft: 11 }, messageTop: { flexDirection: 'row', gap: 8 }, sender: { flex: 1, fontSize: 14, fontWeight: '600' }, messageTime: { fontSize: 12 }, subject: { marginTop: 2, fontSize: 14, fontWeight: '500' }, preview: { marginTop: 3, fontSize: 13, lineHeight: 18 }, unreadText: { fontWeight: '800' }, unread: { width: 8, height: 8, borderRadius: 4, marginLeft: 8 }, separator: { height: 9 },
  empty: { minHeight: 240, marginTop: 4, borderRadius: 22, padding: 28, alignItems: 'center', justifyContent: 'center' }, emptyTitle: { marginTop: 12, fontSize: 18, fontWeight: '700', textAlign: 'center' }, emptyText: { marginTop: 7, fontSize: 14, lineHeight: 21, textAlign: 'center' }, connectButton: { minHeight: 50, marginTop: 18, borderRadius: 16, paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' }, connectText: { fontSize: 15, fontWeight: '700' },
});
