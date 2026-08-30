import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';
import { createDatabase, type DayDeskDatabase } from '../src/database.js';
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
  receivedAt: '2026-08-30T12:00:00.000Z', unread: true, starred: false,
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
    content: async () => ({ body: 'Текст письма', hasAttachments: false }),
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
  const fake: MailService = {
    connectImap: async () => ({ account, messages: [message(account.id)] }),
    accounts: () => [account],
    synchronize: async () => ({ accounts: [account], messages: [message(account.id)], serverTime: '2026-08-30T12:00:00.000Z' }),
    content: async () => ({ body: 'Текст письма', hasAttachments: false }),
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
  assert.equal(content.json().data.body, 'Текст письма');
});
