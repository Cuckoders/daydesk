import { authenticatedRequest } from '@/src/services/sync';
import type { MailAccount, MailContent, MailMessage } from '@/src/types';

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
    || value.preview.length > 300 || !/^[A-Za-z0-9_-]{1,2048}$/.test(value.id) || !uuidPattern.test(value.accountId)
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
  if (!uuidPattern.test(accountId) || !/^[A-Za-z0-9_-]{1,2048}$/.test(messageId)) throw new Error('Некорректное письмо');
  const data = readEnvelope(await authenticatedRequest<unknown>(`/v1/mail/messages/${accountId}/${messageId}`));
  if (typeof data.body !== 'string' || data.body.length > 200_000 || typeof data.hasAttachments !== 'boolean') throw new Error('Сервер вернул некорректное письмо');
  return { body: data.body, hasAttachments: data.hasAttachments };
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
