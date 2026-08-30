import * as Crypto from 'expo-crypto';

export interface TransientEventDraft {
  title: string;
  startsAt: string;
  endsAt: string;
  location?: string;
  allDay: boolean;
  allDayStartDate?: string;
  allDayEndDate?: string;
  source: 'mail-invitation';
}

export interface TransientTaskDraft {
  title: string;
  dueAt: string;
  source: 'mail-message';
}

interface StoredDraft<T> { createdAt: number; value: T }

const eventDrafts = new Map<string, StoredDraft<TransientEventDraft>>();
const taskDrafts = new Map<string, StoredDraft<TransientTaskDraft>>();
const DRAFT_TTL_MS = 10 * 60_000;
const MAX_DRAFTS = 5;
const controlCharacters = /[\u0000-\u001f\u007f]+/g;

function clearExpired<T>(drafts: Map<string, StoredDraft<T>>) {
  const threshold = Date.now() - DRAFT_TTL_MS;
  for (const [id, draft] of drafts) if (draft.createdAt < threshold) drafts.delete(id);
}

function storeDraft<T>(drafts: Map<string, StoredDraft<T>>, value: T) {
  clearExpired(drafts);
  while (drafts.size >= MAX_DRAFTS) {
    const oldest = drafts.keys().next().value;
    if (!oldest) break;
    drafts.delete(oldest);
  }
  const id = Crypto.randomUUID();
  drafts.set(id, { createdAt: Date.now(), value });
  return id;
}

function readDraft<T>(drafts: Map<string, StoredDraft<T>>, id?: string) {
  clearExpired(drafts);
  if (!id) return undefined;
  return drafts.get(id)?.value;
}

export function createTransientEventDraft(value: TransientEventDraft) {
  return storeDraft(eventDrafts, value);
}

export function readTransientEventDraft(id?: string) {
  return readDraft(eventDrafts, id);
}

export function discardTransientEventDraft(id?: string) {
  if (id) eventDrafts.delete(id);
}

export function createMailTaskDraft(subject: string) {
  const cleanSubject = subject.replace(controlCharacters, ' ').replace(/\s+/g, ' ').trim().slice(0, 480);
  const dueAt = new Date();
  dueAt.setDate(dueAt.getDate() + 1);
  dueAt.setHours(9, 0, 0, 0);
  return storeDraft(taskDrafts, {
    title: cleanSubject ? `Разобрать письмо: ${cleanSubject}`.slice(0, 500) : 'Разобрать письмо',
    dueAt: dueAt.toISOString(),
    source: 'mail-message',
  });
}

export function readTransientTaskDraft(id?: string) {
  return readDraft(taskDrafts, id);
}

export function discardTransientTaskDraft(id?: string) {
  if (id) taskDrafts.delete(id);
}
