import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

import type { ServerConfig } from './config.js';
import type { DayDeskDatabase } from './database.js';
import type { DeviceRecord } from './types.js';

export class AuthenticationError extends Error {}

const digest = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

function constantTimeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function registerDevice(database: DayDeskDatabase, config: ServerConfig, setupCode: string, name: string) {
  if (!constantTimeEqual(config.setupCode, setupCode)) throw new AuthenticationError('Invalid setup code');
  if (!name.trim()) throw new TypeError('Device name is required');
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO devices (id, name, token_hash, created_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name.trim(), digest(token), now, now);
  return { id, token };
}

export function authenticateDevice(database: DayDeskDatabase, request: FastifyRequest): DeviceRecord {
  const authorization = request.headers.authorization;
  const deviceId = request.headers['x-device-id'];
  if (!authorization?.startsWith('Bearer ') || typeof deviceId !== 'string') throw new AuthenticationError('Authentication required');
  const token = authorization.slice('Bearer '.length);
  if (token.length < 32 || token.length > 256) throw new AuthenticationError('Authentication required');
  const row = database.prepare(`
    SELECT id, name, token_hash AS tokenHash, revoked_at AS revokedAt
    FROM devices
    WHERE id = ? AND token_hash = ? AND revoked_at IS NULL
  `).get(deviceId, digest(token)) as DeviceRecord | undefined;
  if (!row) throw new AuthenticationError('Authentication required');
  database.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
  return row;
}
