import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { AuthenticationError, authenticateDevice, registerDevice } from './auth.js';
import type { ServerConfig } from './config.js';
import { createDatabase } from './database.js';
import { createMailAttachmentRegistry, MailAttachmentNotFoundError, type AttachmentUploadInput, type MailAttachmentRegistry } from './mail-compose.js';
import { createMailOAuthService, type MailOAuthService, type OAuthMailProvider } from './mail-oauth.js';
import { createMailService, MailConfigurationError, MailConnectionError, MailNotFoundError, type ConnectImapInput, type MailService } from './mail-service.js';
import { connectImapSchema, discardMailAttachmentsSchema, mailAccountListSchema, mailAccountParamsSchema, mailAttachmentParamsSchema, mailMessageParamsSchema, mailOAuthCallbackSchema, mailOAuthStatusSchema, mailSyncSchema, registerDeviceSchema, sendMailSchema, startMailOAuthSchema, syncSchema, uploadMailAttachmentSchema } from './schemas.js';
import { synchronize } from './sync-service.js';
import type { MailFolder, OutgoingMailInput, SyncRequestBody } from './types.js';

interface RegisterBody {
  setupCode: string;
  name: string;
}

export async function buildApp(config: ServerConfig, dependencies: { mailService?: MailService; mailOAuthService?: MailOAuthService; mailAttachmentRegistry?: MailAttachmentRegistry } = {}) {
  const app = Fastify({ logger: config.logger, bodyLimit: 1024 * 1024 });
  const database = createDatabase(config.databasePath);
  const mailService = dependencies.mailService ?? createMailService(database, config);
  const mailOAuthService = dependencies.mailOAuthService ?? createMailOAuthService(database, config);
  const mailAttachmentRegistry = dependencies.mailAttachmentRegistry ?? createMailAttachmentRegistry();

  await app.register(helmet, { global: true });
  await app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : false,
    methods: ['GET', 'POST', 'DELETE'],
  });
  await app.register(rateLimit, { global: true, max: 120, timeWindow: '1 minute' });

  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  app.post<{ Body: RegisterBody }>('/v1/devices/register', {
    schema: registerDeviceSchema,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const device = registerDevice(database, config, request.body.setupCode, request.body.name.trim());
    return reply.code(201).send({ status: 'success', data: device });
  });

  app.post<{ Body: SyncRequestBody }>('/v1/sync', { schema: syncSchema }, async (request) => {
    const device = authenticateDevice(database, request);
    return { status: 'success', data: synchronize(database, device.id, request.body) };
  });

  app.get('/v1/mail/accounts', { schema: mailAccountListSchema }, async (request) => {
    authenticateDevice(database, request);
    return { status: 'success', data: { accounts: [...mailService.accounts(), ...mailOAuthService.accounts()] } };
  });

  app.get('/v1/mail/oauth/providers', { schema: mailAccountListSchema }, async (request) => {
    authenticateDevice(database, request);
    return { status: 'success', data: { providers: mailOAuthService.configuredProviders() } };
  });

  app.post<{ Body: { provider: OAuthMailProvider } }>('/v1/mail/oauth/start', {
    schema: startMailOAuthSchema,
    config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const device = authenticateDevice(database, request);
    return reply.code(201).send({ status: 'success', data: mailOAuthService.start(request.body.provider, device.id) });
  });

  app.get<{ Params: { flowId: string } }>('/v1/mail/oauth/status/:flowId', { schema: mailOAuthStatusSchema }, async (request) => {
    const device = authenticateDevice(database, request);
    return { status: 'success', data: mailOAuthService.status(request.params.flowId, device.id) };
  });

  app.get<{ Params: { provider: OAuthMailProvider }; Querystring: { code?: string; state?: string; error?: string } }>('/v1/mail/oauth/callback/:provider', {
    schema: mailOAuthCallbackSchema,
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const success = await mailOAuthService.complete(request.params.provider, request.query);
    const title = success ? 'DayDesk подключён' : 'Подключение не завершено';
    const message = success ? 'Можно закрыть эту вкладку и вернуться в приложение.' : 'Вернитесь в DayDesk и попробуйте подключить аккаунт ещё раз.';
    return reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow').type('text/html; charset=utf-8')
      .send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><main><h1>${title}</h1><p>${message}</p></main></html>`);
  });

  app.post<{ Body: ConnectImapInput }>('/v1/mail/accounts/imap', {
    schema: connectImapSchema,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    authenticateDevice(database, request);
    const result = await mailService.connectImap(request.body);
    return reply.code(201).send({ status: 'success', data: result });
  });

  app.post<{ Body: { accountId?: string; folder?: MailFolder } }>('/v1/mail/sync', {
    schema: mailSyncSchema,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    authenticateDevice(database, request);
    const accountId = request.body.accountId;
    const folder = request.body.folder ?? 'inbox';
    if (accountId) {
      if (mailService.accounts().some((account) => account.id === accountId)) return { status: 'success', data: await mailService.synchronize(accountId, folder) };
      return { status: 'success', data: await mailOAuthService.synchronize(accountId, folder) };
    }
    const [imap, oauth] = await Promise.all([mailService.synchronize(undefined, folder), mailOAuthService.synchronize(undefined, folder)]);
    return { status: 'success', data: { accounts: [...imap.accounts, ...oauth.accounts], messages: [...imap.messages, ...oauth.messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)), serverTime: new Date().toISOString() } };
  });

  app.get<{ Params: { accountId: string; messageId: string }; Querystring: { folder?: MailFolder } }>('/v1/mail/messages/:accountId/:messageId', {
    schema: mailMessageParamsSchema,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    authenticateDevice(database, request);
    const folder = request.query.folder ?? 'inbox';
    const content = mailService.accounts().some((account) => account.id === request.params.accountId)
      ? await mailService.content(request.params.accountId, request.params.messageId, folder)
      : await mailOAuthService.content(request.params.accountId, request.params.messageId);
    return reply.header('cache-control', 'no-store').send({ status: 'success', data: content });
  });

  app.get<{ Params: { accountId: string; messageId: string; attachmentId: string }; Querystring: { folder?: MailFolder } }>('/v1/mail/messages/:accountId/:messageId/attachments/:attachmentId', {
    schema: mailAttachmentParamsSchema,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    authenticateDevice(database, request);
    const folder = request.query.folder ?? 'inbox';
    const attachment = mailService.accounts().some((account) => account.id === request.params.accountId)
      ? await mailService.attachment(request.params.accountId, request.params.messageId, request.params.attachmentId, folder)
      : await mailOAuthService.attachment(request.params.accountId, request.params.messageId, request.params.attachmentId);
    try {
      return reply.header('cache-control', 'no-store').send({ status: 'success', data: { id: attachment.id, name: attachment.name, mimeType: attachment.mimeType, size: attachment.size, data: attachment.content.toString('base64') } });
    } finally { attachment.content.fill(0); }
  });

  app.post<{ Body: AttachmentUploadInput }>('/v1/mail/attachments', {
    schema: uploadMailAttachmentSchema,
    bodyLimit: 2_900_000,
    config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    const device = authenticateDevice(database, request);
    return reply.code(201).send({ status: 'success', data: mailAttachmentRegistry.upload(device.id, request.body) });
  });

  app.delete<{ Body: { tokens: string[] } }>('/v1/mail/attachments', { schema: discardMailAttachmentsSchema }, async (request, reply) => {
    const device = authenticateDevice(database, request);
    mailAttachmentRegistry.discard(device.id, request.body.tokens);
    return reply.code(204).send();
  });

  app.post<{ Body: OutgoingMailInput & { accountId: string; attachmentTokens: string[] } }>('/v1/mail/send', {
    schema: sendMailSchema,
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const device = authenticateDevice(database, request);
    const { accountId, attachmentTokens, ...input } = request.body;
    await mailAttachmentRegistry.withClaim(device.id, attachmentTokens, async (attachments) => {
      if (mailService.accounts().some((account) => account.id === accountId)) await mailService.send(accountId, input, attachments);
      else await mailOAuthService.send(accountId, input, attachments);
    });
    return reply.code(202).send({ status: 'success', data: { accepted: true } });
  });

  app.delete<{ Params: { accountId: string } }>('/v1/mail/accounts/:accountId', { schema: mailAccountParamsSchema }, async (request, reply) => {
    authenticateDevice(database, request);
    if (mailService.accounts().some((account) => account.id === request.params.accountId)) mailService.remove(request.params.accountId);
    else mailOAuthService.remove(request.params.accountId);
    return reply.code(204).send();
  });

  app.delete('/v1/devices/current', { schema: { headers: syncSchema.headers } }, async (request, reply) => {
    const device = authenticateDevice(database, request);
    database.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), device.id);
    return reply.code(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthenticationError) {
      return reply.code(401).send({ status: 'error', message: 'Authentication failed' });
    }
    if (error instanceof MailNotFoundError || error instanceof MailAttachmentNotFoundError) return reply.code(404).send({ status: 'error', message: 'Mail resource not found' });
    if (error instanceof MailConnectionError) return reply.code(422).send({ status: 'error', message: 'Mail connection failed' });
    if (error instanceof MailConfigurationError) return reply.code(503).send({ status: 'error', message: 'Mail connector unavailable' });
    if ((error as { validation?: unknown }).validation || error instanceof TypeError) {
      return reply.code(400).send({ status: 'error', message: 'Invalid request' });
    }
    request.log.error({ error }, 'Unhandled request error');
    return reply.code(500).send({ status: 'error', message: 'Internal server error' });
  });

  app.addHook('onClose', async () => database.close());
  return app;
}
