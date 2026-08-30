import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { AuthenticationError, authenticateDevice, registerDevice } from './auth.js';
import type { ServerConfig } from './config.js';
import { createDatabase } from './database.js';
import { createMailService, MailConfigurationError, MailConnectionError, MailNotFoundError, type ConnectImapInput, type MailService } from './mail-service.js';
import { connectImapSchema, mailAccountListSchema, mailAccountParamsSchema, mailMessageParamsSchema, mailSyncSchema, registerDeviceSchema, syncSchema } from './schemas.js';
import { synchronize } from './sync-service.js';
import type { SyncRequestBody } from './types.js';

interface RegisterBody {
  setupCode: string;
  name: string;
}

export async function buildApp(config: ServerConfig, dependencies: { mailService?: MailService } = {}) {
  const app = Fastify({ logger: config.logger, bodyLimit: 1024 * 1024 });
  const database = createDatabase(config.databasePath);
  const mailService = dependencies.mailService ?? createMailService(database, config);

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
    return { status: 'success', data: { accounts: mailService.accounts() } };
  });

  app.post<{ Body: ConnectImapInput }>('/v1/mail/accounts/imap', {
    schema: connectImapSchema,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request, reply) => {
    authenticateDevice(database, request);
    const result = await mailService.connectImap(request.body);
    return reply.code(201).send({ status: 'success', data: result });
  });

  app.post<{ Body: { accountId?: string } }>('/v1/mail/sync', {
    schema: mailSyncSchema,
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request) => {
    authenticateDevice(database, request);
    return { status: 'success', data: await mailService.synchronize(request.body.accountId) };
  });

  app.get<{ Params: { accountId: string; messageId: string } }>('/v1/mail/messages/:accountId/:messageId', {
    schema: mailMessageParamsSchema,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request) => {
    authenticateDevice(database, request);
    return { status: 'success', data: await mailService.content(request.params.accountId, request.params.messageId) };
  });

  app.delete<{ Params: { accountId: string } }>('/v1/mail/accounts/:accountId', { schema: mailAccountParamsSchema }, async (request, reply) => {
    authenticateDevice(database, request);
    mailService.remove(request.params.accountId);
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
    if (error instanceof MailNotFoundError) return reply.code(404).send({ status: 'error', message: 'Mail resource not found' });
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
