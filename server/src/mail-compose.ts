import { randomBytes } from 'node:crypto';

import MailComposer from 'nodemailer/lib/mail-composer/index.js';

import type { OutgoingMailAttachment, OutgoingMailInput } from './types.js';

const MAX_FILES = 10;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_REGISTRY_BYTES = 20 * 1024 * 1024;
const ATTACHMENT_TTL_MS = 15 * 60_000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const mimePattern = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

interface StoredAttachment extends OutgoingMailAttachment {
  token: string;
  deviceId: string;
  createdAt: number;
  claimed: boolean;
}

export interface AttachmentUploadInput { name: string; mimeType: string; data: string }
export interface AttachmentMetadata { token: string; name: string; mimeType: string; size: number }
export class MailAttachmentNotFoundError extends Error {}

export function validateOutgoingMail(input: OutgoingMailInput) {
  const recipients = [...input.to, ...input.cc, ...input.bcc];
  if (!input.to.length || recipients.length > 25 || recipients.some((address) => address.length > 320 || !emailPattern.test(address))) {
    throw new TypeError('Invalid mail recipients');
  }
  if (new Set(recipients.map((address) => address.toLowerCase())).size !== recipients.length) throw new TypeError('Duplicate mail recipients');
  if (input.subject.length > 500 || /[\u0000-\u001f\u007f]/.test(input.subject)) throw new TypeError('Invalid mail subject');
  if (input.body.length > 200_000 || /\u0000/.test(input.body)) throw new TypeError('Invalid mail body');
}

export async function buildMimeMessage(from: string, input: OutgoingMailInput, attachments: OutgoingMailAttachment[], keepBcc = false) {
  validateOutgoingMail(input);
  if (!emailPattern.test(from) || attachments.length > MAX_FILES || attachments.reduce((total, item) => total + item.size, 0) > MAX_TOTAL_BYTES
    || (!input.body.trim() && !attachments.length)) throw new TypeError('Invalid outgoing mail');
  const composer = new MailComposer({
    from,
    to: input.to,
    ...(input.cc.length ? { cc: input.cc } : {}),
    ...(input.bcc.length ? { bcc: input.bcc } : {}),
    subject: input.subject,
    text: input.body,
    attachments: attachments.map((item) => ({ filename: item.name, contentType: item.mimeType, content: item.content })),
  });
  const message = composer.compile(); message.keepBcc = keepBcc;
  return await new Promise<Buffer>((resolve, reject) => message.build((error, value) => error ? reject(error) : resolve(value)));
}

export interface MailAttachmentRegistry {
  upload(deviceId: string, input: AttachmentUploadInput): AttachmentMetadata;
  discard(deviceId: string, tokens: string[]): void;
  withClaim<T>(deviceId: string, tokens: string[], operation: (attachments: OutgoingMailAttachment[]) => Promise<T>): Promise<T>;
}

export function createMailAttachmentRegistry(): MailAttachmentRegistry {
  const values = new Map<string, StoredAttachment>();
  const destroy = (token: string) => { const value = values.get(token); value?.content.fill(0); values.delete(token); };
  const cleanup = () => { const expiredBefore = Date.now() - ATTACHMENT_TTL_MS; for (const value of values.values()) if (value.createdAt < expiredBefore) destroy(value.token); };
  const deviceValues = (deviceId: string) => [...values.values()].filter((value) => value.deviceId === deviceId);

  return {
    upload: (deviceId, input) => {
      cleanup();
      const name = input.name.trim(); const mimeType = input.mimeType.trim().toLowerCase();
      if (!name || name.length > 255 || name === '.' || name === '..' || /[\/\\\u0000-\u001f\u007f]/.test(name)
        || !mimePattern.test(mimeType) || !input.data || input.data.length > Math.ceil(MAX_TOTAL_BYTES / 3) * 4 + 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data)) throw new TypeError('Invalid mail attachment');
      const content = Buffer.from(input.data, 'base64');
      if (!content.length || content.length > MAX_TOTAL_BYTES || content.toString('base64') !== input.data) { content.fill(0); throw new TypeError('Invalid mail attachment'); }
      const existing = deviceValues(deviceId);
      const registryBytes = [...values.values()].reduce((total, item) => total + item.size, 0);
      if (existing.length >= MAX_FILES || existing.reduce((total, item) => total + item.size, 0) + content.length > MAX_TOTAL_BYTES
        || registryBytes + content.length > MAX_REGISTRY_BYTES) {
        content.fill(0); throw new TypeError('Mail attachment limit reached');
      }
      const token = randomBytes(32).toString('base64url');
      const stored: StoredAttachment = { token, deviceId, name, mimeType, size: content.length, content, createdAt: Date.now(), claimed: false };
      values.set(token, stored);
      return { token, name, mimeType, size: content.length };
    },
    discard: (deviceId, tokens) => {
      cleanup();
      if (tokens.length > MAX_FILES || tokens.some((token) => !tokenPattern.test(token))) throw new TypeError('Invalid attachment tokens');
      for (const token of new Set(tokens)) { const value = values.get(token); if (value?.deviceId === deviceId && !value.claimed) destroy(token); }
    },
    withClaim: async (deviceId, tokens, operation) => {
      cleanup();
      if (tokens.length > MAX_FILES || new Set(tokens).size !== tokens.length || tokens.some((token) => !tokenPattern.test(token))) throw new TypeError('Invalid attachment tokens');
      const selected = tokens.map((token) => values.get(token));
      if (selected.some((value) => !value || value.deviceId !== deviceId || value.claimed)) throw new MailAttachmentNotFoundError('Mail attachment not found');
      const attachments = selected as StoredAttachment[];
      if (attachments.reduce((total, item) => total + item.size, 0) > MAX_TOTAL_BYTES) throw new TypeError('Mail attachment limit reached');
      attachments.forEach((value) => { value.claimed = true; });
      try {
        const result = await operation(attachments.map(({ name, mimeType, size, content }) => ({ name, mimeType, size, content })));
        attachments.forEach((value) => destroy(value.token));
        return result;
      } catch (error) {
        attachments.forEach((value) => { value.claimed = false; });
        throw error;
      }
    },
  };
}
