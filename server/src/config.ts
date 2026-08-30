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
  oauthPublicUrl?: string;
  googleClientId?: string;
  googleClientSecret?: string;
  microsoftClientId?: string;
  microsoftClientSecret?: string;
}

function readMailEncryptionKey(value?: string) {
  if (!value?.trim()) return undefined;
  const key = Buffer.from(value.trim(), 'base64url');
  if (key.length !== 32) throw new Error('DAYDESK_MAIL_KEY must be a base64url encoded 32-byte key');
  return key;
}

function readOptionalSecret(value: string | undefined, name: string, maxLength = 512) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${name} is invalid`);
  return normalized;
}

function readOAuthPublicUrl(value?: string) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const url = new URL(normalized);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DAYDESK_OAUTH_PUBLIC_URL must be an HTTPS origin');
  }
  return url.toString().replace(/\/$/, '');
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
  const oauthPublicUrl = readOAuthPublicUrl(process.env.DAYDESK_OAUTH_PUBLIC_URL);
  const googleClientId = readOptionalSecret(process.env.DAYDESK_GOOGLE_CLIENT_ID, 'DAYDESK_GOOGLE_CLIENT_ID');
  const googleClientSecret = readOptionalSecret(process.env.DAYDESK_GOOGLE_CLIENT_SECRET, 'DAYDESK_GOOGLE_CLIENT_SECRET', 1024);
  const microsoftClientId = readOptionalSecret(process.env.DAYDESK_MICROSOFT_CLIENT_ID, 'DAYDESK_MICROSOFT_CLIENT_ID');
  const microsoftClientSecret = readOptionalSecret(process.env.DAYDESK_MICROSOFT_CLIENT_SECRET, 'DAYDESK_MICROSOFT_CLIENT_SECRET', 1024);
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
    ...(oauthPublicUrl ? { oauthPublicUrl } : {}),
    ...(googleClientId ? { googleClientId } : {}),
    ...(googleClientSecret ? { googleClientSecret } : {}),
    ...(microsoftClientId ? { microsoftClientId } : {}),
    ...(microsoftClientSecret ? { microsoftClientSecret } : {}),
  };
}
