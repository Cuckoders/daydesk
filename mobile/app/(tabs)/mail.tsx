import { useCallback } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppScreen } from '@/components/AppScreen';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { MailMessage, MailProvider } from '@/src/types';
import { formatShortDate, formatTime, isSameDay } from '@/src/utils/date';

const providers: { id: MailProvider; title: string; icon: React.ComponentProps<typeof Ionicons>['name']; color: string }[] = [
  { id: 'gmail', title: 'Gmail', icon: 'logo-google', color: '#D7473F' },
  { id: 'outlook', title: 'Outlook', icon: 'logo-microsoft', color: '#2672EC' },
  { id: 'imap', title: 'Другая почта', icon: 'server-outline', color: '#167654' },
];

export default function MailScreen() {
  const colors = useAppColors();
  const accounts = useDayDeskStore((state) => state.accounts);
  const messages = useDayDeskStore((state) => state.messages);
  const connect = useCallback((provider: MailProvider) => {
    Alert.alert(
      'Подключение почты',
      provider === 'imap'
        ? 'Безопасная форма IMAP/SMTP и хранение пароля в Keychain появятся на следующем этапе.'
        : 'OAuth-вход будет подключён к тому же серверному коннектору, который синхронизирует настольный DayDesk.',
      [{ text: 'Понятно' }],
    );
  }, []);
  const renderMessage = useCallback(({ item }: { item: MailMessage }) => (
    <Pressable
      accessibilityLabel={`Письмо от ${item.sender}: ${item.subject}`}
      accessibilityRole="button"
      android_ripple={{ color: colors.primarySoft }}
      style={[styles.message, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.avatar, { backgroundColor: colors.primarySoft }]}>
        <Text style={[styles.avatarText, { color: colors.primary }]}>{item.sender.slice(0, 1).toUpperCase()}</Text>
      </View>
      <View style={styles.messageBody}>
        <View style={styles.messageTop}>
          <Text numberOfLines={1} style={[styles.sender, { color: colors.text }]}>{item.sender}</Text>
          <Text style={[styles.messageTime, { color: colors.textMuted }]}>{isSameDay(item.receivedAt, new Date()) ? formatTime(item.receivedAt) : formatShortDate(item.receivedAt)}</Text>
        </View>
        <Text numberOfLines={1} style={[styles.subject, { color: colors.text }]}>{item.subject}</Text>
        <Text numberOfLines={2} style={[styles.preview, { color: colors.textMuted }]}>{item.preview}</Text>
      </View>
      {item.unread ? <View accessibilityLabel="Непрочитано" style={[styles.unread, { backgroundColor: colors.primary }]} /> : null}
    </Pressable>
  ), [colors]);

  return (
    <AppScreen>
      <FlatList
        data={messages}
        renderItem={renderMessage}
        keyExtractor={(item) => item.id}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={styles.content}
        ListHeaderComponent={(
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]}>Вся почта</Text>
            <Text style={[styles.subtitle, { color: colors.textMuted }]}>{accounts.length ? `${accounts.length} аккаунта подключено` : 'Соберите входящие в одном месте'}</Text>
            {!accounts.length ? (
              <View style={styles.providerList}>
                {providers.map((provider) => (
                  <Pressable
                    key={provider.id}
                    accessibilityLabel={`Подключить ${provider.title}`}
                    accessibilityRole="button"
                    android_ripple={{ color: colors.primarySoft }}
                    onPress={() => connect(provider.id)}
                    style={[styles.provider, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  >
                    <View style={[styles.providerIcon, { backgroundColor: `${provider.color}18` }]}>
                      <Ionicons name={provider.icon} size={24} color={provider.color} />
                    </View>
                    <Text style={[styles.providerTitle, { color: colors.text }]}>{provider.title}</Text>
                    <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
                  </Pressable>
                ))}
              </View>
            ) : null}
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Входящие</Text>
          </View>
        )}
        ListEmptyComponent={(
          <View style={[styles.empty, { backgroundColor: colors.surfaceRaised }]}>
            <Ionicons name="mail-open-outline" size={34} color={colors.textMuted} />
            <Text style={[styles.emptyTitle, { color: colors.text }]}>Почта пока не подключена</Text>
            <Text style={[styles.emptyText, { color: colors.textMuted }]}>После OAuth-входа здесь появится единый список писем Gmail, Outlook и IMAP.</Text>
          </View>
        )}
        initialNumToRender={10}
        windowSize={5}
        showsVerticalScrollIndicator={false}
      />
    </AppScreen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 16, paddingBottom: 32 },
  header: { paddingTop: 14, paddingBottom: 14 },
  title: { fontSize: 32, lineHeight: 39, fontWeight: '800' },
  subtitle: { marginTop: 3, fontSize: 15, lineHeight: 21 },
  providerList: { gap: 9, marginTop: 20 },
  provider: { minHeight: 66, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' },
  providerIcon: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  providerTitle: { flex: 1, fontSize: 16, fontWeight: '700' },
  sectionTitle: { marginTop: 22, fontSize: 20, lineHeight: 27, fontWeight: '700' },
  message: { minHeight: 92, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, padding: 12, flexDirection: 'row', alignItems: 'center', overflow: 'hidden' },
  avatar: { width: 44, height: 44, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 18, fontWeight: '800' },
  messageBody: { flex: 1, marginLeft: 11 },
  messageTop: { flexDirection: 'row', gap: 8 },
  sender: { flex: 1, fontSize: 14, fontWeight: '700' },
  messageTime: { fontSize: 12 },
  subject: { marginTop: 2, fontSize: 14, fontWeight: '600' },
  preview: { marginTop: 3, fontSize: 13, lineHeight: 18 },
  unread: { width: 8, height: 8, borderRadius: 4, marginLeft: 8 },
  separator: { height: 9 },
  empty: { minHeight: 210, marginTop: 4, borderRadius: 22, padding: 28, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { marginTop: 12, fontSize: 18, fontWeight: '700', textAlign: 'center' },
  emptyText: { marginTop: 7, fontSize: 14, lineHeight: 21, textAlign: 'center' },
});
