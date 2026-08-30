import type { MailMessage } from "../types";

function isDesktopApp() {
  return "__TAURI_INTERNALS__" in window;
}

async function invokeCache<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, payload);
}

export async function loadMailCache(): Promise<MailMessage[]> {
  if (!isDesktopApp()) return [];
  return invokeCache<MailMessage[]>("load_mail_cache");
}

export async function replaceMailCache(messages: MailMessage[]): Promise<void> {
  if (!isDesktopApp()) return;
  await invokeCache<void>("replace_mail_cache", { messages });
}

export async function searchMailCache(query: string, limit = 100): Promise<MailMessage[] | null> {
  if (!isDesktopApp()) return null;
  return invokeCache<MailMessage[]>("search_mail_cache", { query, limit });
}
