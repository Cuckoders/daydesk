use crate::{
    downloads::safe_filename,
    mail::{self, SmtpSendConfig},
    oauth::{self, OAuthProvider},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use lettre::{
    message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart},
    Message,
};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::State;

const MAX_RECIPIENTS: usize = 25;
const MAX_SUBJECT_CHARS: usize = 500;
const MAX_BODY_CHARS: usize = 200_000;
const MAX_SELECTED_FILES: usize = 10;
const MAX_OUTGOING_ATTACHMENT_BYTES: usize = 2 * 1024 * 1024;
const MAX_OUTGOING_MIME_BYTES: usize = 4 * 1024 * 1024;
const ATTACHMENT_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone)]
struct RegisteredAttachment {
    name: String,
    mime_type: String,
    bytes: Vec<u8>,
    registered_at: Instant,
}

#[derive(Clone, Default)]
pub struct ComposeState {
    attachments: Arc<Mutex<HashMap<String, RegisteredAttachment>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectedAttachmentDto {
    token: String,
    name: String,
    size: u64,
    mime_type: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum OutgoingProvider {
    Gmail,
    Outlook,
    Imap,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMailInput {
    provider: OutgoingProvider,
    account_id: String,
    from_address: String,
    smtp_host: Option<String>,
    smtp_port: Option<u16>,
    to: Vec<String>,
    #[serde(default)]
    cc: Vec<String>,
    #[serde(default)]
    bcc: Vec<String>,
    subject: String,
    body: String,
    #[serde(default)]
    attachment_tokens: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMailResultDto {
    sent: bool,
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

fn parse_mailbox(value: &str, field: &str) -> Result<Mailbox, String> {
    if value.is_empty()
        || value.len() > 320
        || value.chars().any(char::is_control)
        || !value.contains('@')
    {
        return Err(format!("Укажите корректный адрес в поле «{field}»"));
    }
    value
        .parse::<Mailbox>()
        .map_err(|_| format!("Укажите корректный адрес в поле «{field}»"))
}

fn parse_recipients(values: &[String], field: &str) -> Result<Vec<Mailbox>, String> {
    values
        .iter()
        .map(|value| parse_mailbox(value.trim(), field))
        .collect()
}

fn validate_input(input: &SendMailInput) -> Result<(), String> {
    validate_account_id(&input.account_id)?;
    parse_mailbox(input.from_address.trim(), "От кого")?;
    let recipient_count = input.to.len() + input.cc.len() + input.bcc.len();
    if input.to.is_empty() || recipient_count > MAX_RECIPIENTS {
        return Err("Укажите от 1 до 25 получателей".into());
    }
    parse_recipients(&input.to, "Кому")?;
    parse_recipients(&input.cc, "Копия")?;
    parse_recipients(&input.bcc, "Скрытая копия")?;
    if input.subject.chars().count() > MAX_SUBJECT_CHARS
        || input.subject.chars().any(char::is_control)
    {
        return Err("Тема письма должна быть короче 500 символов".into());
    }
    if input.body.chars().count() > MAX_BODY_CHARS {
        return Err("Текст письма должен быть короче 200 000 символов".into());
    }
    if input.body.trim().is_empty() && input.attachment_tokens.is_empty() {
        return Err("Добавьте текст или вложение".into());
    }
    if input.attachment_tokens.len() > MAX_SELECTED_FILES {
        return Err("К одному письму можно прикрепить не больше 10 файлов".into());
    }
    let unique = input.attachment_tokens.iter().collect::<HashSet<&String>>();
    if unique.len() != input.attachment_tokens.len()
        || input.attachment_tokens.iter().any(|token| {
            token.len() < 20
                || token.len() > 64
                || !token
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
    {
        return Err("Некорректный список вложений".into());
    }
    Ok(())
}

fn build_message(
    input: &SendMailInput,
    attachments: &[RegisteredAttachment],
) -> Result<Message, String> {
    let mut builder = Message::builder()
        .from(parse_mailbox(input.from_address.trim(), "От кого")?)
        .subject(input.subject.trim());
    for recipient in parse_recipients(&input.to, "Кому")? {
        builder = builder.to(recipient);
    }
    for recipient in parse_recipients(&input.cc, "Копия")? {
        builder = builder.cc(recipient);
    }
    for recipient in parse_recipients(&input.bcc, "Скрытая копия")? {
        builder = builder.bcc(recipient);
    }
    if attachments.is_empty() {
        return builder
            .singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_PLAIN)
                    .body(input.body.clone()),
            )
            .map_err(|_| "Не удалось подготовить письмо".to_string());
    }

    let mut multipart = MultiPart::mixed().singlepart(
        SinglePart::builder()
            .header(ContentType::TEXT_PLAIN)
            .body(input.body.clone()),
    );
    for attachment in attachments {
        let content_type = attachment
            .mime_type
            .parse::<ContentType>()
            .unwrap_or(ContentType::parse("application/octet-stream").expect("valid MIME type"));
        multipart = multipart.singlepart(
            Attachment::new(attachment.name.clone()).body(attachment.bytes.clone(), content_type),
        );
    }
    builder
        .multipart(multipart)
        .map_err(|_| "Не удалось подготовить письмо с вложениями".to_string())
}

fn attachment_token() -> String {
    let mut bytes = [0_u8; 24];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn load_selected_file(path_value: &str) -> Result<RegisteredAttachment, String> {
    if path_value.is_empty() || path_value.len() > 4096 {
        return Err("Получен некорректный путь к вложению".into());
    }
    let path = Path::new(path_value);
    if !path.is_absolute() {
        return Err("Выберите вложение через системный диалог".into());
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "Не удалось открыть выбранное вложение".to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Вложением может быть только обычный файл".into());
    }
    if metadata.len() == 0 || metadata.len() > MAX_OUTGOING_ATTACHMENT_BYTES as u64 {
        return Err("Размер исходящих вложений должен быть от 1 байта до 2 МБ".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map_err(|_| "Не удалось открыть выбранное вложение".to_string())?
        .take(MAX_OUTGOING_ATTACHMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Не удалось прочитать выбранное вложение".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_OUTGOING_ATTACHMENT_BYTES {
        return Err("Размер исходящих вложений должен быть от 1 байта до 2 МБ".into());
    }
    Ok(RegisteredAttachment {
        name: safe_filename(
            path.file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("attachment.bin"),
        ),
        mime_type: mime_guess::from_path(path)
            .first_or_octet_stream()
            .essence_str()
            .to_string(),
        bytes,
        registered_at: Instant::now(),
    })
}

impl ComposeState {
    fn take(&self, tokens: &[String]) -> Result<Vec<RegisteredAttachment>, String> {
        let mut registry = self
            .attachments
            .lock()
            .map_err(|_| "Хранилище вложений временно недоступно".to_string())?;
        registry.retain(|_, attachment| attachment.registered_at.elapsed() < ATTACHMENT_TTL);
        if tokens.iter().any(|token| !registry.contains_key(token)) {
            return Err("Одно из вложений устарело. Выберите файлы заново".into());
        }
        Ok(tokens
            .iter()
            .filter_map(|token| registry.remove(token))
            .collect())
    }

    fn restore(&self, values: Vec<(String, RegisteredAttachment)>) {
        if let Ok(mut registry) = self.attachments.lock() {
            for (token, mut attachment) in values {
                attachment.registered_at = Instant::now();
                registry.insert(token, attachment);
            }
        }
    }
}

#[tauri::command]
pub fn register_mail_attachments(
    paths: Vec<String>,
    state: State<'_, ComposeState>,
) -> Result<Vec<SelectedAttachmentDto>, String> {
    if paths.is_empty() || paths.len() > MAX_SELECTED_FILES {
        return Err("Выберите от 1 до 10 файлов".into());
    }
    let attachments = paths
        .iter()
        .map(|path| load_selected_file(path))
        .collect::<Result<Vec<_>, _>>()?;
    let total = attachments
        .iter()
        .map(|attachment| attachment.bytes.len())
        .sum::<usize>();
    if total > MAX_OUTGOING_ATTACHMENT_BYTES {
        return Err("Общий размер исходящих вложений не должен превышать 2 МБ".into());
    }

    let mut registry = state
        .attachments
        .lock()
        .map_err(|_| "Хранилище вложений временно недоступно".to_string())?;
    registry.retain(|_, attachment| attachment.registered_at.elapsed() < ATTACHMENT_TTL);
    let result = attachments
        .into_iter()
        .map(|attachment| {
            let token = attachment_token();
            let dto = SelectedAttachmentDto {
                token: token.clone(),
                name: attachment.name.clone(),
                size: attachment.bytes.len() as u64,
                mime_type: attachment.mime_type.clone(),
            };
            registry.insert(token, attachment);
            dto
        })
        .collect();
    Ok(result)
}

#[tauri::command]
pub fn clear_mail_attachments(tokens: Vec<String>, state: State<'_, ComposeState>) {
    if let Ok(mut registry) = state.attachments.lock() {
        for token in tokens {
            registry.remove(&token);
        }
    }
}

#[tauri::command]
pub async fn send_mail(
    input: SendMailInput,
    state: State<'_, ComposeState>,
) -> Result<SendMailResultDto, String> {
    validate_input(&input)?;
    let registry = state.inner().clone();
    let tokens = input.attachment_tokens.clone();
    let attachments = registry.take(&tokens)?;
    let restore_values = tokens
        .iter()
        .cloned()
        .zip(attachments.iter().cloned())
        .collect::<Vec<_>>();
    let message = match build_message(&input, &attachments) {
        Ok(message) => message,
        Err(error) => {
            registry.restore(restore_values);
            return Err(error);
        }
    };
    let mime = message.formatted();
    if mime.len() > MAX_OUTGOING_MIME_BYTES {
        registry.restore(restore_values);
        return Err("Письмо слишком большое для безопасной отправки".into());
    }

    let account_id = input.account_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || match input.provider {
        OutgoingProvider::Gmail => oauth::send_oauth_mime(OAuthProvider::Gmail, &account_id, &mime),
        OutgoingProvider::Outlook => {
            oauth::send_oauth_mime(OAuthProvider::Outlook, &account_id, &mime)
        }
        OutgoingProvider::Imap => mail::send_smtp_message(
            SmtpSendConfig {
                account_id,
                host: input.smtp_host.unwrap_or_default(),
                port: input.smtp_port.unwrap_or_default(),
                username: input.from_address,
            },
            &message,
        ),
    })
    .await
    .map_err(|_| "Не удалось завершить отправку письма".to_string())?;
    if let Err(error) = result {
        registry.restore(restore_values);
        return Err(error);
    }
    Ok(SendMailResultDto { sent: true })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid_input() -> SendMailInput {
        SendMailInput {
            provider: OutgoingProvider::Gmail,
            account_id: "mail_account_1".into(),
            from_address: "sender@example.com".into(),
            smtp_host: None,
            smtp_port: None,
            to: vec!["recipient@example.com".into()],
            cc: Vec::new(),
            bcc: Vec::new(),
            subject: "План встречи".into(),
            body: "Добрый день!".into(),
            attachment_tokens: Vec::new(),
        }
    }

    #[test]
    fn rejects_header_injection_and_missing_recipient() {
        let mut input = valid_input();
        input.to = vec!["friend@example.com\r\nBcc: attacker@example.com".into()];
        assert!(validate_input(&input).is_err());
        input.to.clear();
        assert!(validate_input(&input).is_err());
    }

    #[test]
    fn builds_plain_text_mime_without_exposing_bcc_header() {
        let mut input = valid_input();
        input.bcc = vec!["private@example.com".into()];
        let message = build_message(&input, &[]).expect("build message");
        let formatted = String::from_utf8_lossy(&message.formatted()).to_string();
        assert!(formatted.contains("Content-Type: text/plain"));
        assert!(!formatted.contains("Bcc:"));
        assert!(!formatted.contains("private@example.com"));
    }

    #[test]
    fn attachment_tokens_are_single_use_and_restorable() {
        let state = ComposeState::default();
        let token = attachment_token();
        let attachment = RegisteredAttachment {
            name: "report.txt".into(),
            mime_type: "text/plain".into(),
            bytes: b"report".to_vec(),
            registered_at: Instant::now(),
        };
        state
            .attachments
            .lock()
            .expect("registry")
            .insert(token.clone(), attachment);
        let selected = state.take(std::slice::from_ref(&token)).expect("take");
        assert!(state.take(std::slice::from_ref(&token)).is_err());
        state.restore(vec![(token.clone(), selected[0].clone())]);
        assert!(state.take(&[token]).is_ok());
    }

    #[test]
    fn reads_only_absolute_regular_files_and_builds_attachment_mime() {
        assert!(load_selected_file("relative/report.txt").is_err());
        let directory = std::env::temp_dir().join(format!(
            "daydesk-compose-test-{}-{}",
            std::process::id(),
            attachment_token()
        ));
        fs::create_dir_all(&directory).expect("create test directory");
        let path = directory.join("meeting notes.txt");
        fs::write(&path, b"safe attachment").expect("write attachment");
        let attachment = load_selected_file(path.to_str().expect("utf-8 path")).expect("load");
        assert_eq!(attachment.name, "meeting notes.txt");
        assert_eq!(attachment.mime_type, "text/plain");
        let message = build_message(&valid_input(), &[attachment]).expect("build MIME");
        let formatted = String::from_utf8_lossy(&message.formatted()).to_string();
        assert!(formatted.contains("meeting notes.txt"));
        assert!(formatted.contains("multipart/mixed"));
        fs::remove_file(path).expect("remove attachment");
        fs::remove_dir(directory).expect("remove test directory");
    }
}
