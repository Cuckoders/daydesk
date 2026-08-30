import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';

import type { FastifyInstance } from 'fastify';

import { buildApp } from '../src/app.js';
import type { ServerConfig } from '../src/config.js';

const config: ServerConfig = {
  host: '127.0.0.1',
  port: 4310,
  databasePath: ':memory:',
  setupCode: 'test-setup-code-1234',
  allowedOrigins: ['http://localhost:8081'],
  logger: false,
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

async function register(app: FastifyInstance, name = 'Test iPhone') {
  const response = await app.inject({ method: 'POST', url: '/v1/devices/register', payload: { setupCode: config.setupCode, name } });
  assert.equal(response.statusCode, 201);
  return response.json().data as { id: string; token: string };
}

function task(id: string, updatedAt: string) {
  return {
    id,
    title: 'Синхронизированная задача',
    completed: false,
    dueAt: '2026-09-01T09:00:00.000Z',
    priority: 'high',
    category: 'Работа',
    reminderEnabled: true,
    remindBeforeMinutes: 10,
    recurrence: 'none',
    updatedAt,
    syncVersion: 1,
  };
}

test('registration rejects an invalid setup code', async () => {
  const app = await buildApp(config);
  apps.push(app);
  const response = await app.inject({ method: 'POST', url: '/v1/devices/register', payload: { setupCode: 'invalid-code!', name: 'Unknown' } });
  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), { status: 'error', message: 'Authentication failed' });
});

test('sync requires a registered device and rejects malformed changes', async () => {
  const app = await buildApp(config);
  apps.push(app);
  const unauthorized = await app.inject({ method: 'POST', url: '/v1/sync', payload: { cursor: 0, changes: [] } });
  assert.equal(unauthorized.statusCode, 401);
  assert.deepEqual(unauthorized.json(), { status: 'error', message: 'Authentication failed' });

  const device = await register(app);
  const malformed = await app.inject({
    method: 'POST',
    url: '/v1/sync',
    headers: { authorization: `Bearer ${device.token}`, 'x-device-id': device.id },
    payload: { cursor: 0, changes: [{ id: 'bad', entity: 'task', entityId: 'task-1', operation: 'upsert', updatedAt: 'not-a-date', payload: {} }] },
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(malformed.json(), { status: 'error', message: 'Invalid request' });
});

test('authenticated devices exchange changes and duplicate operations are idempotent', async () => {
  const app = await buildApp(config);
  apps.push(app);
  const first = await register(app, 'iPhone');
  const second = await register(app, 'Mac');
  const updatedAt = '2026-08-30T12:00:00.000Z';
  const operation = { id: randomUUID(), entity: 'task', entityId: 'task-shared', operation: 'upsert', updatedAt, payload: task('task-shared', updatedAt) };

  const push = await app.inject({
    method: 'POST', url: '/v1/sync', headers: { authorization: `Bearer ${first.token}`, 'x-device-id': first.id }, payload: { cursor: 0, changes: [operation] },
  });
  assert.equal(push.statusCode, 200);
  assert.deepEqual(push.json().data.acceptedOperationIds, [operation.id]);

  const duplicate = await app.inject({
    method: 'POST', url: '/v1/sync', headers: { authorization: `Bearer ${first.token}`, 'x-device-id': first.id }, payload: { cursor: 0, changes: [operation] },
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate.json().data.changes.length, 1);

  const pull = await app.inject({
    method: 'POST', url: '/v1/sync', headers: { authorization: `Bearer ${second.token}`, 'x-device-id': second.id }, payload: { cursor: 0, changes: [] },
  });
  assert.equal(pull.statusCode, 200);
  assert.equal(pull.json().data.changes[0].payload.title, 'Синхронизированная задача');
});

test('newer updates win and tombstones propagate', async () => {
  const app = await buildApp(config);
  apps.push(app);
  const device = await register(app);
  const headers = { authorization: `Bearer ${device.token}`, 'x-device-id': device.id };
  const newer = '2026-08-30T14:00:00.000Z';
  const older = '2026-08-30T13:00:00.000Z';

  await app.inject({ method: 'POST', url: '/v1/sync', headers, payload: { cursor: 0, changes: [{ id: randomUUID(), entity: 'task', entityId: 'task-1', operation: 'upsert', updatedAt: newer, payload: task('task-1', newer) }] } });
  await app.inject({ method: 'POST', url: '/v1/sync', headers, payload: { cursor: 0, changes: [{ id: randomUUID(), entity: 'task', entityId: 'task-1', operation: 'delete', updatedAt: older }] } });
  const deletion = await app.inject({ method: 'POST', url: '/v1/sync', headers, payload: { cursor: 0, changes: [{ id: randomUUID(), entity: 'task', entityId: 'task-1', operation: 'delete', updatedAt: '2026-08-30T15:00:00.000Z' }] } });
  const changes = deletion.json().data.changes as { operation: string }[];
  assert.equal(changes.at(-1)?.operation, 'delete');
  assert.equal(changes.filter((change) => change.operation === 'delete').length, 1);
});

test('revoking a device invalidates its token', async () => {
  const app = await buildApp(config);
  apps.push(app);
  const device = await register(app);
  const headers = { authorization: `Bearer ${device.token}`, 'x-device-id': device.id };
  const revoked = await app.inject({ method: 'DELETE', url: '/v1/devices/current', headers });
  assert.equal(revoked.statusCode, 204);
  const sync = await app.inject({ method: 'POST', url: '/v1/sync', headers, payload: { cursor: 0, changes: [] } });
  assert.equal(sync.statusCode, 401);
});
