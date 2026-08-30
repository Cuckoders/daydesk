import path from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  databasePath: string;
  setupCode: string;
  allowedOrigins: string[];
  logger: boolean;
  mailEncryptionKey?: Buffer;
  allowPrivateMailHosts?: boolean;
}

function readMailEncryptionKey(value?: string) {
  if (!value?.trim()) return undefined;
  const key = Buffer.from(value.trim(), 'base64url');
  if (key.length !== 32) throw new Error('DAYDESK_MAIL_KEY must be a base64url encoded 32-byte key');
  return key;
}

export function loadConfig(): ServerConfig {
  const setupCode = process.env.DAYDESK_SETUP_CODE?.trim();
  if (!setupCode || setupCode.length < 12) {
    throw new Error('DAYDESK_SETUP_CODE must contain at least 12 characters');
  }

  const rawPort = Number(process.env.DAYDESK_PORT ?? 4310);
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error('DAYDESK_PORT must be a valid TCP port');
  }

  const mailEncryptionKey = readMailEncryptionKey(process.env.DAYDESK_MAIL_KEY);
  return {
    host: process.env.DAYDESK_HOST?.trim() || '127.0.0.1',
    port: rawPort,
    databasePath: path.resolve(process.env.DAYDESK_DB_PATH?.trim() || './data/daydesk-sync.sqlite'),
    setupCode,
    allowedOrigins: (process.env.DAYDESK_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    logger: process.env.NODE_ENV !== 'test',
    allowPrivateMailHosts: process.env.DAYDESK_ALLOW_PRIVATE_MAIL_HOSTS === 'true',
    ...(mailEncryptionKey ? { mailEncryptionKey } : {}),
  };
}
