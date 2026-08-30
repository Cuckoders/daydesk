import { useEffect, useRef, useState } from 'react';
import { Ionicons } from '@expo/vector-icons';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { discardMailAttachments, sendMail, uploadMailAttachment } from '@/src/services/mail';
import { useDayDeskStore } from '@/src/store/useDayDeskStore';
import { useAppColors } from '@/src/theme';
import type { OutgoingMailAttachment } from '@/src/types';

const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const recipients = (value: string) => value.split(/[;,]/).map((item) => item.trim().toLowerCase()).filter(Boolean);
const fileSize = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`;

export default function MailComposeScreen() {
  const colors = useAppColors(); const router = useRouter();
  const params = useLocalSearchParams<{ accountId?: string; to?: string; subject?: string; reply?: string }>();
  const accounts = useDayDeskStore((state) => state.accounts);
  const initialAccount = accounts.some((item) => item.id === params.accountId) ? params.accountId ?? '' : accounts[0]?.id ?? '';
  const [accountId, setAccountId] = useState(initialAccount); const [to, setTo] = useState(typeof params.to === 'string' ? params.to.slice(0, 4_000) : '');
  const [cc, setCc] = useState(''); const [bcc, setBcc] = useState(''); const [subject, setSubject] = useState(typeof params.subject === 'string' ? params.subject.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500) : '');
  const [body, setBody] = useState(''); const [attachments, setAttachments] = useState<OutgoingMailAttachment[]>([]);
  const [choosing, setChoosing] = useState(false); const [confirming, setConfirming] = useState(false); const [sending, setSending] = useState(false); const [error, setError] = useState('');
  const tokensRef = useRef<string[]>([]); const mountedRef = useRef(true);
  const selectedAccount = accounts.find((item) => item.id === accountId);

  useEffect(() => { tokensRef.current = attachments.map((item) => item.token); }, [attachments]);
  useEffect(() => () => { mountedRef.current = false; const tokens = tokensRef.current; if (tokens.length) void discardMailAttachments(tokens).catch(() => undefined); }, []);

  const close = () => { if (!sending) router.back(); };
  const removeAttachment = (token: string) => {
    setAttachments((current) => current.filter((item) => item.token !== token));
    void discardMailAttachments([token]).catch(() => undefined);
  };
  const chooseAttachments = async () => {
    setChoosing(true); setError('');
    const uploaded: OutgoingMailAttachment[] = [];
    try {
      const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true, type: '*/*' });
      if (result.canceled) return;
      const total = attachments.reduce((sum, item) => sum + item.size, 0) + result.assets.reduce((sum, item) => sum + (item.size ?? 0), 0);
      if (attachments.length + result.assets.length > 10 || total > MAX_ATTACHMENT_BYTES) throw new Error('Можно прикрепить до 10 файлов общим размером не больше 2 МБ');
      for (const asset of result.assets) {
        uploaded.push(await uploadMailAttachment({ uri: asset.uri, name: asset.name, ...(asset.mimeType ? { mimeType: asset.mimeType } : {}), ...(asset.size ? { size: asset.size } : {}) }));
        if (!mountedRef.current) throw new Error('Экран письма закрыт');
      }
      setAttachments((current) => [...current, ...uploaded]);
    } catch (reason) {
      if (uploaded.length) await discardMailAttachments(uploaded.map((item) => item.token)).catch(() => undefined);
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : 'Не удалось добавить вложения');
    } finally { if (mountedRef.current) setChoosing(false); }
  };
  const review = () => {
    setError('');
    const all = [...recipients(to), ...recipients(cc), ...recipients(bcc)];
    if (!selectedAccount) return setError('Выберите аккаунт отправителя');
    if (!recipients(to).length || all.length > 25 || all.some((item) => !emailPattern.test(item))) return setError('Проверьте адреса. Разделяйте их запятыми');
    if (new Set(all).size !== all.length) return setError('Удалите повторяющиеся адреса');
    if (!body.trim() && !attachments.length) return setError('Добавьте текст или вложение');
    setConfirming(true);
  };
  const deliver = async () => {
    if (!selectedAccount) return;
    setSending(true); setError('');
    try {
      await sendMail({ accountId: selectedAccount.id, to: recipients(to), cc: recipients(cc), bcc: recipients(bcc), subject: subject.trim(), body, attachmentTokens: attachments.map((item) => item.token) });
      tokensRef.current = [];
      if (!mountedRef.current) return;
      setAttachments([]);
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      Alert.alert('Письмо принято', 'Почтовый сервис принял его к отправке.', [{ text: 'Готово', onPress: () => router.back() }]);
    } catch (reason) { if (mountedRef.current) { setError(reason instanceof Error ? reason.message : 'Не удалось отправить письмо'); setConfirming(false); } }
    finally { if (mountedRef.current) setSending(false); }
  };

  return <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.flex}>
    <View style={[styles.navigation, { borderBottomColor: colors.border }]}><Pressable accessibilityLabel="Закрыть письмо" accessibilityRole="button" disabled={sending} onPress={close} style={styles.navButton}><Ionicons name="close" size={25} color={colors.text} /></Pressable><Text style={[styles.navTitle, { color: colors.text }]}>{params.reply === 'true' ? 'Ответ' : 'Новое письмо'}</Text><Pressable accessibilityLabel="Проверить письмо" accessibilityRole="button" disabled={sending} onPress={review} style={styles.navButton}><Text style={[styles.reviewText, { color: colors.primary }]}>Далее</Text></Pressable></View>
    {confirming ? <ScrollView contentContainerStyle={styles.confirmation}><View style={[styles.confirmIcon, { backgroundColor: colors.primarySoft }]}><Ionicons name="send" size={26} color={colors.primary} /></View><Text style={[styles.confirmTitle, { color: colors.text }]}>Отправить это письмо?</Text><View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>{[['От кого', selectedAccount?.address ?? '—'], ['Кому', recipients(to).join(', ')], ['Тема', subject.trim() || 'Без темы'], ['Вложения', attachments.length ? `${attachments.length}, ${fileSize(attachments.reduce((sum, item) => sum + item.size, 0))}` : 'Нет']].map(([label, value]) => <View key={label} style={[styles.summaryRow, { borderBottomColor: colors.border }]}><Text style={[styles.summaryLabel, { color: colors.textMuted }]}>{label}</Text><Text selectable style={[styles.summaryValue, { color: colors.text }]}>{value}</Text></View>)}</View><View style={[styles.warning, { backgroundColor: colors.primarySoft }]}><Ionicons name="shield-checkmark-outline" size={22} color={colors.primary} /><Text style={[styles.warningText, { color: colors.textMuted }]}>После подтверждения DayDesk сразу передаст письмо провайдеру. Отменить это нельзя.</Text></View>{error ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}<View style={styles.actions}><Pressable accessibilityRole="button" disabled={sending} onPress={() => setConfirming(false)} style={[styles.secondary, { borderColor: colors.border }]}><Text style={[styles.secondaryText, { color: colors.text }]}>Вернуться</Text></Pressable><Pressable accessibilityRole="button" disabled={sending} onPress={() => void deliver()} style={[styles.primary, { backgroundColor: colors.primary }, sending && styles.disabled]}><Text style={[styles.primaryText, { color: colors.onPrimary }]}>{sending ? 'Отправляем…' : 'Да, отправить'}</Text></Pressable></View></ScrollView> : <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
      <Text style={[styles.label, { color: colors.text }]}>От кого</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.accounts}>{accounts.map((account) => <Pressable key={account.id} accessibilityRole="radio" accessibilityState={{ checked: account.id === accountId }} onPress={() => setAccountId(account.id)} style={[styles.account, { backgroundColor: account.id === accountId ? colors.primarySoft : colors.surface, borderColor: account.id === accountId ? colors.primary : colors.border }]}><Text numberOfLines={1} style={[styles.accountText, { color: account.id === accountId ? colors.primary : colors.text }]}>{account.label} · {account.address}</Text></Pressable>)}</ScrollView>
      <Text style={[styles.label, { color: colors.text }]}>Кому</Text><TextInput accessibilityLabel="Получатели" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={4_000} onChangeText={setTo} placeholder="name@example.com" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={to} />
      <View style={styles.copies}><View style={styles.copyField}><Text style={[styles.label, { color: colors.text }]}>Копия</Text><TextInput accessibilityLabel="Копия" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={4_000} onChangeText={setCc} placeholder="Необязательно" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={cc} /></View><View style={styles.copyField}><Text style={[styles.label, { color: colors.text }]}>Скрытая</Text><TextInput accessibilityLabel="Скрытая копия" autoCapitalize="none" autoCorrect={false} keyboardType="email-address" maxLength={4_000} onChangeText={setBcc} placeholder="Необязательно" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={bcc} /></View></View>
      <Text style={[styles.label, { color: colors.text }]}>Тема</Text><TextInput accessibilityLabel="Тема письма" maxLength={500} onChangeText={setSubject} placeholder="О чём письмо" placeholderTextColor={colors.textMuted} style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} value={subject} />
      <Text style={[styles.label, { color: colors.text }]}>Текст</Text><TextInput accessibilityLabel="Текст письма" maxLength={200_000} multiline onChangeText={setBody} placeholder="Напишите сообщение…" placeholderTextColor={colors.textMuted} style={[styles.input, styles.bodyInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text }]} textAlignVertical="top" value={body} />
      <View style={styles.attachmentHeader}><View style={styles.attachmentCopy}><Text style={[styles.label, styles.noMargin, { color: colors.text }]}>Вложения</Text><Text style={[styles.attachmentHint, { color: colors.textMuted }]}>До 10 файлов, всего до 2 МБ</Text></View><Pressable accessibilityLabel="Добавить вложения" accessibilityRole="button" disabled={choosing || sending} onPress={() => void chooseAttachments()} style={[styles.attachButton, { borderColor: colors.border }]}><Ionicons name="attach" size={20} color={colors.primary} /><Text style={[styles.attachText, { color: colors.primary }]}>{choosing ? 'Загружаем…' : 'Добавить'}</Text></Pressable></View>
      {attachments.map((item) => <View key={item.token} style={[styles.file, { backgroundColor: colors.surface, borderColor: colors.border }]}><Ionicons name="document-outline" size={22} color={colors.primary} /><View style={styles.fileCopy}><Text numberOfLines={1} style={[styles.fileName, { color: colors.text }]}>{item.name}</Text><Text style={[styles.fileMeta, { color: colors.textMuted }]}>{fileSize(item.size)} · {item.mimeType}</Text></View><Pressable accessibilityLabel={`Убрать ${item.name}`} accessibilityRole="button" onPress={() => removeAttachment(item.token)} style={styles.removeButton}><Ionicons name="close" size={21} color={colors.danger} /></Pressable></View>)}
      {error ? <Text accessibilityRole="alert" style={[styles.error, { color: colors.danger }]}>{error}</Text> : null}<Text style={[styles.draftNote, { color: colors.textMuted }]}>Черновик и файлы не сохраняются после закрытия экрана.</Text><Pressable accessibilityRole="button" onPress={review} style={[styles.fullButton, { backgroundColor: colors.primary }]}><Text style={[styles.primaryText, { color: colors.onPrimary }]}>Проверить и отправить</Text></Pressable>
    </ScrollView>}
  </KeyboardAvoidingView></SafeAreaView>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 }, flex: { flex: 1 }, navigation: { minHeight: 58, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, navButton: { minWidth: 58, minHeight: 48, alignItems: 'center', justifyContent: 'center' }, navTitle: { fontSize: 17, fontWeight: '700' }, reviewText: { fontSize: 15, fontWeight: '700' }, content: { padding: 16, paddingBottom: 42 }, label: { marginTop: 18, marginBottom: 8, fontSize: 14, fontWeight: '700' }, accounts: { gap: 8 }, account: { minHeight: 46, maxWidth: 280, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, justifyContent: 'center' }, accountText: { fontSize: 13, fontWeight: '700' }, input: { minHeight: 52, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 13, fontSize: 16 }, bodyInput: { minHeight: 190, paddingTop: 13 }, copies: { flexDirection: 'row', gap: 10 }, copyField: { flex: 1 }, attachmentHeader: { marginTop: 24, flexDirection: 'row', alignItems: 'center', gap: 12 }, attachmentCopy: { flex: 1 }, noMargin: { marginTop: 0, marginBottom: 2 }, attachmentHint: { fontSize: 12 }, attachButton: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderRadius: 15, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', gap: 6 }, attachText: { fontSize: 13, fontWeight: '700' }, file: { minHeight: 64, marginTop: 9, borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 11, flexDirection: 'row', alignItems: 'center' }, fileCopy: { flex: 1, marginLeft: 10 }, fileName: { fontSize: 14, fontWeight: '700' }, fileMeta: { marginTop: 3, fontSize: 11 }, removeButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }, error: { marginTop: 15, fontSize: 13, lineHeight: 19, fontWeight: '600' }, draftNote: { marginTop: 22, fontSize: 12, lineHeight: 18, textAlign: 'center' }, fullButton: { minHeight: 54, marginTop: 14, borderRadius: 17, alignItems: 'center', justifyContent: 'center' }, primaryText: { fontSize: 15, fontWeight: '700' }, confirmation: { flexGrow: 1, padding: 24, paddingBottom: 40 }, confirmIcon: { width: 58, height: 58, borderRadius: 18, alignItems: 'center', justifyContent: 'center' }, confirmTitle: { marginTop: 18, fontSize: 26, lineHeight: 34, fontWeight: '800' }, summary: { marginTop: 22, borderWidth: StyleSheet.hairlineWidth, borderRadius: 18, overflow: 'hidden' }, summaryRow: { minHeight: 62, borderBottomWidth: StyleSheet.hairlineWidth, padding: 12, flexDirection: 'row', gap: 14 }, summaryLabel: { width: 76, fontSize: 12, fontWeight: '700' }, summaryValue: { flex: 1, fontSize: 14, lineHeight: 20 }, warning: { minHeight: 84, marginTop: 18, borderRadius: 18, padding: 14, flexDirection: 'row', alignItems: 'flex-start', gap: 10 }, warningText: { flex: 1, fontSize: 13, lineHeight: 19 }, actions: { marginTop: 'auto', paddingTop: 26, flexDirection: 'row', gap: 10 }, secondary: { minHeight: 54, borderWidth: StyleSheet.hairlineWidth, borderRadius: 17, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }, secondaryText: { fontSize: 14, fontWeight: '700' }, primary: { minHeight: 54, flex: 1, borderRadius: 17, paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center' }, disabled: { opacity: .5 },
});
