import type { DownloadResult, RemoteMailContent, RemoteMailMessage } from "./mail";

export type OAuthProvider = "gmail" | "outlook";

export interface OAuthProviderStatus {
  gmail: boolean;
  outlook: boolean;
}

export interface OAuthConnectResult {
  address: string;
  label: string;
  messages: RemoteMailMessage[];
}

interface OAuthAccountInput {
  provider: OAuthProvider;
  accountId: string;
}

interface OAuthMessageContentInput extends OAuthAccountInput {
  messageId: string;
}

interface OAuthAttachmentInput extends OAuthMessageContentInput {
  attachmentId: string;
}

function isDesktopApp() {
  return "__TAURI_INTERNALS__" in window;
}

async function invokeOAuth<T>(command: string, input?: OAuthAccountInput): Promise<T> {
  if (!isDesktopApp()) {
    throw new Error("OAuth-подключение доступно в установленном приложении DayDesk");
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, input ? { input } : undefined);
  } catch (error) {
    if (typeof error === "string") throw new Error(error);
    if (error instanceof Error) throw error;
    throw new Error("Не удалось выполнить OAuth-операцию");
  }
}

export async function getOAuthProviderStatus(): Promise<OAuthProviderStatus> {
  if (!isDesktopApp()) return { gmail: false, outlook: false };
  return invokeOAuth<OAuthProviderStatus>("oauth_provider_status");
}

export const connectOAuth = (input: OAuthAccountInput) =>
  invokeOAuth<OAuthConnectResult>("connect_oauth", input);

export const syncOAuth = (input: OAuthAccountInput) =>
  invokeOAuth<RemoteMailMessage[]>("sync_oauth", input);

export const getOAuthMessageContent = (input: OAuthMessageContentInput) =>
  invokeOAuth<RemoteMailContent>("get_oauth_message_content", input);

export const downloadOAuthAttachment = (input: OAuthAttachmentInput) =>
  invokeOAuth<DownloadResult>("download_oauth_attachment", input);

export const disconnectOAuth = (input: OAuthAccountInput) =>
  invokeOAuth<void>("disconnect_oauth", input);
