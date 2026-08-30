import { authenticatedRequest } from '@/src/services/sync';
import type { MailAccount, MailContent, MailMessage } from '@/src/types';

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
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function readEnvelope(value: unknown) {
  if (!isRecord(value) || value.status !== 'success' || !isRecord(value.data)) throw new Error('Сервер вернул некорректный ответ');
  return value.data;
}

function readAccount(value: unknown): MailAccount {
  if (!isRecord(value) || typeof value.id !== 'string' || value.provider !== 'imap' || typeof value.label !== 'string'
    || typeof value.address !== 'string' || typeof value.host !== 'string' || value.port !== 993 || typeof value.username !== 'string'
    || value.label.length > 80 || value.address.length > 320 || value.username.length > 320 || !hostPattern.test(value.host)
    || (value.lastSyncedAt !== undefined && (typeof value.lastSyncedAt !== 'string' || !Number.isFinite(Date.parse(value.lastSyncedAt))))) throw new Error('Сервер вернул некорректный аккаунт');
  return { id: value.id, provider: 'imap', label: value.label, address: value.address, host: value.host, port: 993, username: value.username,
    color: '#167654', ...(typeof value.lastSyncedAt === 'string' ? { lastSyncedAt: value.lastSyncedAt } : {}) };
}

function readMessage(value: unknown): MailMessage {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.accountId !== 'string' || typeof value.sender !== 'string'
    || typeof value.subject !== 'string' || typeof value.preview !== 'string' || typeof value.receivedAt !== 'string'
    || typeof value.unread !== 'boolean' || typeof value.starred !== 'boolean' || value.sender.length > 500 || value.subject.length > 1_000
    || value.preview.length > 300 || !Number.isFinite(Date.parse(value.receivedAt))) throw new Error('Сервер вернул некорректное письмо');
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

export async function synchronizeMail(accountId?: string) {
  if (accountId && !uuidPattern.test(accountId)) throw new Error('Некорректный аккаунт');
  return readSnapshot(await authenticatedRequest<unknown>('/v1/mail/sync', { method: 'POST', body: JSON.stringify(accountId ? { accountId } : {}) }));
}

export async function loadMailAccounts() {
  const data = readEnvelope(await authenticatedRequest<unknown>('/v1/mail/accounts'));
  if (!Array.isArray(data.accounts)) throw new Error('Сервер вернул некорректный список аккаунтов');
  return data.accounts.map(readAccount);
}

export async function loadMailContent(accountId: string, messageId: string): Promise<MailContent> {
  if (!uuidPattern.test(accountId) || !/^[1-9][0-9]{0,19}$/.test(messageId)) throw new Error('Некорректное письмо');
  const data = readEnvelope(await authenticatedRequest<unknown>(`/v1/mail/messages/${accountId}/${messageId}`));
  if (typeof data.body !== 'string' || data.body.length > 200_000 || typeof data.hasAttachments !== 'boolean') throw new Error('Сервер вернул некорректное письмо');
  return { body: data.body, hasAttachments: data.hasAttachments };
}

export async function disconnectMailAccount(accountId: string) {
  if (!uuidPattern.test(accountId)) throw new Error('Некорректный аккаунт');
  await authenticatedRequest<void>(`/v1/mail/accounts/${accountId}`, { method: 'DELETE' });
}
