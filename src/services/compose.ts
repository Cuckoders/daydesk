import type { MailAccount } from "../types";

export interface SelectedMailAttachment {
  token: string;
  name: string;
  size: number;
  mimeType: string;
}

export interface SendMailInput {
  provider: MailAccount["provider"];
  accountId: string;
  fromAddress: string;
  smtpHost?: string;
  smtpPort?: number;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachmentTokens: string[];
}

export interface SendMailResult {
  sent: boolean;
}

const isDesktopApp = () => "__TAURI_INTERNALS__" in window;

async function invokeCompose<T>(command: string, payload: Record<string, unknown>): Promise<T> {
  if (!isDesktopApp()) throw new Error("Отправка писем доступна в установленном приложении DayDesk");
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(command, payload);
  } catch (error) {
    if (typeof error === "string") throw new Error(error);
    if (error instanceof Error) throw error;
    throw new Error("Не удалось выполнить операцию с исходящим письмом");
  }
}

export async function selectMailAttachments(): Promise<SelectedMailAttachment[]> {
  if (!isDesktopApp()) throw new Error("Выбор файлов доступен в установленном приложении DayDesk");
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({
    title: "Выберите вложения для письма",
    multiple: true,
    directory: false,
  });
  if (!selected) return [];
  const paths = Array.isArray(selected) ? selected : [selected];
  return invokeCompose<SelectedMailAttachment[]>("register_mail_attachments", { paths });
}

export const clearMailAttachments = (tokens: string[]) =>
  invokeCompose<void>("clear_mail_attachments", { tokens });

export const sendMail = (input: SendMailInput) =>
  invokeCompose<SendMailResult>("send_mail", { input });
