import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import { registerDevice } from '../src/auth.js';
import type { ServerConfig } from '../src/config.js';
import { createDatabase, type DayDeskDatabase } from '../src/database.js';
import { createMailOAuthService, type MailOAuthService, type OAuthProviderAdapter } from '../src/mail-oauth.js';
import { createMailService, isBlockedMailAddress, type MailService, type MailTransport } from '../src/mail-service.js';
import type { MailAccount, MailMessage } from '../src/types.js';

const config: ServerConfig = {
  host: '127.0.0.1', port: 4310, databasePath: ':memory:', setupCode: 'test-setup-code-1234',
  allowedOrigins: [], logger: false, mailEncryptionKey: Buffer.alloc(32, 7), allowPrivateMailHosts: false,
};
const apps: FastifyInstance[] = [];
const databases: DayDeskDatabase[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  databases.splice(0).forEach((database) => database.close());
});

const message = (accountId: string): MailMessage => ({
  id: '42', accountId, sender: 'Команда DayDesk', subject: 'Проверка почты', preview: 'Всё работает',
  receivedAt: '2026-08-30T12:00:00.000Z', unread: true, starred: false, folder: 'inbox',
});

test('private and reserved IMAP destinations are blocked by default', () => {
  assert.equal(isBlockedMailAddress('127.0.0.1'), true);
  assert.equal(isBlockedMailAddress('10.1.2.3'), true);
  assert.equal(isBlockedMailAddress('169.254.169.254'), true);
  assert.equal(isBlockedMailAddress('::1'), true);
  assert.equal(isBlockedMailAddress('1.1.1.1'), false);
});

test('IMAP password is encrypted at rest and never returned with account data', async () => {
  const database = createDatabase(':memory:');
  databases.push(database);
  let receivedPassword = '';
  const transport: MailTransport = {
    list: async ({ account, password }) => { receivedPassword = password; return [message(account.id)]; },
    content: async () => ({ body: 'Текст письма', hasAttachments: false, attachments: [] }),
    attachment: async () => { throw new Error('Not used'); },
  };
  const service = createMailService(database, config, transport);
  const result = await service.connectImap({ label: 'Работа', address: 'user@example.com', host: 'imap.example.com', port: 993, username: 'user@example.com', password: 'app-secret-123' });
  assert.equal(receivedPassword, 'app-secret-123');
  assert.equal('password' in result.account, false);
  const row = database.prepare('SELECT encrypted_password AS encryptedPassword FROM mail_accounts').get() as { encryptedPassword: string };
  assert.equal(row.encryptedPassword.includes('app-secret-123'), false);
  await service.synchronize(result.account.id);
  assert.equal(receivedPassword, 'app-secret-123');
});

test('mail API requires device authentication and validates connection input', async () => {
  const account: MailAccount = { id: '123e4567-e89b-12d3-a456-426614174000', provider: 'imap', label: 'Работа', address: 'user@example.com', host: 'imap.example.com', port: 993, username: 'user@example.com' };
  let synchronizedFolder = 'inbox';
  let incomingAttachment = { id: '1', name: 'note.txt', mimeType: 'text/plain', size: 5, downloadable: true, content: Buffer.from('hello') };
  const fake: MailService = {
    connectImap: async () => ({ account, messages: [message(account.id)] }),
    accounts: () => [account],
    synchronize: async (_accountId, folder = 'inbox') => { synchronizedFolder = folder; return { accounts: [account], messages: [{ ...message(account.id), folder }], serverTime: '2026-08-30T12:00:00.000Z' }; },
    content: async () => ({ body: 'Текст письма', hasAttachments: false, attachments: [] }),
    attachment: async () => ({ ...incomingAttachment, content: Buffer.from(incomingAttachment.content) }),
    send: async () => undefined,
    remove: () => undefined,
  };
  const app = await buildApp(config, { mailService: fake });
  apps.push(app);
  const unauthorized = await app.inject({ method: 'GET', url: '/v1/mail/accounts' });
  assert.equal(unauthorized.statusCode, 401);
  const registration = await app.inject({ method: 'POST', url: '/v1/devices/register', payload: { setupCode: config.setupCode, name: 'iPhone' } });
  const device = registration.json().data as { id: string; token: string };
  const headers = { authorization: `Bearer ${device.token}`, 'x-device-id': device.id };
  const malformed = await app.inject({ method: 'POST', url: '/v1/mail/accounts/imap', headers, payload: { label: 'Test', address: 'bad', host: 'localhost', port: 143, username: 'x', password: 'x' } });
  assert.equal(malformed.statusCode, 400);
  const connected = await app.inject({ method: 'POST', url: '/v1/mail/accounts/imap', headers, payload: { label: 'Работа', address: 'user@example.com', host: 'imap.example.com', port: 993, username: 'user@example.com', password: 'secret' } });
  assert.equal(connected.statusCode, 201);
  assert.equal(connected.json().data.messages[0].subject, 'Проверка почты');
  const content = await app.inject({ method: 'GET', url: `/v1/mail/messages/${account.id}/42`, headers });
  assert.equal(content.statusCode, 200);
  assert.equal(content.headers['cache-control'], 'no-store');
  assert.equal(content.json().data.body, 'Текст письма');
  const sent = await app.inject({ method: 'POST', url: '/v1/mail/sync', headers, payload: { folder: 'sent' } });
  assert.equal(sent.statusCode, 200);
  assert.equal(synchronizedFolder, 'sent');
  assert.equal(sent.json().data.messages[0].folder, 'sent');
  const attachment = await app.inject({ method: 'GET', url: `/v1/mail/messages/${account.id}/42/attachments/1`, headers });
  assert.equal(attachment.statusCode, 200);
  assert.equal(attachment.headers['cache-control'], 'no-store');
  assert.deepEqual(attachment.json().data, { id: '1', name: 'note.txt', mimeType: 'text/plain', size: 5, data: Buffer.from('hello').toString('base64') });
  const invitationSource = Buffer.from('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:api-1\r\nDTSTART:20260901T120000Z\r\nDTEND:20260901T130000Z\r\nSUMMARY:API meeting\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
  incomingAttachment = { id: '1', name: 'invite.ics', mimeType: 'text/calendar', size: invitationSource.length, downloadable: true, content: invitationSource };
  const invitation = await app.inject({ method: 'GET', url: `/v1/mail/messages/${account.id}/42/attachments/1/invitation`, headers });
  assert.equal(invitation.statusCode, 200);
  assert.equal(invitation.headers['cache-control'], 'no-store');
  assert.deepEqual(invitation.json().data, { title: 'API meeting', startsAt: '2026-09-01T12:00:00.000Z', endsAt: '2026-09-01T13:00:00.000Z', allDay: false });
  assert.equal((await app.inject({ method: 'GET', url: `/v1/mail/messages/${account.id}/42/attachments/0`, headers })).statusCode, 400);
});

test('OAuth mail flow binds state to a device and encrypts offline credentials', async () => {
  const database = createDatabase(':memory:');
  databases.push(database);
  const oauthConfig: ServerConfig = { ...config, oauthPublicUrl: 'https://sync.example.com', googleClientId: 'google-client' };
  let receivedVerifier = '';
  let refreshedWith = '';
  let sentMime = '';
  const adapter: OAuthProviderAdapter = {
    authorizationUrl: ({ state, challenge, redirectUri }) => {
      const url = new URL('https://accounts.example/authorize');
      url.search = new URLSearchParams({ state, code_challenge: challenge, redirect_uri: redirectUri }).toString();
      return url.toString();
    },
    exchangeCode: async (_code, verifier) => {
      receivedVerifier = verifier;
      return { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresAt: new Date(Date.now() - 1_000).toISOString() };
    },
    refresh: async (refreshToken) => {
      refreshedWith = refreshToken;
      return { accessToken: 'fresh-access-secret', refreshToken, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    },
    profile: async () => ({ address: 'user@gmail.com', label: 'Gmail' }),
    messages: async (_accessToken, accountId) => [message(accountId)],
    content: async () => ({ body: 'Строка 1\nСтрока 2', hasAttachments: true, attachments: [{ id: '1', name: 'plan.txt', mimeType: 'text/plain', size: 4, downloadable: true }] }),
    attachment: async () => ({ id: '1', name: 'plan.txt', mimeType: 'text/plain', size: 4, downloadable: true, content: Buffer.from('plan') }),
    send: async (_accessToken, mime) => { sentMime = mime.toString('utf8'); },
  };
  const service = createMailOAuthService(database, oauthConfig, { gmail: adapter });
  const device = registerDevice(database, oauthConfig, oauthConfig.setupCode, 'iPhone');
  const started = service.start('gmail', device.id);
  const authorization = new URL(started.authorizationUrl);
  const state = authorization.searchParams.get('state');
  assert.ok(state);
  assert.equal(authorization.searchParams.get('redirect_uri'), 'https://sync.example.com/v1/mail/oauth/callback/gmail');
  assert.ok(authorization.searchParams.get('code_challenge'));

  const flow = database.prepare('SELECT state_hash AS stateHash, encrypted_verifier AS encryptedVerifier FROM mail_oauth_flows WHERE id = ?')
    .get(started.flowId) as { stateHash: string; encryptedVerifier: string };
  assert.equal(flow.stateHash.includes(state), false);
  assert.equal(flow.encryptedVerifier.includes(authorization.searchParams.get('code_challenge') ?? ''), false);
  assert.equal(await service.complete('gmail', { state, code: 'authorization-code' }), true);
  assert.ok(receivedVerifier.length >= 43);
  assert.throws(() => service.status(started.flowId, 'another-device'));

  const status = service.status(started.flowId, device.id);
  assert.equal(status.status, 'completed');
  assert.equal(status.account?.address, 'user@gmail.com');
  assert.equal('accessToken' in (status.account ?? {}), false);
  const stored = database.prepare('SELECT encrypted_tokens AS encryptedTokens FROM oauth_mail_accounts').get() as { encryptedTokens: string };
  assert.equal(stored.encryptedTokens.includes('access-secret'), false);
  assert.equal(stored.encryptedTokens.includes('refresh-secret'), false);

  const snapshot = await service.synchronize(status.account?.id);
  assert.equal(refreshedWith, 'refresh-secret');
  assert.equal(snapshot.messages[0]?.subject, 'Проверка почты');
  assert.deepEqual(await service.content(status.account?.id ?? '', '42'), { body: 'Строка 1\nСтрока 2', hasAttachments: true, attachments: [{ id: '1', name: 'plan.txt', mimeType: 'text/plain', size: 4, downloadable: true }] });
  await service.send(status.account?.id ?? '', { to: ['friend@example.com'], cc: [], bcc: ['hidden@example.com'], subject: 'План', body: 'Текст' }, [
    { name: 'plan.txt', mimeType: 'text/plain', size: 4, content: Buffer.from('file') },
  ]);
  assert.match(sentMime, /Subject: =\?UTF-8\?/);
  assert.match(sentMime, /plan\.txt/);
  assert.match(sentMime, /Bcc: hidden@example\.com/);
  assert.equal(await service.complete('gmail', { state, code: 'replay' }), false);
});

test('OAuth mail API exposes provider flow and accepts provider callback metadata', async () => {
  const account: MailAccount = { id: '123e4567-e89b-42d3-a456-426614174001', provider: 'gmail', label: 'Gmail', address: 'user@gmail.com' };
  const flowId = '123e4567-e89b-42d3-a456-426614174002';
  let callbackReceived = false;
  let outgoing: { subject: string; attachmentName?: string } | undefined;
  const oauth: MailOAuthService = {
    configuredProviders: () => ['gmail'],
    start: () => ({ flowId, authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth', expiresAt: '2026-08-30T13:00:00.000Z' }),
    complete: async (_provider, input) => { callbackReceived = input.code === 'provider-code' && Boolean(input.state); return callbackReceived; },
    status: () => ({ status: 'completed', account }),
    accounts: () => [account],
    synchronize: async () => ({ accounts: [account], messages: [message(account.id)], serverTime: '2026-08-30T12:00:00.000Z' }),
    content: async () => ({ body: 'Текст', hasAttachments: false, attachments: [] }),
    attachment: async () => ({ id: '1', name: 'note.txt', mimeType: 'text/plain', size: 5, downloadable: true, content: Buffer.from('hello') }),
    send: async (_accountId, input, attachments) => { outgoing = { subject: input.subject, ...(attachments[0] ? { attachmentName: attachments[0].name } : {}) }; },
    remove: () => undefined,
  };
  const imap: MailService = {
    connectImap: async () => { throw new Error('Not used'); }, accounts: () => [],
    synchronize: async () => ({ accounts: [], messages: [], serverTime: '2026-08-30T12:00:00.000Z' }),
    content: async () => { throw new Error('Not used'); }, attachment: async () => { throw new Error('Not used'); }, remove: () => undefined,
    send: async () => { throw new Error('Not used'); },
  };
  const app = await buildApp(config, { mailService: imap, mailOAuthService: oauth });
  apps.push(app);
  const registration = await app.inject({ method: 'POST', url: '/v1/devices/register', payload: { setupCode: config.setupCode, name: 'Android' } });
  const device = registration.json().data as { id: string; token: string };
  const headers = { authorization: `Bearer ${device.token}`, 'x-device-id': device.id };
  assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/mail/oauth/providers', headers })).json().data.providers, ['gmail']);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/mail/oauth/start', headers, payload: { provider: 'gmail' } })).statusCode, 201);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/mail/oauth/status/${flowId}`, headers })).json().data.account.address, 'user@gmail.com');
  const state = `${flowId}.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO`;
  const query = new URLSearchParams({ code: 'provider-code', state, scope: 'https://www.googleapis.com/auth/gmail.readonly', authuser: '0', prompt: 'consent' });
  const callback = await app.inject({ method: 'GET', url: `/v1/mail/oauth/callback/gmail?${query}` });
  assert.equal(callback.statusCode, 200);
  assert.match(callback.body, /DayDesk подключён/);
  assert.equal(callbackReceived, true);
  const upload = await app.inject({ method: 'POST', url: '/v1/mail/attachments', headers, payload: { name: 'note.txt', mimeType: 'text/plain', data: Buffer.from('hello').toString('base64') } });
  assert.equal(upload.statusCode, 201);
  const token = upload.json().data.token as string;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/mail/attachments', payload: { name: 'x.txt', mimeType: 'text/plain', data: 'eA==' } })).statusCode, 401);
  const secondRegistration = await app.inject({ method: 'POST', url: '/v1/devices/register', payload: { setupCode: config.setupCode, name: 'Another device' } });
  const secondDevice = secondRegistration.json().data as { id: string; token: string };
  const secondHeaders = { authorization: `Bearer ${secondDevice.token}`, 'x-device-id': secondDevice.id };
  const crossDevice = await app.inject({ method: 'POST', url: '/v1/mail/send', headers: secondHeaders, payload: {
    accountId: account.id, to: ['friend@example.com'], cc: [], bcc: [], subject: 'План', body: 'Привет', attachmentTokens: [token],
  } });
  assert.equal(crossDevice.statusCode, 404);
  const sent = await app.inject({ method: 'POST', url: '/v1/mail/send', headers, payload: {
    accountId: account.id, to: ['friend@example.com'], cc: [], bcc: [], subject: 'План', body: 'Привет', attachmentTokens: [token],
  } });
  assert.equal(sent.statusCode, 202);
  assert.deepEqual(outgoing, { subject: 'План', attachmentName: 'note.txt' });
  const replay = await app.inject({ method: 'POST', url: '/v1/mail/send', headers, payload: {
    accountId: account.id, to: ['friend@example.com'], cc: [], bcc: [], subject: 'План', body: 'Привет', attachmentTokens: [token],
  } });
  assert.equal(replay.statusCode, 404);
});
