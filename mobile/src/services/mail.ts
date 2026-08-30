import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { authenticatedRequest } from '@/src/services/sync';
import { recordMailSnapshot } from '@/src/services/mail-checkpoint';
import type { CalendarInvitation, IncomingMailAttachment, MailAccount, MailContent, MailFolder, MailMessage, OutgoingMailAttachment, OutgoingMailInput } from '@/src/types';

export type OAuthMailProvider = 'gmail' | 'outlook';

export interface MailOAuthStart {
  flowId: string;
  authorizationUrl: string;
  expiresAt: string;
}

export interface ConnectImapInput {
  label: string;
  address: string;
  host: string;
  port: 993;
  username: string;
  password: string;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hostPattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const controlCharacters = /[\u0000-\u001f\u007f]/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const attachmentTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const messageIdPattern = /^[A-Za-z0-9_-]{1,2048}$/;
const incomingAttachmentIdPattern = /^[1-9][0-9]{0,2}$/;
const mimeTypePattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function readEnvelope(value: unknown) {
  if (!isRecord(value) || value.status !== 'success' || !isRecord(value.data)) throw new Error('Сервер вернул некорректный ответ');
  return value.data;
}

function readAccount(value: unknown): MailAccount {
  if (!isRecord(value) || typeof value.id !== 'string' || !uuidPattern.test(value.id) || !['imap', 'gmail', 'outlook'].includes(String(value.provider))
    || typeof value.label !== 'string' || typeof value.address !== 'string' || value.label.length > 80 || value.address.length > 320
    || controlCharacters.test(value.label) || !emailPattern.test(value.address)
    || (value.lastSyncedAt !== undefined && (typeof value.lastSyncedAt !== 'string' || !Number.isFinite(Date.parse(value.lastSyncedAt))))) throw new Error('Сервер вернул некорректный аккаунт');
  const provider = value.provider as MailAccount['provider'];
  if (provider === 'imap' && (typeof value.host !== 'string' || value.port !== 993 || typeof value.username !== 'string'
    || value.username.length > 320 || !hostPattern.test(value.host) || controlCharacters.test(value.username))) throw new Error('Сервер вернул некорректный аккаунт');
  return { id: value.id, provider, label: value.label, address: value.address,
    color: provider === 'gmail' ? '#D93025' : provider === 'outlook' ? '#0A64AD' : '#167654',
    ...(provider === 'imap' ? { host: value.host as string, port: 993, username: value.username as string } : {}),
    ...(typeof value.lastSyncedAt === 'string' ? { lastSyncedAt: value.lastSyncedAt } : {}) };
}

function readMessage(value: unknown): MailMessage {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.accountId !== 'string' || typeof value.sender !== 'string'
    || typeof value.subject !== 'string' || typeof value.preview !== 'string' || typeof value.receivedAt !== 'string'
    || typeof value.unread !== 'boolean' || typeof value.starred !== 'boolean' || value.sender.length > 500 || value.subject.length > 1_000
    || value.preview.length > 300 || !messageIdPattern.test(value.id) || !uuidPattern.test(value.accountId)
    || !['inbox', 'sent'].includes(String(value.folder))
    || (value.replyTo !== undefined && (typeof value.replyTo !== 'string' || value.replyTo.length > 320 || !emailPattern.test(value.replyTo)))
    || !Number.isFinite(Date.parse(value.receivedAt))) throw new Error('Сервер вернул некорректное письмо');
  return value as unknown as MailMessage;
}

function readSnapshot(value: unknown) {
  const data = readEnvelope(value);
  if (!Array.isArray(data.accounts) || !Array.isArray(data.messages)) throw new Error('Сервер вернул некорректный список писем');
  return { accounts: data.accounts.map(readAccount), messages: data.messages.map(readMessage), serverTime: typeof data.serverTime === 'string' ? data.serverTime : undefined };
}

export async function connectImap(input: ConnectImapInput) {
  const normalized = { ...input, label: input.label.trim(), address: input.address.trim().toLowerCase(), host: input.host.trim().toLowerCase(), username: input.username.trim() };
  if (!normalized.label || normalized.label.length > 80 || controlCharacters.test(normalized.label)) throw new Error('Проверьте название аккаунта');
  if (!emailPattern.test(normalized.address) || normalized.address.length > 320) throw new Error('Укажите корректный почтовый адрес');
  if (!hostPattern.test(normalized.host)) throw new Error('Укажите корректный IMAP-сервер');
  if (!normalized.username || normalized.username.length > 320 || controlCharacters.test(normalized.username)) throw new Error('Проверьте имя пользователя');
  if (!normalized.password || normalized.password.length > 1024) throw new Error('Введите пароль приложения');
  const data = readEnvelope(await authenticatedRequest<unknown>('/v1/mail/accounts/imap', { method: 'POST', body: JSON.stringify(normalized) }));
  if (!isRecord(data.account) || !Array.isArray(data.messages)) throw new Error('Сервер вернул некорректный ответ');
  return { account: readAccount(data.account), messages: data.messages.map(readMessage) };
}

export async function synchronizeMail(accountId?: string, folder: MailFolder = 'inbox', trackSeen = true) {
  if (accountId && !uuidPattern.test(accountId)) throw new Error('Некорректный аккаунт');
  const snapshot = readSnapshot(await authenticatedRequest<unknown>('/v1/mail/sync', { method: 'POST', body: JSON.stringify({ ...(accountId ? { accountId } : {}), folder }) }));
  if (trackSeen && folder === 'inbox') await recordMailSnapshot(snapshot.messages, snapshot.accounts, !accountId);
  return snapshot;
}

export async function loadMailAccounts() {
  const data = readEnvelope(await authenticatedRequest<unknown>('/v1/mail/accounts'));
  if (!Array.isArray(data.accounts)) throw new Error('Сервер вернул некорректный список аккаунтов');
  return data.accounts.map(readAccount);
}

function readIncomingAttachment(value: unknown): IncomingMailAttachment {
  if (!isRecord(value) || typeof value.id !== 'string' || !incomingAttachmentIdPattern.test(value.id) || typeof value.name !== 'string'
    || !value.name || value.name.length > 255 || controlCharacters.test(value.name) || /[/\\]/.test(value.name)
    || typeof value.mimeType !== 'string' || !mimeTypePattern.test(value.mimeType) || typeof value.size !== 'number'
    || !Number.isInteger(value.size) || value.size < 0 || value.size > 100 * 1024 * 1024 || typeof value.downloadable !== 'boolean') {
    throw new Error('Сервер вернул некорректное вложение');
  }
  return value as unknown as IncomingMailAttachment;
}

export async function loadMailContent(accountId: string, messageId: string, folder: MailFolder = 'inbox'): Promise<MailContent> {
  if (!uuidPattern.test(accountId) || !messageIdPattern.test(messageId)) throw new Error('Некорректное письмо');
  const data = readEnvelope(await authenticatedRequest<unknown>(`/v1/mail/messages/${accountId}/${messageId}?folder=${folder}`, { cache: 'no-store' }));
  if (typeof data.body !== 'string' || data.body.length > 200_000 || typeof data.hasAttachments !== 'boolean' || !Array.isArray(data.attachments)
    || data.attachments.length > 20) throw new Error('Сервер вернул некорректное письмо');
  const attachments = data.attachments.map(readIncomingAttachment);
  if (data.hasAttachments !== (attachments.length > 0)) throw new Error('Сервер вернул некорректное письмо');
  return { body: data.body, hasAttachments: data.hasAttachments, attachments };
}

function decodeBase64(value: string) {
  let binary: string;
  try { binary = atob(value); } catch { throw new Error('Сервер вернул повреждённое вложение'); }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export async function shareMailAttachment(accountId: string, messageId: string, folder: MailFolder, expected: IncomingMailAttachment) {
  if (!uuidPattern.test(accountId) || !messageIdPattern.test(messageId) || !incomingAttachmentIdPattern.test(expected.id) || !expected.downloadable) throw new Error('Это вложение нельзя скачать');
  const data = readEnvelope(await authenticatedRequest<unknown>(`/v1/mail/messages/${accountId}/${messageId}/attachments/${expected.id}?folder=${folder}`, { cache: 'no-store' }));
  if (typeof data.id !== 'string' || data.id !== expected.id || typeof data.name !== 'string' || data.name !== expected.name
    || typeof data.mimeType !== 'string' || data.mimeType !== expected.mimeType || typeof data.size !== 'number' || data.size !== expected.size
    || data.size < 1 || data.size > 2 * 1024 * 1024 || typeof data.data !== 'string' || data.data.length > 2_796_208 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.data)) {
    throw new Error('Сервер вернул некорректное вложение');
  }
  const bytes = decodeBase64(data.data);
  if (bytes.length !== data.size) throw new Error('Вложение загружено не полностью');
  const available = await Sharing.isAvailableAsync();
  if (!available) throw new Error('Системное меню файлов недоступно на этом устройстве');
  const directory = new Directory(Paths.cache, 'daydesk-attachments'); directory.create({ idempotent: true, intermediates: true });
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const name = `${suffix}-${expected.name}`; const file = new File(directory, name);
  file.create();
  try {
    file.write(bytes);
    await Sharing.shareAsync(file.uri, { mimeType: expected.mimeType, dialogTitle: `Сохранить ${expected.name}` });
  } finally {
    bytes.fill(0);
    if (file.exists) file.delete();
  }
}

function validDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function isCalendarInvitation(attachment: IncomingMailAttachment) {
  return attachment.mimeType.toLowerCase() === 'text/calendar' || attachment.name.toLowerCase().endsWith('.ics');
}

export async function loadCalendarInvitation(accountId: string, messageId: string, folder: MailFolder, expected: IncomingMailAttachment): Promise<CalendarInvitation> {
  if (!uuidPattern.test(accountId) || !messageIdPattern.test(messageId) || !incomingAttachmentIdPattern.test(expected.id)
    || !expected.downloadable || expected.size < 1 || expected.size > 256 * 1024 || !isCalendarInvitation(expected)) {
    throw new Error('Это приглашение нельзя импортировать');
  }
  const data = readEnvelope(await authenticatedRequest<unknown>(`/v1/mail/messages/${accountId}/${messageId}/attachments/${expected.id}/invitation?folder=${folder}`, { cache: 'no-store' }));
  if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 300 || controlCharacters.test(data.title)
    || !validIsoTimestamp(data.startsAt) || !validIsoTimestamp(data.endsAt) || Date.parse(data.endsAt) <= Date.parse(data.startsAt)
    || Date.parse(data.endsAt) - Date.parse(data.startsAt) > 31 * 86_400_000 || typeof data.allDay !== 'boolean'
    || (data.location !== undefined && (typeof data.location !== 'string' || data.location.length > 500 || controlCharacters.test(data.location)))) {
    throw new Error('Сервер вернул некорректное приглашение');
  }
  if (data.allDay) {
    if (!validDateOnly(data.allDayStartDate) || !validDateOnly(data.allDayEndDate) || data.allDayEndDate <= data.allDayStartDate) {
      throw new Error('Сервер вернул некорректное приглашение');
    }
  } else if (data.allDayStartDate !== undefined || data.allDayEndDate !== undefined) throw new Error('Сервер вернул некорректное приглашение');
  return data as unknown as CalendarInvitation;
}

export async function disconnectMailAccount(accountId: string) {
  if (!uuidPattern.test(accountId)) throw new Error('Некорректный аккаунт');
  await authenticatedRequest<void>(`/v1/mail/accounts/${accountId}`, { method: 'DELETE' });
}

export async function loadMailOAuthProviders(): Promise<OAuthMailProvider[]> {
  const data = readEnvelope(await authenticatedRequest<unknown>('/v1/mail/oauth/providers'));
  if (!Array.isArray(data.providers) || !data.providers.every((provider) => provider === 'gmail' || provider === 'outlook')) {
    throw new Error('Сервер вернул некорректный список OAuth-провайдеров');
  }
  return [...new Set(data.providers)] as OAuthMailProvider[];
}

export async function startMailOAuth(provider: OAuthMailProvider): Promise<MailOAuthStart> {
  const data = readEnvelope(await authenticatedRequest<unknown>('/v1/mail/oauth/start', { method: 'POST', body: JSON.stringify({ provider }) }));
  if (typeof data.flowId !== 'string' || !uuidPattern.test(data.flowId) || typeof data.authorizationUrl !== 'string'
    || typeof data.expiresAt !== 'string' || !Number.isFinite(Date.parse(data.expiresAt))) throw new Error('Сервер вернул некорректный OAuth-запрос');
  const authorizationUrl = new URL(data.authorizationUrl);
  const expectedHost = provider === 'gmail' ? 'accounts.google.com' : 'login.microsoftonline.com';
  if (authorizationUrl.protocol !== 'https:' || authorizationUrl.hostname !== expectedHost || authorizationUrl.username || authorizationUrl.password) {
    throw new Error('Сервер вернул небезопасный адрес входа');
  }
  return { flowId: data.flowId, authorizationUrl: authorizationUrl.toString(), expiresAt: data.expiresAt };
}

export async function loadMailOAuthStatus(flowId: string): Promise<{ status: 'pending' | 'completed' | 'failed'; account?: MailAccount }> {
  if (!uuidPattern.test(flowId)) throw new Error('Некорректный OAuth-запрос');
  const data = readEnvelope(await authenticatedRequest<unknown>(`/v1/mail/oauth/status/${flowId}`));
  if (!['pending', 'completed', 'failed'].includes(String(data.status))) throw new Error('Сервер вернул некорректный OAuth-статус');
  if (data.status === 'completed') {
    if (!data.account) throw new Error('Сервер не вернул подключённый аккаунт');
    return { status: 'completed', account: readAccount(data.account) };
  }
  return { status: data.status as 'pending' | 'failed' };
}

export async function waitForMailOAuth(flow: MailOAuthStart, timeoutMs = 30_000): Promise<MailAccount> {
  const deadline = Math.min(Date.parse(flow.expiresAt), Date.now() + timeoutMs);
  while (Date.now() < deadline) {
    const result = await loadMailOAuthStatus(flow.flowId);
    if (result.status === 'completed' && result.account) return result.account;
    if (result.status === 'failed') throw new Error('Вход в почту не был завершён');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error('Не удалось подтвердить вход. Закройте окно браузера после сообщения DayDesk и повторите.');
}

function readOutgoingAttachment(value: unknown): OutgoingMailAttachment {
  if (!isRecord(value) || typeof value.token !== 'string' || !attachmentTokenPattern.test(value.token) || typeof value.name !== 'string'
    || !value.name || value.name.length > 255 || controlCharacters.test(value.name) || typeof value.mimeType !== 'string'
    || value.mimeType.length > 255 || typeof value.size !== 'number' || !Number.isInteger(value.size) || value.size < 1 || value.size > 2 * 1024 * 1024) {
    throw new Error('Сервер вернул некорректное вложение');
  }
  return value as unknown as OutgoingMailAttachment;
}

export async function uploadMailAttachment(input: { uri: string; name: string; mimeType?: string; size?: number }) {
  const name = input.name.trim(); const mimeType = input.mimeType?.trim().toLowerCase() || 'application/octet-stream';
  if (!name || name.length > 255 || controlCharacters.test(name) || /[/\\]/.test(name)) throw new Error('Некорректное имя файла');
  if (!/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/.test(mimeType)) throw new Error('Некорректный тип файла');
  if (input.size !== undefined && (!Number.isInteger(input.size) || input.size < 1 || input.size > 2 * 1024 * 1024)) throw new Error('Файл превышает лимит 2 МБ');
  const file = new File(input.uri);
  if (!file.size || file.size > 2 * 1024 * 1024) throw new Error('Файл превышает лимит 2 МБ');
  const data = await file.base64();
  const response = readEnvelope(await authenticatedRequest<unknown>('/v1/mail/attachments', { method: 'POST', body: JSON.stringify({ name, mimeType, data }) }));
  return readOutgoingAttachment(response);
}

export async function discardMailAttachments(tokens: string[]) {
  if (tokens.length > 10 || tokens.some((token) => !attachmentTokenPattern.test(token))) throw new Error('Некорректные вложения');
  if (tokens.length) await authenticatedRequest<void>('/v1/mail/attachments', { method: 'DELETE', body: JSON.stringify({ tokens }) });
}

export async function sendMail(input: OutgoingMailInput) {
  const recipients = [...input.to, ...input.cc, ...input.bcc];
  if (!uuidPattern.test(input.accountId) || !input.to.length || recipients.length > 25 || recipients.some((address) => !emailPattern.test(address) || address.length > 320)) throw new Error('Проверьте адреса получателей');
  if (new Set(recipients.map((address) => address.toLowerCase())).size !== recipients.length) throw new Error('Удалите повторяющиеся адреса');
  if (input.subject.length > 500 || controlCharacters.test(input.subject) || input.body.length > 200_000 || input.body.includes('\0')) throw new Error('Тема или текст письма некорректны');
  if (input.attachmentTokens.length > 10 || input.attachmentTokens.some((token) => !attachmentTokenPattern.test(token)) || (!input.body.trim() && !input.attachmentTokens.length)) throw new Error('Добавьте текст или вложение');
  const data = readEnvelope(await authenticatedRequest<unknown>('/v1/mail/send', { method: 'POST', body: JSON.stringify(input) }));
  if (data.accepted !== true) throw new Error('Сервер не подтвердил отправку');
}
