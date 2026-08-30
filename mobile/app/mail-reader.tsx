import { useEffect, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { loadMailContent } from '@/src/services/mail';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { MailContent } from '@/src/types';
import { formatLongDate, formatTime } from '@/src/utils/date';

export default function MailReaderScreen() {
  const colors = useAppColors(); const router = useRouter();
  const params = useLocalSearchParams<{ accountId?: string; messageId?: string }>();
  const message = useDayDeskStore((state) => state.messages.find((item) => item.accountId === params.accountId && item.id === params.messageId));
  const account = useDayDeskStore((state) => state.accounts.find((item) => item.id === params.accountId));
  const markMailRead = useDayDeskStore((state) => state.markMailRead);
  const [content, setContent] = useState<MailContent>(); const [loading, setLoading] = useState(Boolean(message)); const [error, setError] = useState('');
  const replyTo = message?.replyTo ?? message?.sender.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? (message?.sender.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)?.[0]);
  const reply = () => { if (message && account && replyTo) router.push({ pathname: '/mail-compose', params: { accountId: account.id, to: replyTo, subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`, reply: 'true' } } as never); };

  useEffect(() => {
    if (!message || !params.accountId || !params.messageId) return;
    let active = true;
    markMailRead(message.accountId, message.id);
    void loadMailContent(params.accountId, params.messageId).then((loaded) => { if (active) setContent(loaded); }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить письмо.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [markMailRead, params.accountId, params.messageId]);

  return <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
    <View style={[styles.navigation, { borderBottomColor: colors.border }]}><Pressable accessibilityLabel="Закрыть письмо" accessibilityRole="button" onPress={() => router.back()} style={styles.navButton}><Ionicons name="close" size={25} color={colors.text} /></Pressable><Text numberOfLines={1} style={[styles.navTitle, { color: colors.text }]}>{account?.label ?? 'Письмо'}</Text>{replyTo ? <Pressable accessibilityLabel="Ответить" accessibilityRole="button" onPress={reply} style={styles.navButton}><Ionicons name="arrow-undo-outline" size={23} color={colors.primary} /></Pressable> : <View style={styles.navButton} />}</View>
    {!message ? <View style={styles.center}><Ionicons name="mail-unread-outline" size={38} color={colors.textMuted} /><Text style={[styles.missingTitle, { color: colors.text }]}>Письмо не найдено</Text><Text style={[styles.missingText, { color: colors.textMuted }]}>Обновите входящие и откройте письмо снова.</Text></View> : <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <View style={styles.senderRow}><View style={[styles.avatar, { backgroundColor: colors.primarySoft }]}><Text style={[styles.avatarText, { color: colors.primary }]}>{message.sender.slice(0, 1).toUpperCase()}</Text></View><View style={styles.senderCopy}><Text style={[styles.sender, { color: colors.text }]}>{message.sender}</Text><Text style={[styles.date, { color: colors.textMuted }]}>{formatLongDate(new Date(message.receivedAt))}, {formatTime(message.receivedAt)}</Text></View>{message.starred ? <Ionicons name="star" size={20} color={colors.warning} /> : null}</View>
      <Text style={[styles.subject, { color: colors.text }]}>{message.subject}</Text>
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      {loading ? <View style={styles.loading}><ActivityIndicator color={colors.primary} /><Text style={[styles.status, { color: colors.textMuted }]}>Загружаем содержимое…</Text></View> : error ? <View style={[styles.errorBox, { borderColor: colors.danger }]}><Ionicons name="alert-circle-outline" size={22} color={colors.danger} /><View style={styles.errorCopy}><Text style={[styles.errorTitle, { color: colors.danger }]}>Не удалось загрузить письмо</Text><Text style={[styles.errorText, { color: colors.textMuted }]}>{error}</Text></View></View> : <><Text selectable style={[styles.body, { color: colors.text }]}>{content?.body || message.preview || 'В письме нет текстового содержимого.'}</Text>{content?.hasAttachments ? <View style={[styles.attachmentNote, { backgroundColor: colors.surfaceRaised }]}><Ionicons name="attach-outline" size={21} color={colors.primary} /><Text style={[styles.attachmentText, { color: colors.textMuted }]}>В письме есть вложения. Безопасное скачивание добавим следующим этапом.</Text></View> : null}</>}
      <View style={[styles.security, { backgroundColor: colors.primarySoft }]}><Ionicons name="shield-checkmark-outline" size={21} color={colors.primary} /><Text style={[styles.securityText, { color: colors.textMuted }]}>DayDesk показывает только обычный текст. HTML, скрипты, внешние изображения и пиксели отслеживания не запускаются.</Text></View>
    </ScrollView>}
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 }, navigation: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, navButton: { width: 54, minHeight: 48, alignItems: 'center', justifyContent: 'center' }, navTitle: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700' }, content: { padding: 20, paddingBottom: 42 }, senderRow: { flexDirection: 'row', alignItems: 'center' }, avatar: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' }, avatarText: { fontSize: 19, fontWeight: '800' }, senderCopy: { flex: 1, marginLeft: 12, marginRight: 8 }, sender: { fontSize: 15, lineHeight: 21, fontWeight: '700' }, date: { marginTop: 3, fontSize: 12, lineHeight: 17, textTransform: 'capitalize' }, subject: { marginTop: 24, fontSize: 25, lineHeight: 33, fontWeight: '800' }, divider: { height: StyleSheet.hairlineWidth, marginVertical: 22 }, body: { fontSize: 16, lineHeight: 26 }, loading: { minHeight: 180, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10 }, status: { fontSize: 14 }, errorBox: { minHeight: 92, borderWidth: 1, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, errorCopy: { flex: 1 }, errorTitle: { fontSize: 15, fontWeight: '700' }, errorText: { marginTop: 4, fontSize: 13, lineHeight: 19 }, attachmentNote: { minHeight: 64, marginTop: 24, borderRadius: 17, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 9 }, attachmentText: { flex: 1, fontSize: 13, lineHeight: 19 }, security: { minHeight: 76, marginTop: 28, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, securityText: { flex: 1, fontSize: 12, lineHeight: 18 }, center: { flex: 1, padding: 28, alignItems: 'center', justifyContent: 'center' }, missingTitle: { marginTop: 12, fontSize: 20, fontWeight: '700' }, missingText: { marginTop: 7, fontSize: 14, textAlign: 'center' },
});
