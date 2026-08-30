export interface ImapConnectionInput {
  accountId: string;
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface ImapSyncInput {
  accountId: string;
  host: string;
  port: number;
  username: string;
}

export interface ImapMessageContentInput extends ImapSyncInput {
  messageId: string;
}

export interface ImapAttachmentInput extends ImapMessageContentInput {
  attachmentId: string;
}

export interface RemoteMailMessage {
  id: string;
  sender: string;
  subject: string;
  preview: string;
  receivedAt: string;
  unread: boolean;
}

export interface RemoteMailContent {
  body: string;
  hasAttachments: boolean;
  attachments: RemoteMailAttachment[];
}

export interface RemoteMailAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  downloadable: boolean;
}

export interface DownloadResult {
  fileName: string;
  path: string;
}

function isDesktopApp() {
  return "__TAURI_INTERNALS__" in window;
}

async function call<T>(command: string, payload: Record<string, unknown>): Promise<T> {
  if (!isDesktopApp()) {
    throw new Error("Подключение почты доступно в установленном приложении DayDesk");
  }
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, payload);
  } catch (error) {
    if (typeof error === "string") throw new Error(error);
    if (error instanceof Error) throw error;
    throw new Error("Не удалось выполнить операцию с почтой");
  }
}

export const connectImap = (input: ImapConnectionInput) =>
  call<RemoteMailMessage[]>("connect_imap", { input });

export const syncImap = (input: ImapSyncInput) =>
  call<RemoteMailMessage[]>("sync_imap", { input });

export const getImapMessageContent = (input: ImapMessageContentInput) =>
  call<RemoteMailContent>("get_imap_message_content", { input });

export const downloadImapAttachment = (input: ImapAttachmentInput) =>
  call<DownloadResult>("download_imap_attachment", { input });

export const disconnectImap = (accountId: string) =>
  call<void>("disconnect_imap", { accountId });
