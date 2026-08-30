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

interface StoredDraft { createdAt: number; value: TransientEventDraft }

const drafts = new Map<string, StoredDraft>();
const DRAFT_TTL_MS = 10 * 60_000;
const MAX_DRAFTS = 5;

function clearExpired() {
  const threshold = Date.now() - DRAFT_TTL_MS;
  for (const [id, draft] of drafts) if (draft.createdAt < threshold) drafts.delete(id);
}

export function createTransientEventDraft(value: TransientEventDraft) {
  clearExpired();
  while (drafts.size >= MAX_DRAFTS) {
    const oldest = drafts.keys().next().value as string | undefined;
    if (!oldest) break;
    drafts.delete(oldest);
  }
  const id = Crypto.randomUUID();
  drafts.set(id, { createdAt: Date.now(), value });
  return id;
}

export function readTransientEventDraft(id?: string) {
  clearExpired();
  if (!id) return undefined;
  return drafts.get(id)?.value;
}

export function discardTransientEventDraft(id?: string) {
  if (id) drafts.delete(id);
}
