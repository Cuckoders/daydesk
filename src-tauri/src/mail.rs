use crate::downloads::{
    safe_filename, save_attachment, DownloadResultDto, MailAttachmentDto, MAX_ATTACHMENT_BYTES,
};
use chrono::Utc;
use imap::types::Flag;
use lettre::{
    transport::smtp::authentication::Credentials, Message as LettreMessage, SmtpTransport,
    Transport,
};
use mail_parser::{Message, MessageParser, MimeHeaders};
use native_tls::{TlsConnector, TlsStream};
use serde::{Deserialize, Serialize};
use std::net::TcpStream;
use tauri::AppHandle;
use zeroize::Zeroizing;

const KEYRING_SERVICE: &str = "ru.daydesk.desktop.imap";
const FETCH_LIMIT: u32 = 30;
const MAX_BODY_BYTES: usize = 1_048_576;
const MAX_BODY_CHARS: usize = 200_000;
const MAX_RAW_MESSAGE_BYTES: usize = 25 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapConnectionInput {
    account_id: String,
    host: String,
    port: u16,
    username: String,
    password: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapSyncInput {
    account_id: String,
    host: String,
    port: u16,
    username: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapMessageContentInput {
    account_id: String,
    host: String,
    port: u16,
    username: String,
    message_id: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapAttachmentInput {
    account_id: String,
    host: String,
    port: u16,
    username: String,
    message_id: String,
    attachment_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapMessageDto {
    id: String,
    sender: String,
    subject: String,
    preview: String,
    received_at: String,
    unread: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailContentDto {
    pub(crate) body: String,
    pub(crate) has_attachments: bool,
    pub(crate) attachments: Vec<MailAttachmentDto>,
}

pub(crate) struct SmtpSendConfig {
    pub(crate) account_id: String,
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) username: String,
}

fn validate_account_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Некорректный идентификатор почтового аккаунта".into());
    }
    Ok(())
}

fn validate_host(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 253
        || value.starts_with('.')
        || value.ends_with('.')
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
    {
        return Err("Укажите корректный IMAP-сервер".into());
    }
    Ok(())
}

fn validate_username(value: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.len() > 320 || value.chars().any(char::is_control) {
        return Err("Укажите корректный логин".into());
    }
    Ok(())
}

fn validate_connection(
    account_id: &str,
    host: &str,
    port: u16,
    username: &str,
) -> Result<(), String> {
    validate_account_id(account_id)?;
    validate_host(host)?;
    validate_username(username)?;
    if port != 993 {
        return Err("DayDesk поддерживает только защищённый IMAP через порт 993".into());
    }
    Ok(())
}

fn validate_smtp_connection(host: &str, port: u16, username: &str) -> Result<(), String> {
    validate_host(host).map_err(|_| "Укажите корректный SMTP-сервер".to_string())?;
    validate_username(username)?;
    if !matches!(port, 465 | 587) {
        return Err("DayDesk поддерживает SMTP только через TLS на портах 465 или 587".into());
    }
    Ok(())
}

fn vault_entry(account_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, account_id)
        .map_err(|_| "Системное хранилище паролей недоступно".into())
}

fn connect_session(
    host: &str,
    port: u16,
    username: &str,
    password: &str,
) -> Result<imap::Session<TlsStream<TcpStream>>, String> {
    let tls = TlsConnector::builder()
        .build()
        .map_err(|_| "Не удалось подготовить защищённое соединение".to_string())?;
    let client = imap::connect((host, port), host, &tls)
        .map_err(|_| "Не удалось установить защищённое соединение с IMAP-сервером".to_string())?;
    client
        .login(username, password)
        .map_err(|_| "Проверьте адрес почты и пароль приложения".to_string())
}

pub(crate) fn send_smtp_message(
    config: SmtpSendConfig,
    message: &LettreMessage,
) -> Result<(), String> {
    validate_account_id(&config.account_id)?;
    validate_smtp_connection(&config.host, config.port, &config.username)?;
    let password = Zeroizing::new(vault_entry(&config.account_id)?.get_password().map_err(
        |_| "Пароль не найден в системном хранилище. Подключите почту заново".to_string(),
    )?);
    let credentials = Credentials::new(config.username, password.to_string());
    let builder = if config.port == 465 {
        SmtpTransport::relay(&config.host)
    } else {
        SmtpTransport::starttls_relay(&config.host)
    }
    .map_err(|_| "Не удалось подготовить защищённое SMTP-соединение".to_string())?;
    let transport = builder
        .port(config.port)
        .credentials(credentials)
        .timeout(Some(std::time::Duration::from_secs(30)))
        .build();
    transport.send(message).map(|_| ()).map_err(|_| {
        "SMTP-сервер не принял письмо. Проверьте адрес сервера и пароль приложения".to_string()
    })
}

pub(crate) fn normalize_body(value: &str) -> String {
    let normalized = value.replace("\r\n", "\n").replace('\r', "\n");
    let mut body = normalized
        .trim()
        .chars()
        .take(MAX_BODY_CHARS)
        .collect::<String>();
    if normalized.trim().chars().count() > MAX_BODY_CHARS {
        body.push_str("\n\n[Письмо сокращено для безопасного просмотра]");
    }
    body
}

pub(crate) fn html_to_text(value: &str) -> String {
    html2text::from_read(value.as_bytes(), 100)
        .map(|body| normalize_body(&body))
        .unwrap_or_else(|_| "HTML-содержимое письма не удалось безопасно преобразовать".to_string())
}

fn parse_message_content(raw: &[u8]) -> Result<MailContentDto, String> {
    let parsed = MessageParser::default()
        .parse(raw)
        .ok_or_else(|| "Не удалось разобрать содержимое письма".to_string())?;
    let body = parsed
        .body_text(0)
        .map(|value| normalize_body(&value))
        .or_else(|| parsed.body_html(0).map(|value| html_to_text(&value)))
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "В письме нет доступного текстового содержимого".to_string());
    Ok(MailContentDto {
        body,
        has_attachments: parsed.attachment_count() > 0,
        attachments: attachment_list(&parsed),
    })
}

fn attachment_mime_type(part: &mail_parser::MessagePart<'_>) -> String {
    part.content_type()
        .map(|content_type| {
            format!(
                "{}/{}",
                content_type.ctype(),
                content_type.subtype().unwrap_or("octet-stream")
            )
        })
        .unwrap_or_else(|| "application/octet-stream".to_string())
}

fn attachment_list(message: &Message<'_>) -> Vec<MailAttachmentDto> {
    message
        .attachments()
        .take(50)
        .enumerate()
        .map(|(index, part)| MailAttachmentDto {
            id: index.to_string(),
            name: safe_filename(part.attachment_name().unwrap_or("attachment.bin")),
            size: part.contents().len() as u64,
            mime_type: attachment_mime_type(part),
            downloadable: part.contents().len() <= MAX_ATTACHMENT_BYTES,
        })
        .collect()
}

fn decode_bytes(value: Option<&[u8]>, fallback: &str) -> String {
    value
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn fetch_messages(
    session: &mut imap::Session<TlsStream<TcpStream>>,
) -> Result<Vec<ImapMessageDto>, String> {
    let mailbox = session
        .select("INBOX")
        .map_err(|_| "Не удалось открыть папку «Входящие»".to_string())?;
    if mailbox.exists == 0 {
        return Ok(Vec::new());
    }

    let start = mailbox.exists.saturating_sub(FETCH_LIMIT - 1).max(1);
    let sequence = format!("{start}:{}", mailbox.exists);
    let fetched = session
        .fetch(
            sequence,
            "(UID ENVELOPE INTERNALDATE FLAGS BODY.PEEK[TEXT]<0.240>)",
        )
        .map_err(|_| "Не удалось загрузить письма".to_string())?;

    let mut messages = fetched
        .iter()
        .map(|message| {
            let envelope = message.envelope();
            let sender = envelope
                .and_then(|value| value.from.as_ref())
                .and_then(|addresses| addresses.first())
                .map(|address| {
                    let name = decode_bytes(address.name, "");
                    let mailbox = decode_bytes(address.mailbox, "");
                    let host = decode_bytes(address.host, "");
                    let email = match (mailbox.is_empty(), host.is_empty()) {
                        (false, false) => Some(format!("{mailbox}@{host}")),
                        _ => None,
                    };
                    match (name.is_empty(), email) {
                        (false, Some(email)) => format!("{name} <{email}>"),
                        (false, None) => name,
                        (true, Some(email)) => email,
                        (true, None) => "Неизвестный отправитель".to_string(),
                    }
                })
                .unwrap_or_else(|| "Неизвестный отправитель".to_string());
            let subject = envelope
                .and_then(|value| value.subject)
                .map(|value| String::from_utf8_lossy(value).trim().to_string())
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Без темы".to_string());
            let preview = message
                .text()
                .map(|value| {
                    String::from_utf8_lossy(value)
                        .split_whitespace()
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "Откройте письмо в почтовом клиенте".to_string());
            let unread = !message
                .flags()
                .iter()
                .any(|flag| matches!(flag, Flag::Seen));
            ImapMessageDto {
                id: message.uid.unwrap_or(message.message).to_string(),
                sender,
                subject,
                preview,
                received_at: message
                    .internal_date()
                    .map(|value| value.to_rfc3339())
                    .unwrap_or_else(|| Utc::now().to_rfc3339()),
                unread,
            }
        })
        .collect::<Vec<_>>();
    messages.reverse();
    Ok(messages)
}

fn sync_with_password(
    input: &ImapSyncInput,
    password: &str,
) -> Result<Vec<ImapMessageDto>, String> {
    validate_connection(&input.account_id, &input.host, input.port, &input.username)?;
    let mut session = connect_session(&input.host, input.port, &input.username, password)?;
    let messages = fetch_messages(&mut session)?;
    let _ = session.logout();
    Ok(messages)
}

fn message_content_with_password(
    input: &ImapMessageContentInput,
    password: &str,
) -> Result<MailContentDto, String> {
    validate_connection(&input.account_id, &input.host, input.port, &input.username)?;
    let uid = input
        .message_id
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "Некорректный идентификатор письма".to_string())?;
    let mut session = connect_session(&input.host, input.port, &input.username, password)?;
    session
        .select("INBOX")
        .map_err(|_| "Не удалось открыть папку «Входящие»".to_string())?;
    let query = format!("(UID BODY.PEEK[]<0.{MAX_BODY_BYTES}>)");
    let fetched = session
        .uid_fetch(uid.to_string(), query)
        .map_err(|_| "Не удалось загрузить содержимое письма".to_string())?;
    let result = fetched
        .iter()
        .next()
        .and_then(|message| message.body())
        .ok_or_else(|| "Письмо не найдено во входящих".to_string())
        .and_then(parse_message_content);
    let _ = session.logout();
    result
}

fn imap_attachment_with_password(
    input: &ImapAttachmentInput,
    password: &str,
) -> Result<(String, Vec<u8>), String> {
    validate_connection(&input.account_id, &input.host, input.port, &input.username)?;
    let uid = input
        .message_id
        .parse::<u32>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| "Некорректный идентификатор письма".to_string())?;
    let attachment_index = input
        .attachment_id
        .parse::<u32>()
        .ok()
        .filter(|value| *value < 50)
        .ok_or_else(|| "Некорректный идентификатор вложения".to_string())?;
    let mut session = connect_session(&input.host, input.port, &input.username, password)?;
    session
        .select("INBOX")
        .map_err(|_| "Не удалось открыть папку «Входящие»".to_string())?;
    let query = format!("(UID RFC822.SIZE BODY.PEEK[]<0.{MAX_RAW_MESSAGE_BYTES}>)");
    let fetched = session
        .uid_fetch(uid.to_string(), query)
        .map_err(|_| "Не удалось загрузить вложение".to_string())?;
    let result = fetched
        .iter()
        .next()
        .ok_or_else(|| "Письмо не найдено во входящих".to_string())
        .and_then(|message| {
            if message
                .size
                .is_some_and(|size| size as usize > MAX_RAW_MESSAGE_BYTES)
            {
                return Err("Письмо слишком большое для безопасной загрузки вложения".to_string());
            }
            message
                .body()
                .ok_or_else(|| "Не удалось прочитать MIME-содержимое письма".to_string())
        })
        .and_then(|raw| {
            let parsed = MessageParser::default()
                .parse(raw)
                .ok_or_else(|| "Не удалось разобрать MIME-содержимое письма".to_string())?;
            let attachment = parsed
                .attachment(attachment_index)
                .ok_or_else(|| "Вложение не найдено".to_string())?;
            if attachment.contents().is_empty()
                || attachment.contents().len() > MAX_ATTACHMENT_BYTES
            {
                return Err("Размер вложения должен быть от 1 байта до 20 МБ".to_string());
            }
            Ok((
                safe_filename(attachment.attachment_name().unwrap_or("attachment.bin")),
                attachment.contents().to_vec(),
            ))
        });
    let _ = session.logout();
    result
}

#[tauri::command]
pub async fn connect_imap(input: ImapConnectionInput) -> Result<Vec<ImapMessageDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ImapConnectionInput {
            account_id,
            host,
            port,
            username,
            password,
        } = input;
        let password = Zeroizing::new(password);
        validate_connection(&account_id, &host, port, &username)?;
        if password.is_empty() || password.len() > 1024 {
            return Err("Укажите корректный пароль приложения".into());
        }
        let sync_input = ImapSyncInput {
            account_id: account_id.clone(),
            host,
            port,
            username,
        };
        let messages = sync_with_password(&sync_input, password.as_str())?;
        vault_entry(&account_id)?
            .set_password(password.as_str())
            .map_err(|_| "Не удалось сохранить пароль в системном хранилище".to_string())?;
        Ok(messages)
    })
    .await
    .map_err(|_| "Не удалось завершить подключение почты".to_string())?
}

#[tauri::command]
pub async fn sync_imap(input: ImapSyncInput) -> Result<Vec<ImapMessageDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_connection(&input.account_id, &input.host, input.port, &input.username)?;
        let password = Zeroizing::new(vault_entry(&input.account_id)?.get_password().map_err(
            |_| "Пароль не найден в системном хранилище. Подключите почту заново".to_string(),
        )?);
        sync_with_password(&input, password.as_str())
    })
    .await
    .map_err(|_| "Не удалось завершить синхронизацию почты".to_string())?
}

#[tauri::command]
pub async fn get_imap_message_content(
    input: ImapMessageContentInput,
) -> Result<MailContentDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_connection(&input.account_id, &input.host, input.port, &input.username)?;
        let password = Zeroizing::new(vault_entry(&input.account_id)?.get_password().map_err(
            |_| "Пароль не найден в системном хранилище. Подключите почту заново".to_string(),
        )?);
        message_content_with_password(&input, password.as_str())
    })
    .await
    .map_err(|_| "Не удалось завершить загрузку письма".to_string())?
}

#[tauri::command]
pub async fn download_imap_attachment(
    app: AppHandle,
    input: ImapAttachmentInput,
) -> Result<DownloadResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_connection(&input.account_id, &input.host, input.port, &input.username)?;
        let password = Zeroizing::new(vault_entry(&input.account_id)?.get_password().map_err(
            |_| "Пароль не найден в системном хранилище. Подключите почту заново".to_string(),
        )?);
        let (name, bytes) = imap_attachment_with_password(&input, password.as_str())?;
        save_attachment(&app, &name, &bytes)
    })
    .await
    .map_err(|_| "Не удалось завершить загрузку вложения".to_string())?
}

#[tauri::command]
pub async fn disconnect_imap(account_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_account_id(&account_id)?;
        match vault_entry(&account_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Не удалось удалить пароль из системного хранилища".to_string()),
        }
    })
    .await
    .map_err(|_| "Не удалось завершить отключение почты".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_secure_imap_configuration() {
        assert!(
            validate_connection("account_1", "imap.example.com", 993, "me@example.com").is_ok()
        );
    }

    #[test]
    fn rejects_insecure_port() {
        assert!(
            validate_connection("account_1", "imap.example.com", 143, "me@example.com").is_err()
        );
    }

    #[test]
    fn smtp_requires_smtps_or_starttls_ports() {
        assert!(validate_smtp_connection("smtp.example.com", 465, "me@example.com").is_ok());
        assert!(validate_smtp_connection("smtp.example.com", 587, "me@example.com").is_ok());
        assert!(validate_smtp_connection("smtp.example.com", 25, "me@example.com").is_err());
    }

    #[test]
    fn rejects_unsafe_host_and_account_id() {
        assert!(
            validate_connection("../secret", "https://example.com", 993, "me@example.com").is_err()
        );
    }

    #[test]
    fn parses_plain_text_without_executing_html() {
        let raw = b"From: sender@example.com\r\nSubject: Test\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<script>alert('x')</script><p>Hello <strong>DayDesk</strong></p>";
        let content = parse_message_content(raw).expect("message parses");
        assert!(content.body.contains("Hello DayDesk"));
        assert!(!content.body.contains("<script>"));
        assert!(!content.has_attachments);
        assert!(content.attachments.is_empty());
    }

    #[test]
    fn extracts_attachment_metadata_and_decoded_bytes() {
        let raw = b"From: sender@example.com\r\nSubject: Files\r\nContent-Type: multipart/mixed; boundary=daydesk\r\n\r\n--daydesk\r\nContent-Type: text/plain\r\n\r\nBody\r\n--daydesk\r\nContent-Type: application/pdf; name=report.pdf\r\nContent-Disposition: attachment; filename=report.pdf\r\nContent-Transfer-Encoding: base64\r\n\r\nUERGREFUQQ==\r\n--daydesk--\r\n";
        let parsed = MessageParser::default().parse(raw).expect("parse MIME");
        let attachments = attachment_list(&parsed);
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].name, "report.pdf");
        assert_eq!(attachments[0].mime_type, "application/pdf");
        assert_eq!(
            parsed.attachment(0).expect("attachment").contents(),
            b"PDFDATA"
        );
    }
}
