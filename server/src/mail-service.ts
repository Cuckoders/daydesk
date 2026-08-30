import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

import { ImapFlow, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';

import type { ServerConfig } from './config.js';
import type { DayDeskDatabase } from './database.js';
import type { MailAccount, MailContent, MailMessage } from './types.js';

const MAIL_LIMIT = 50;
const ACCOUNT_LIMIT = 20;
const PREVIEW_SOURCE_BYTES = 64 * 1024;
const MESSAGE_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARACTERS = 200_000;
const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
] as const) blockedAddresses.addSubnet(network, prefix, 'ipv6');

export function isBlockedMailAddress(address: string) {
  const family = isIP(address);
  return family === 0 || blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

interface MailAccountRow {
  id: string;
  provider: 'imap';
  label: string;
  address: string;
  host: string;
  port: 993;
  username: string;
  encryptedPassword: string;
  lastSyncedAt: string | null;
}

export interface ConnectImapInput {
  label: string;
  address: string;
  host: string;
  port: 993;
  username: string;
  password: string;
}

interface StoredConnection {
  account: ImapMailAccount;
  password: string;
}

interface ImapMailAccount extends MailAccount {
  provider: 'imap';
  host: string;
  port: 993;
  username: string;
}

export interface MailTransport {
  list(connection: StoredConnection): Promise<MailMessage[]>;
  content(connection: StoredConnection, messageId: string): Promise<MailContent>;
}

export class MailConfigurationError extends Error {}
export class MailConnectionError extends Error {}
export class MailNotFoundError extends Error {}

function accountFromRow(row: MailAccountRow): ImapMailAccount {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    address: row.address,
    host: row.host,
    port: row.port,
    username: row.username,
    ...(row.lastSyncedAt ? { lastSyncedAt: row.lastSyncedAt } : {}),
  };
}

export function encryptSecret(key: Buffer, associatedData: string, secret: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(associatedData, 'utf8'));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', nonce.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptSecret(key: Buffer, associatedData: string, value: string) {
  const [version, nonceValue, tagValue, encryptedValue, extra] = value.split('.');
  if (version !== 'v1' || !nonceValue || !tagValue || !encryptedValue || extra) throw new MailConfigurationError('Mail credential is unavailable');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonceValue, 'base64url'));
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encryptedValue, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new MailConfigurationError('Mail credential is unavailable');
  }
}

async function resolveMailHost(host: string, allowPrivate: boolean) {
  const addresses = await lookup(host, { all: true, verbatim: true }).catch(() => { throw new MailConnectionError('Mail connection failed'); });
  const selected = addresses.at(0);
  if (!selected || (!allowPrivate && addresses.some(({ address }) => isBlockedMailAddress(address)))) {
    throw new MailConnectionError('Mail connection failed');
  }
  return selected.address;
}

function senderName(message: FetchMessageObject) {
  const sender = message.envelope?.from?.[0];
  return (sender?.name?.trim() || sender?.address?.trim() || 'Без отправителя').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 500);
}

async function previewFromSource(source?: Buffer) {
  if (!source?.length) return '';
  try {
    const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: PREVIEW_SOURCE_BYTES });
    return (parsed.text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

function createImapTransport(config: ServerConfig): MailTransport {
  const withClient = async <T>(connection: StoredConnection, operation: (client: ImapFlow) => Promise<T>) => {
    const resolvedHost = await resolveMailHost(connection.account.host, Boolean(config.allowPrivateMailHosts));
    const client = new ImapFlow({
      host: resolvedHost,
      servername: connection.account.host,
      port: 993,
      secure: true,
      auth: { user: connection.account.username, pass: connection.password },
      logger: false,
      connectionTimeout: 12_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
      maxLineLength: 256 * 1024,
      maxLiteralSize: MESSAGE_SOURCE_BYTES,
      maxResponseSize: MESSAGE_SOURCE_BYTES + 256 * 1024,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      return await operation(client);
    } catch (error) {
      if (error instanceof MailNotFoundError) throw error;
      throw new MailConnectionError('Mail connection failed');
    } finally {
      if (client.usable) await client.logout().catch(() => client.close()); else client.close();
    }
  };

  return {
    list: (connection) => withClient(connection, async (client) => {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true, acquireTimeout: 10_000 });
      try {
        const total = client.mailbox ? client.mailbox.exists : 0;
        if (!total) return [];
        const start = Math.max(1, total - MAIL_LIMIT + 1);
        const loaded = await client.fetchAll(`${start}:*`, {
          uid: true, flags: true, envelope: true, internalDate: true, source: { start: 0, maxLength: PREVIEW_SOURCE_BYTES },
        });
        const messages = await Promise.all(loaded.map(async (message): Promise<MailMessage> => ({
          id: String(message.uid),
          accountId: connection.account.id,
          sender: senderName(message),
          subject: message.envelope?.subject?.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 1_000) || 'Без темы',
          preview: await previewFromSource(message.source),
          receivedAt: new Date(message.envelope?.date ?? message.internalDate ?? Date.now()).toISOString(),
          unread: !message.flags?.has('\\Seen'),
          starred: Boolean(message.flags?.has('\\Flagged')),
        })));
        return messages.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
      } finally {
        lock.release();
      }
    }),
    content: (connection, messageId) => withClient(connection, async (client) => {
      const lock = await client.getMailboxLock('INBOX', { acquireTimeout: 10_000 });
      try {
        const message = await client.fetchOne(messageId, { source: { start: 0, maxLength: MESSAGE_SOURCE_BYTES } }, { uid: true });
        if (message === false || !message.source) throw new MailNotFoundError('Mail message not found');
        const parsed = await simpleParser(message.source, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: MESSAGE_SOURCE_BYTES });
        const body = (parsed.text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, MAX_BODY_CHARACTERS);
        await client.messageFlagsAdd(messageId, ['\\Seen'], { uid: true });
        return { body: body || 'В письме нет текстового содержимого.', hasAttachments: parsed.attachments.length > 0 };
      } finally {
        lock.release();
      }
    }),
  };
}

export interface MailService {
  connectImap(input: ConnectImapInput): Promise<{ account: MailAccount; messages: MailMessage[] }>;
  accounts(): MailAccount[];
  synchronize(accountId?: string): Promise<{ accounts: MailAccount[]; messages: MailMessage[]; serverTime: string }>;
  content(accountId: string, messageId: string): Promise<MailContent>;
  remove(accountId: string): void;
}

export function createMailService(database: DayDeskDatabase, config: ServerConfig, transport = createImapTransport(config)): MailService {
  const key = () => {
    if (!config.mailEncryptionKey) throw new MailConfigurationError('Mail connector is not configured');
    return config.mailEncryptionKey;
  };
  const readRows = () => database.prepare(`
    SELECT id, provider, label, address, host, port, username, encrypted_password AS encryptedPassword, last_synced_at AS lastSyncedAt
    FROM mail_accounts ORDER BY created_at ASC
  `).all() as unknown as MailAccountRow[];
  const connection = (accountId: string): StoredConnection => {
    const row = database.prepare(`
      SELECT id, provider, label, address, host, port, username, encrypted_password AS encryptedPassword, last_synced_at AS lastSyncedAt
      FROM mail_accounts WHERE id = ?
    `).get(accountId) as MailAccountRow | undefined;
    if (!row) throw new MailNotFoundError('Mail account not found');
    return { account: accountFromRow(row), password: decryptSecret(key(), row.id, row.encryptedPassword) };
  };

  return {
    connectImap: async (input) => {
      const encryptionKey = key();
      const accountCount = database.prepare('SELECT COUNT(*) AS count FROM mail_accounts').get() as { count: number };
      if (accountCount.count >= ACCOUNT_LIMIT) throw new TypeError('Mail account limit reached');
      const duplicate = database.prepare('SELECT 1 FROM mail_accounts WHERE host = ? AND username = ?').get(input.host.trim().toLowerCase(), input.username.trim());
      if (duplicate) throw new TypeError('Mail account already exists');
      const account: ImapMailAccount = {
        id: randomUUID(), provider: 'imap', label: input.label.trim(), address: input.address.trim().toLowerCase(),
        host: input.host.trim().toLowerCase(), port: 993, username: input.username.trim(),
      };
      const messages = await transport.list({ account, password: input.password });
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO mail_accounts (id, provider, label, address, host, port, username, encrypted_password, created_at, updated_at, last_synced_at)
        VALUES (?, 'imap', ?, ?, ?, 993, ?, ?, ?, ?, ?)
      `).run(account.id, account.label, account.address, account.host, account.username, encryptSecret(encryptionKey, account.id, input.password), now, now, now);
      return { account: { ...account, lastSyncedAt: now }, messages };
    },
    accounts: () => readRows().map(accountFromRow),
    synchronize: async (accountId) => {
      const connections = accountId ? [connection(accountId)] : readRows().map((row) => ({ account: accountFromRow(row), password: decryptSecret(key(), row.id, row.encryptedPassword) }));
      const messages: MailMessage[] = [];
      const now = new Date().toISOString();
      for (const item of connections) {
        messages.push(...await transport.list(item));
        database.prepare('UPDATE mail_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?').run(now, now, item.account.id);
        item.account.lastSyncedAt = now;
      }
      return { accounts: connections.map((item) => item.account), messages: messages.sort((left, right) => right.receivedAt.localeCompare(left.receivedAt)), serverTime: now };
    },
    content: (accountId, messageId) => transport.content(connection(accountId), messageId),
    remove: (accountId) => {
      const result = database.prepare('DELETE FROM mail_accounts WHERE id = ?').run(accountId);
      if (!result.changes) throw new MailNotFoundError('Mail account not found');
    },
  };
}
