import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

import { simpleParser } from 'mailparser';

import type { ServerConfig } from './config.js';
import type { DayDeskDatabase } from './database.js';
import { decryptSecret, encryptSecret, MailConfigurationError, MailConnectionError, MailNotFoundError } from './mail-service.js';
import type { MailAccount, MailContent, MailMessage } from './types.js';

export type OAuthMailProvider = 'gmail' | 'outlook';
type OAuthFlowStatus = 'pending' | 'processing' | 'completed' | 'failed';

const FLOW_TTL_MS = 10 * 60_000;
const API_TIMEOUT_MS = 30_000;
const MESSAGE_LIMIT = 20;
const ACCOUNT_LIMIT = 20;
const MAX_JSON_BYTES = 3 * 1024 * 1024;
const MAX_BODY_CHARACTERS = 200_000;
const tokenTextLimit = 32_768;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const safeText = (value: string, limit: number) => value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, limit);
const safeBody = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_BODY_CHARACTERS);

interface OAuthAccountRow {
  id: string;
  provider: OAuthMailProvider;
  label: string;
  address: string;
  encryptedTokens: string;
  lastSyncedAt: string | null;
}

interface OAuthFlowRow {
  id: string;
  provider: OAuthMailProvider;
  deviceId: string;
  stateHash: string;
  encryptedVerifier: string;
  status: OAuthFlowStatus;
  accountId: string | null;
  expiresAt: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
}

interface OAuthProfile { address: string; label: string }

export interface OAuthProviderAdapter {
  authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string;
  exchangeCode(code: string, verifier: string, redirectUri: string): Promise<OAuthTokens>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  profile(accessToken: string): Promise<OAuthProfile>;
  messages(accessToken: string, accountId: string): Promise<MailMessage[]>;
  content(accessToken: string, messageId: string): Promise<MailContent>;
}

type OAuthAdapters = Partial<Record<OAuthMailProvider, OAuthProviderAdapter>>;

function accountFromRow(row: OAuthAccountRow): MailAccount {
  return { id: row.id, provider: row.provider, label: row.label, address: row.address, ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt } : {}) };
}

function digest(value: string) { return createHash('sha256').update(value, 'utf8').digest('hex'); }
function randomUrlSafe(bytes: number) { return randomBytes(bytes).toString('base64url'); }
function challenge(verifier: string) { return createHash('sha256').update(verifier, 'ascii').digest('base64url'); }
function constantTimeHex(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'hex'); const rightBuffer = Buffer.from(right, 'hex');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
function opaqueMessageId(value: string) { return Buffer.from(value, 'utf8').toString('base64url'); }
function remoteMessageId(value: string) {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new MailNotFoundError('Mail message not found');
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!decoded || decoded.length > 1024 || opaqueMessageId(decoded) !== value) throw new MailNotFoundError('Mail message not found');
  return decoded;
}

async function readLimited(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new MailConnectionError('Mail provider response is too large');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maxBytes) { await reader.cancel(); throw new MailConnectionError('Mail provider response is too large'); }
    chunks.push(value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

async function providerRequest(url: string | URL, init: RequestInit, maxBytes = 128 * 1024) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new MailConnectionError('Mail provider rejected the request');
    return await readLimited(response, maxBytes);
  } catch (error) {
    if (error instanceof MailConnectionError) throw error;
    throw new MailConnectionError('Mail provider is unavailable');
  } finally { clearTimeout(timer); }
}

async function providerJson(url: string | URL, init: RequestInit, maxBytes?: number): Promise<unknown> {
  const bytes = await providerRequest(url, init, maxBytes);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as unknown; } catch { throw new MailConnectionError('Mail provider returned invalid data'); }
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function bearer(accessToken: string, extra: Record<string, string> = {}) { return { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...extra }; }

function parseTokens(value: unknown, previousRefreshToken?: string): OAuthTokens {
  if (!record(value) || typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > tokenTextLimit
    || (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !value.refresh_token || value.refresh_token.length > tokenTextLimit))) {
    throw new MailConnectionError('OAuth provider returned invalid tokens');
  }
  const expiresIn = typeof value.expires_in === 'number' && Number.isFinite(value.expires_in) ? Math.max(60, Math.min(value.expires_in, 86_400)) : 3_600;
  const refreshToken = typeof value.refresh_token === 'string' ? value.refresh_token : previousRefreshToken;
  return { accessToken: value.access_token, ...(refreshToken ? { refreshToken } : {}), expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() };
}

function settings(config: ServerConfig, provider: OAuthMailProvider) {
  const publicUrl = config.oauthPublicUrl;
  const clientId = provider === 'gmail' ? config.googleClientId : config.microsoftClientId;
  const clientSecret = provider === 'gmail' ? config.googleClientSecret : config.microsoftClientSecret;
  if (!publicUrl || !clientId || !clientSecret || !config.mailEncryptionKey) throw new MailConfigurationError('OAuth provider is not configured');
  return { publicUrl, clientId, clientSecret };
}

function createDefaultAdapter(config: ServerConfig, provider: OAuthMailProvider): OAuthProviderAdapter | undefined {
  let configured: ReturnType<typeof settings>;
  try { configured = settings(config, provider); } catch { return undefined; }
  const redirectUri = `${configured.publicUrl}/v1/mail/oauth/callback/${provider}`;
  const isGoogle = provider === 'gmail';
  const authorizationEndpoint = isGoogle ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
  const tokenEndpoint = isGoogle ? 'https://oauth2.googleapis.com/token' : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const scope = isGoogle ? 'https://www.googleapis.com/auth/gmail.readonly' : 'offline_access User.Read Mail.Read';

  const tokenRequest = async (parameters: Record<string, string>, previousRefreshToken?: string) => {
    const body = new URLSearchParams({ client_id: configured.clientId, scope, ...parameters });
    if (configured.clientSecret) body.set('client_secret', configured.clientSecret);
    return parseTokens(await providerJson(tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body }), previousRefreshToken);
  };

  return {
    authorizationUrl: ({ state, challenge: codeChallenge, redirectUri: requestedRedirect }) => {
      if (requestedRedirect !== redirectUri) throw new MailConfigurationError('OAuth redirect is invalid');
      const url = new URL(authorizationEndpoint);
      url.search = new URLSearchParams({ client_id: configured.clientId, redirect_uri: redirectUri, response_type: 'code', scope, state,
        code_challenge: codeChallenge, code_challenge_method: 'S256' }).toString();
      if (isGoogle) { url.searchParams.set('access_type', 'offline'); url.searchParams.set('prompt', 'consent'); url.searchParams.set('include_granted_scopes', 'true'); }
      else url.searchParams.set('response_mode', 'query');
      return url.toString();
    },
    exchangeCode: (code, verifier, requestedRedirect) => tokenRequest({ code, code_verifier: verifier, redirect_uri: requestedRedirect, grant_type: 'authorization_code' }),
    refresh: (refreshToken) => tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' }, refreshToken),
    profile: async (accessToken) => {
      const value = await providerJson(isGoogle ? 'https://gmail.googleapis.com/gmail/v1/users/me/profile' : 'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName', { headers: bearer(accessToken) });
      if (!record(value)) throw new MailConnectionError('Mail provider returned invalid profile');
      const address = isGoogle ? value.emailAddress : value.mail ?? value.userPrincipalName;
      const label = isGoogle ? 'Gmail' : value.displayName ?? 'Outlook';
      if (typeof address !== 'string' || !emailPattern.test(address) || address.length > 320 || typeof label !== 'string') throw new MailConnectionError('Mail provider returned invalid profile');
      return { address: address.toLowerCase(), label: safeText(label, 80) || (isGoogle ? 'Gmail' : 'Outlook') };
    },
    messages: async (accessToken, accountId) => {
      if (isGoogle) {
        const list = await providerJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${MESSAGE_LIMIT}&labelIds=INBOX`, { headers: bearer(accessToken) });
        if (!record(list) || (list.messages !== undefined && !Array.isArray(list.messages))) throw new MailConnectionError('Gmail returned invalid messages');
        const identifiers = (Array.isArray(list.messages) ? list.messages : []).flatMap((item) => record(item) && typeof item.id === 'string' && item.id.length <= 1024 ? [item.id] : []).slice(0, MESSAGE_LIMIT);
        const messages: MailMessage[] = [];
        for (const id of identifiers) {
          const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
          url.searchParams.set('format', 'metadata');
          for (const header of ['From', 'Subject', 'Date']) url.searchParams.append('metadataHeaders', header);
          const item = await providerJson(url, { headers: bearer(accessToken) });
          if (!record(item) || typeof item.id !== 'string' || typeof item.internalDate !== 'string' || !record(item.payload) || !Array.isArray(item.payload.headers)) continue;
          const headers = new Map(item.payload.headers.flatMap((entry) => record(entry) && typeof entry.name === 'string' && typeof entry.value === 'string' ? [[entry.name.toLowerCase(), entry.value] as const] : []));
          const labelIds = Array.isArray(item.labelIds) ? item.labelIds.filter((label): label is string => typeof label === 'string') : [];
          const receivedAt = new Date(Number(item.internalDate));
          if (!Number.isFinite(receivedAt.getTime())) continue;
          messages.push({ id: opaqueMessageId(item.id), accountId, sender: safeText(headers.get('from') ?? 'Без отправителя', 500), subject: safeText(headers.get('subject') ?? 'Без темы', 1_000),
            preview: typeof item.snippet === 'string' ? safeText(item.snippet, 300) : '', receivedAt: receivedAt.toISOString(), unread: labelIds.includes('UNREAD'), starred: labelIds.includes('STARRED') });
        }
        return messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
      }
      const url = new URL('https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages');
      url.searchParams.set('$top', String(MESSAGE_LIMIT)); url.searchParams.set('$orderby', 'receivedDateTime desc');
      url.searchParams.set('$select', 'id,subject,bodyPreview,receivedDateTime,isRead,flag,from');
      const list = await providerJson(url, { headers: bearer(accessToken) }, MAX_JSON_BYTES);
      if (!record(list) || !Array.isArray(list.value)) throw new MailConnectionError('Outlook returned invalid messages');
      return list.value.flatMap((item): MailMessage[] => {
        if (!record(item) || typeof item.id !== 'string' || item.id.length > 1024 || typeof item.receivedDateTime !== 'string' || typeof item.isRead !== 'boolean') return [];
        const from = record(item.from) && record(item.from.emailAddress) ? item.from.emailAddress : undefined;
        const sender = from && (typeof from.name === 'string' ? from.name : typeof from.address === 'string' ? from.address : undefined);
        const receivedAt = new Date(item.receivedDateTime); if (!Number.isFinite(receivedAt.getTime())) return [];
        return [{ id: opaqueMessageId(item.id), accountId, sender: safeText(sender ?? 'Без отправителя', 500), subject: safeText(typeof item.subject === 'string' ? item.subject : 'Без темы', 1_000),
          preview: safeText(typeof item.bodyPreview === 'string' ? item.bodyPreview : '', 300), receivedAt: receivedAt.toISOString(), unread: !item.isRead,
          starred: record(item.flag) && item.flag.flagStatus === 'flagged' }];
      }).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    },
    content: async (accessToken, messageId) => {
      const remoteId = remoteMessageId(messageId);
      if (isGoogle) {
        const value = await providerJson(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(remoteId)}?format=raw`, { headers: bearer(accessToken) }, MAX_JSON_BYTES);
        if (!record(value) || typeof value.raw !== 'string' || value.raw.length > MAX_JSON_BYTES) throw new MailConnectionError('Gmail returned invalid message');
        const source = Buffer.from(value.raw, 'base64url');
        if (source.length > 2 * 1024 * 1024) throw new MailConnectionError('Mail message is too large');
        const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 2 * 1024 * 1024 });
        return { body: safeBody(parsed.text ?? '') || 'В письме нет текстового содержимого.', hasAttachments: parsed.attachments.length > 0 };
      }
      const url = new URL(`https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(remoteId)}`);
      url.searchParams.set('$select', 'body,hasAttachments');
      const value = await providerJson(url, { headers: bearer(accessToken, { Prefer: 'outlook.body-content-type="text"' }) }, MAX_JSON_BYTES);
      if (!record(value) || !record(value.body) || typeof value.body.content !== 'string' || typeof value.hasAttachments !== 'boolean') throw new MailConnectionError('Outlook returned invalid message');
      return { body: safeBody(value.body.content) || 'В письме нет текстового содержимого.', hasAttachments: value.hasAttachments };
    },
  };
}

export interface MailOAuthService {
  configuredProviders(): OAuthMailProvider[];
  start(provider: OAuthMailProvider, deviceId: string): { flowId: string; authorizationUrl: string; expiresAt: string };
  complete(provider: OAuthMailProvider, input: { code?: string; state?: string; error?: string }): Promise<boolean>;
  status(flowId: string, deviceId: string): { status: 'pending' | 'completed' | 'failed'; account?: MailAccount };
  accounts(): MailAccount[];
  synchronize(accountId?: string): Promise<{ accounts: MailAccount[]; messages: MailMessage[]; serverTime: string }>;
  content(accountId: string, messageId: string): Promise<MailContent>;
  remove(accountId: string): void;
}

export function createMailOAuthService(database: DayDeskDatabase, config: ServerConfig, injectedAdapters: OAuthAdapters = {}): MailOAuthService {
  const key = () => { if (!config.mailEncryptionKey) throw new MailConfigurationError('Mail connector is not configured'); return config.mailEncryptionKey; };
  const defaultGmail = injectedAdapters.gmail ?? createDefaultAdapter(config, 'gmail');
  const defaultOutlook = injectedAdapters.outlook ?? createDefaultAdapter(config, 'outlook');
  const adapters: OAuthAdapters = { ...(defaultGmail ? { gmail: defaultGmail } : {}), ...(defaultOutlook ? { outlook: defaultOutlook } : {}) };
  const adapter = (provider: OAuthMailProvider) => {
    const value = adapters[provider]; if (!value || !config.oauthPublicUrl) throw new MailConfigurationError('OAuth provider is not configured'); return value;
  };
  const rows = () => database.prepare(`SELECT id, provider, label, address, encrypted_tokens AS encryptedTokens, last_synced_at AS lastSyncedAt FROM oauth_mail_accounts ORDER BY created_at ASC`).all() as unknown as OAuthAccountRow[];
  const row = (accountId: string) => {
    const value = database.prepare(`SELECT id, provider, label, address, encrypted_tokens AS encryptedTokens, last_synced_at AS lastSyncedAt FROM oauth_mail_accounts WHERE id = ?`).get(accountId) as OAuthAccountRow | undefined;
    if (!value) throw new MailNotFoundError('Mail account not found'); return value;
  };
  const readTokens = (account: OAuthAccountRow) => {
    try {
      const parsed = JSON.parse(decryptSecret(key(), `oauth-account:${account.id}`, account.encryptedTokens)) as unknown;
      if (!record(parsed) || typeof parsed.accessToken !== 'string' || typeof parsed.expiresAt !== 'string'
        || (parsed.refreshToken !== undefined && typeof parsed.refreshToken !== 'string')) throw new Error();
      return parsed as unknown as OAuthTokens;
    } catch (error) { if (error instanceof MailConfigurationError) throw error; throw new MailConfigurationError('OAuth credential is unavailable'); }
  };
  const saveTokens = (accountId: string, tokens: OAuthTokens) => database.prepare('UPDATE oauth_mail_accounts SET encrypted_tokens = ?, updated_at = ? WHERE id = ?')
    .run(encryptSecret(key(), `oauth-account:${accountId}`, JSON.stringify(tokens)), new Date().toISOString(), accountId);
  const accessToken = async (account: OAuthAccountRow) => {
    let tokens = readTokens(account);
    if (Date.parse(tokens.expiresAt) > Date.now() + 60_000) return tokens.accessToken;
    if (!tokens.refreshToken) throw new MailConnectionError('OAuth session must be connected again');
    tokens = await adapter(account.provider).refresh(tokens.refreshToken); saveTokens(account.id, tokens); return tokens.accessToken;
  };

  return {
    configuredProviders: () => (['gmail', 'outlook'] as const).filter((provider) => Boolean(adapters[provider] && config.oauthPublicUrl && config.mailEncryptionKey)),
    start: (provider, deviceId) => {
      const providerAdapter = adapter(provider); const encryptionKey = key();
      database.prepare("DELETE FROM mail_oauth_flows WHERE expires_at < ? OR (status IN ('completed', 'failed') AND created_at < ?)")
        .run(new Date().toISOString(), new Date(Date.now() - 24 * 60 * 60_000).toISOString());
      const flowId = randomUUID(); const state = `${flowId}.${randomUrlSafe(32)}`; const verifier = randomUrlSafe(64);
      const createdAt = new Date().toISOString(); const expiresAt = new Date(Date.now() + FLOW_TTL_MS).toISOString();
      database.prepare(`INSERT INTO mail_oauth_flows (id, provider, device_id, state_hash, encrypted_verifier, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(flowId, provider, deviceId, digest(state), encryptSecret(encryptionKey, `oauth-flow:${flowId}`, verifier), createdAt, expiresAt);
      const redirectUri = `${config.oauthPublicUrl}/v1/mail/oauth/callback/${provider}`;
      return { flowId, authorizationUrl: providerAdapter.authorizationUrl({ state, challenge: challenge(verifier), redirectUri }), expiresAt };
    },
    complete: async (provider, input) => {
      const state = input.state; const flowId = state?.split('.', 1)[0];
      if (!state || !flowId) return false;
      const flow = database.prepare(`SELECT id, provider, device_id AS deviceId, state_hash AS stateHash, encrypted_verifier AS encryptedVerifier, status, account_id AS accountId, expires_at AS expiresAt FROM mail_oauth_flows WHERE id = ?`).get(flowId) as OAuthFlowRow | undefined;
      if (!flow || flow.provider !== provider || flow.status !== 'pending' || Date.parse(flow.expiresAt) <= Date.now() || !constantTimeHex(flow.stateHash, digest(state))) return false;
      if (input.error || !input.code) { database.prepare("UPDATE mail_oauth_flows SET status = 'failed' WHERE id = ? AND status = 'pending'").run(flow.id); return false; }
      const claimed = database.prepare("UPDATE mail_oauth_flows SET status = 'processing' WHERE id = ? AND status = 'pending'").run(flow.id);
      if (!claimed.changes) return false;
      try {
        const verifier = decryptSecret(key(), `oauth-flow:${flow.id}`, flow.encryptedVerifier);
        const redirectUri = `${config.oauthPublicUrl}/v1/mail/oauth/callback/${provider}`;
        const tokens = await adapter(provider).exchangeCode(input.code, verifier, redirectUri);
        const profile = await adapter(provider).profile(tokens.accessToken);
        const existing = database.prepare('SELECT id, encrypted_tokens AS encryptedTokens FROM oauth_mail_accounts WHERE provider = ? AND address = ?').get(provider, profile.address) as { id: string; encryptedTokens: string } | undefined;
        if (!existing) {
          const count = database.prepare('SELECT COUNT(*) AS count FROM oauth_mail_accounts').get() as { count: number };
          if (count.count >= ACCOUNT_LIMIT) throw new MailConnectionError('OAuth mail account limit reached');
        }
        let finalTokens = tokens; const accountId = existing?.id ?? randomUUID();
        if (!tokens.refreshToken && existing) {
          try { const old = JSON.parse(decryptSecret(key(), `oauth-account:${existing.id}`, existing.encryptedTokens)) as OAuthTokens; if (old.refreshToken) finalTokens = { ...tokens, refreshToken: old.refreshToken }; } catch { /* A new refresh token remains required below. */ }
        }
        if (!finalTokens.refreshToken) throw new MailConnectionError('OAuth provider did not return offline access');
        const now = new Date().toISOString(); const encrypted = encryptSecret(key(), `oauth-account:${accountId}`, JSON.stringify(finalTokens));
        database.prepare(`INSERT INTO oauth_mail_accounts (id, provider, label, address, encrypted_tokens, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, address) DO UPDATE SET label = excluded.label, encrypted_tokens = excluded.encrypted_tokens, updated_at = excluded.updated_at`)
          .run(accountId, provider, profile.label, profile.address, encrypted, now, now);
        database.prepare("UPDATE mail_oauth_flows SET status = 'completed', account_id = ?, encrypted_verifier = '' WHERE id = ?").run(accountId, flow.id);
        return true;
      } catch {
        database.prepare("UPDATE mail_oauth_flows SET status = 'failed', encrypted_verifier = '' WHERE id = ?").run(flow.id);
        return false;
      }
    },
    status: (flowId, deviceId) => {
      const flow = database.prepare(`SELECT id, provider, device_id AS deviceId, state_hash AS stateHash, encrypted_verifier AS encryptedVerifier, status, account_id AS accountId, expires_at AS expiresAt FROM mail_oauth_flows WHERE id = ? AND device_id = ?`).get(flowId, deviceId) as OAuthFlowRow | undefined;
      if (!flow) throw new MailNotFoundError('OAuth flow not found');
      if (Date.parse(flow.expiresAt) <= Date.now() && flow.status !== 'completed') { database.prepare("UPDATE mail_oauth_flows SET status = 'failed', encrypted_verifier = '' WHERE id = ?").run(flow.id); return { status: 'failed' }; }
      if (flow.status === 'completed' && flow.accountId) return { status: 'completed', account: accountFromRow(row(flow.accountId)) };
      return { status: flow.status === 'failed' ? 'failed' : 'pending' };
    },
    accounts: () => rows().map(accountFromRow),
    synchronize: async (accountId) => {
      const selected = accountId ? [row(accountId)] : rows(); const messages: MailMessage[] = []; const now = new Date().toISOString();
      for (const account of selected) {
        messages.push(...await adapter(account.provider).messages(await accessToken(account), account.id));
        database.prepare('UPDATE oauth_mail_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?').run(now, now, account.id); account.lastSyncedAt = now;
      }
      return { accounts: selected.map(accountFromRow), messages: messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)), serverTime: now };
    },
    content: async (accountId, messageId) => { const account = row(accountId); return adapter(account.provider).content(await accessToken(account), messageId); },
    remove: (accountId) => { const result = database.prepare('DELETE FROM oauth_mail_accounts WHERE id = ?').run(accountId); if (!result.changes) throw new MailNotFoundError('Mail account not found'); },
  };
}
