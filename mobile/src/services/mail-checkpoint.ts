import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import type { MailAccount, MailMessage } from '@/src/types';

const REGISTRY_KEY = 'daydesk.mail-checkpoints.v1';
const CHECKPOINT_PREFIX = 'daydesk.mail-checkpoint.v1.';
const ACCOUNT_LIMIT = 20;
const MESSAGE_LIMIT = 50;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digestPattern = /^[0-9a-f]{24}$/;

let checkpointWork: Promise<unknown> = Promise.resolve();

function checkpointKey(accountId: string) { return `${CHECKPOINT_PREFIX}${accountId}`; }

function serialized<T>(work: () => Promise<T>) {
  const result = checkpointWork.then(work, work);
  checkpointWork = result.then(() => undefined, () => undefined);
  return result;
}

async function digestMessage(message: Pick<MailMessage, 'accountId' | 'id' | 'folder'>) {
  const value = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${message.accountId}\0${message.folder}\0${message.id}`);
  return value.slice(0, 24);
}

function readStringArray(value: string | null, pattern: RegExp, limit: number) {
  if (!value || value.length > 4_096) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length > limit || !parsed.every((item) => typeof item === 'string' && pattern.test(item))) return undefined;
    return [...new Set(parsed)];
  } catch { return undefined; }
}

async function readRegistry() {
  return readStringArray(await SecureStore.getItemAsync(REGISTRY_KEY), uuidPattern, ACCOUNT_LIMIT) ?? [];
}

async function hashesByAccount(messages: MailMessage[], accounts: MailAccount[]) {
  const accountIds = new Set(accounts.map((account) => account.id));
  const groupedMessages = new Map<string, MailMessage[]>();
  const grouped = new Map<string, { all: string[]; unread: Set<string> }>();
  for (const account of accounts.slice(0, ACCOUNT_LIMIT)) groupedMessages.set(account.id, []);
  for (const message of messages.slice(0, ACCOUNT_LIMIT * MESSAGE_LIMIT)) {
    if (message.folder !== 'inbox' || !accountIds.has(message.accountId)) continue;
    const values = groupedMessages.get(message.accountId);
    if (values && values.length < MESSAGE_LIMIT) values.push(message);
  }
  for (const [accountId, accountMessages] of groupedMessages) {
    const entries = await Promise.all(accountMessages.map(async (message) => ({ digest: await digestMessage(message), unread: message.unread })));
    grouped.set(accountId, { all: entries.map((entry) => entry.digest), unread: new Set(entries.filter((entry) => entry.unread).map((entry) => entry.digest)) });
  }
  return grouped;
}

async function storeSnapshot(messages: MailMessage[], accounts: MailAccount[], complete: boolean, countNew: boolean) {
  if (Platform.OS === 'web') return 0;
  const grouped = await hashesByAccount(messages, accounts);
  const previousRegistry = await readRegistry();
  let newUnread = 0;
  for (const account of accounts.slice(0, ACCOUNT_LIMIT)) {
    const key = checkpointKey(account.id); const previousRaw = await SecureStore.getItemAsync(key);
    const previous = readStringArray(previousRaw, digestPattern, MESSAGE_LIMIT);
    const current = grouped.get(account.id) ?? { all: [], unread: new Set<string>() };
    if (countNew && previous) {
      const known = new Set(previous);
      newUnread += current.all.filter((value) => !known.has(value) && current.unread.has(value)).length;
    }
    await SecureStore.setItemAsync(key, JSON.stringify(current.all));
  }
  const currentIds = accounts.slice(0, ACCOUNT_LIMIT).map((account) => account.id);
  if (complete) {
    await Promise.all(previousRegistry.filter((accountId) => !currentIds.includes(accountId)).map((accountId) => SecureStore.deleteItemAsync(checkpointKey(accountId))));
    await SecureStore.setItemAsync(REGISTRY_KEY, JSON.stringify(currentIds));
  } else {
    await SecureStore.setItemAsync(REGISTRY_KEY, JSON.stringify([...new Set([...currentIds, ...previousRegistry])].slice(0, ACCOUNT_LIMIT)));
  }
  return newUnread;
}

export function recordMailSnapshot(messages: MailMessage[], accounts: MailAccount[], complete: boolean) {
  return serialized(() => storeSnapshot(messages, accounts, complete, false));
}

export function compareAndRecordMailSnapshot(messages: MailMessage[], accounts: MailAccount[]) {
  return serialized(() => storeSnapshot(messages, accounts, true, true));
}

export function clearMailCheckpoints() {
  return serialized(async () => {
    if (Platform.OS === 'web') return;
    const accounts = await readRegistry();
    await Promise.all([...accounts.map((accountId) => SecureStore.deleteItemAsync(checkpointKey(accountId))), SecureStore.deleteItemAsync(REGISTRY_KEY)]);
  });
}
