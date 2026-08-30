import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';

import { AuthenticationError, authenticateDevice, registerDevice } from './auth.js';
import type { ServerConfig } from './config.js';
import { createDatabase } from './database.js';
import { registerDeviceSchema, syncSchema } from './schemas.js';
import { synchronize } from './sync-service.js';
import type { SyncRequestBody } from './types.js';

interface RegisterBody {
  setupCode: string;
  name: string;
}

export async function buildApp(config: ServerConfig) {
  const app = Fastify({ logger: config.logger, bodyLimit: 256 * 1024 });
  const database = createDatabase(config.databasePath);

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

  app.delete('/v1/devices/current', { schema: { headers: syncSchema.headers } }, async (request, reply) => {
    const device = authenticateDevice(database, request);
    database.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), device.id);
    return reply.code(204).send();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AuthenticationError) {
      return reply.code(401).send({ status: 'error', message: 'Authentication failed' });
    }
    if ((error as { validation?: unknown }).validation || error instanceof TypeError) {
      return reply.code(400).send({ status: 'error', message: 'Invalid request' });
    }
    request.log.error({ error }, 'Unhandled request error');
    return reply.code(500).send({ status: 'error', message: 'Internal server error' });
  });

  app.addHook('onClose', async () => database.close());
  return app;
}
