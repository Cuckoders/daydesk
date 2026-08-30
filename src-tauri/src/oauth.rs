use crate::{
    downloads::{
        safe_filename, save_attachment, DownloadResultDto, MailAttachmentDto, MAX_ATTACHMENT_BYTES,
    },
    mail::{html_to_text, normalize_body, MailContentDto},
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rand::{rngs::OsRng, RngCore};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use url::Url;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const OAUTH_KEYRING_SERVICE: &str = "ru.daydesk.desktop.oauth";
const CALLBACK_TIMEOUT: Duration = Duration::from_secs(180);
const MESSAGE_LIMIT: usize = 20;
const MAX_MESSAGE_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_ATTACHMENT_RESPONSE_BYTES: usize = 28 * 1024 * 1024;

#[derive(Clone, Copy, Deserialize, Serialize, Zeroize)]
#[serde(rename_all = "lowercase")]
pub enum OAuthProvider {
    Gmail,
    Outlook,
}

impl OAuthProvider {
    fn name(self) -> &'static str {
        match self {
            Self::Gmail => "gmail",
            Self::Outlook => "outlook",
        }
    }

    fn client_id_env(self) -> &'static str {
        match self {
            Self::Gmail => "DAYDESK_GOOGLE_CLIENT_ID",
            Self::Outlook => "DAYDESK_MICROSOFT_CLIENT_ID",
        }
    }

    fn configured_client_id(self) -> Option<String> {
        let runtime = std::env::var(self.client_id_env()).ok();
        let compiled = match self {
            Self::Gmail => option_env!("DAYDESK_GOOGLE_CLIENT_ID"),
            Self::Outlook => option_env!("DAYDESK_MICROSOFT_CLIENT_ID"),
        };
        runtime
            .or_else(|| compiled.map(str::to_string))
            .filter(|value| !value.trim().is_empty() && value.len() <= 256)
    }

    fn client_id(self) -> Result<String, String> {
        self.configured_client_id().ok_or_else(|| {
            format!(
                "OAuth для {} пока не настроен в этой сборке DayDesk",
                match self {
                    Self::Gmail => "Gmail",
                    Self::Outlook => "Outlook",
                }
            )
        })
    }

    fn authorization_endpoint(self) -> &'static str {
        match self {
            Self::Gmail => "https://accounts.google.com/o/oauth2/v2/auth",
            Self::Outlook => "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        }
    }

    fn token_endpoint(self) -> &'static str {
        match self {
            Self::Gmail => "https://oauth2.googleapis.com/token",
            Self::Outlook => "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        }
    }

    fn scopes(self) -> &'static str {
        match self {
            Self::Gmail => "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
            Self::Outlook => "openid profile email offline_access User.Read Mail.Read Mail.Send",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAccountInput {
    provider: OAuthProvider,
    account_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthMessageContentInput {
    provider: OAuthProvider,
    account_id: String,
    message_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthAttachmentInput {
    provider: OAuthProvider,
    account_id: String,
    message_id: String,
    attachment_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthProviderStatus {
    gmail: bool,
    outlook: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthConnectResult {
    address: String,
    label: String,
    messages: Vec<OAuthMessageDto>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OAuthMessageDto {
    id: String,
    sender: String,
    subject: String,
    preview: String,
    received_at: String,
    unread: bool,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
struct OAuthTokenResponse {
    access_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleProfile {
    email_address: String,
}

#[derive(Deserialize)]
struct GoogleMessageList {
    #[serde(default)]
    messages: Vec<GoogleMessageId>,
}

#[derive(Deserialize)]
struct GoogleMessageId {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleMessage {
    id: String,
    #[serde(default)]
    label_ids: Vec<String>,
    #[serde(default)]
    snippet: String,
    internal_date: String,
    payload: GooglePayload,
}

#[derive(Deserialize)]
struct GooglePayload {
    #[serde(default)]
    headers: Vec<GoogleHeader>,
}

#[derive(Deserialize)]
struct GoogleContentMessage {
    #[serde(default)]
    snippet: String,
    payload: GoogleContentPart,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleContentPart {
    #[serde(default)]
    part_id: String,
    #[serde(default)]
    mime_type: String,
    #[serde(default)]
    filename: String,
    #[serde(default)]
    body: GoogleContentBody,
    #[serde(default)]
    parts: Vec<GoogleContentPart>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleContentBody {
    data: Option<String>,
    attachment_id: Option<String>,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
struct GoogleHeader {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftProfile {
    display_name: String,
    mail: Option<String>,
    user_principal_name: String,
}

#[derive(Deserialize)]
struct MicrosoftMessageList {
    #[serde(default)]
    value: Vec<MicrosoftMessage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftMessage {
    id: String,
    subject: Option<String>,
    body_preview: String,
    received_date_time: String,
    is_read: bool,
    from: Option<MicrosoftRecipient>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftMessageContent {
    body: MicrosoftItemBody,
    has_attachments: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftItemBody {
    content_type: String,
    content: String,
}

#[derive(Deserialize)]
struct MicrosoftAttachmentList {
    #[serde(default)]
    value: Vec<MicrosoftAttachment>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftAttachment {
    #[serde(rename = "@odata.type", default)]
    odata_type: String,
    id: String,
    name: String,
    #[serde(default)]
    content_type: String,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    is_inline: bool,
}

#[derive(Deserialize)]
struct GoogleAttachmentBody {
    data: String,
    #[serde(default)]
    size: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftRecipient {
    email_address: MicrosoftEmailAddress,
}

#[derive(Deserialize)]
struct MicrosoftEmailAddress {
    name: Option<String>,
    address: String,
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

fn validate_message_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 1_024
        || value.contains("..")
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'=' | b'+' | b'/')
        })
    {
        return Err("Некорректный идентификатор письма".into());
    }
    Ok(())
}

fn validate_attachment_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 2_048
        || value.contains("..")
        || value.chars().any(char::is_control)
    {
        return Err("Некорректный идентификатор вложения".into());
    }
    Ok(())
}

fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent("DayDesk/0.1")
        .build()
        .map_err(|_| "Не удалось подготовить защищённое соединение".into())
}

fn random_urlsafe(bytes: usize) -> String {
    let mut value = vec![0_u8; bytes];
    OsRng.fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}

fn authorization_url(
    provider: OAuthProvider,
    client_id: &str,
    redirect_uri: &str,
    state: &str,
    challenge: &str,
) -> Result<Url, String> {
    let mut url = Url::parse(provider.authorization_endpoint())
        .map_err(|_| "Не удалось подготовить адрес авторизации".to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", provider.scopes())
            .append_pair("state", state)
            .append_pair("code_challenge", challenge)
            .append_pair("code_challenge_method", "S256");
        if matches!(provider, OAuthProvider::Gmail) {
            query
                .append_pair("access_type", "offline")
                .append_pair("prompt", "consent");
        }
    }
    Ok(url)
}

fn browser_response(stream: &mut std::net::TcpStream, success: bool) {
    let (title, message) = if success {
        (
            "DayDesk подключён",
            "Можно закрыть эту вкладку и вернуться в DayDesk.",
        )
    } else {
        (
            "Подключение отменено",
            "Вернитесь в DayDesk и попробуйте ещё раз.",
        )
    };
    let body = format!(
        "<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><title>{title}</title><body style=\"font:16px system-ui;background:#f6f4ff;color:#302d45;display:grid;place-items:center;height:100vh;margin:0\"><main style=\"background:white;padding:32px;border-radius:18px;text-align:center;box-shadow:0 20px 60px #5040a622\"><h1>{title}</h1><p>{message}</p></main></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
}

fn wait_for_authorization(listener: TcpListener, expected_state: &str) -> Result<String, String> {
    listener
        .set_nonblocking(true)
        .map_err(|_| "Не удалось запустить локальный OAuth callback".to_string())?;
    let started = Instant::now();
    while started.elapsed() < CALLBACK_TIMEOUT {
        match listener.accept() {
            Ok((mut stream, _)) => {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let mut buffer = [0_u8; 8192];
                let count = stream.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..count]);
                let target = request
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let Ok(url) = Url::parse(&format!("http://localhost{target}")) else {
                    browser_response(&mut stream, false);
                    continue;
                };
                if url.path() != "/oauth/callback" {
                    browser_response(&mut stream, false);
                    continue;
                }
                let params = url
                    .query_pairs()
                    .collect::<std::collections::HashMap<_, _>>();
                if params.get("state").map(|value| value.as_ref()) != Some(expected_state) {
                    browser_response(&mut stream, false);
                    return Err("Проверка безопасности OAuth не пройдена".into());
                }
                if params.contains_key("error") {
                    browser_response(&mut stream, false);
                    return Err("Авторизация была отменена".into());
                }
                let code = params.get("code").map(ToString::to_string);
                browser_response(&mut stream, code.is_some());
                return code.ok_or_else(|| "Сервис авторизации не вернул код".into());
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return Err("Не удалось получить ответ авторизации".into()),
        }
    }
    Err("Время ожидания авторизации истекло".into())
}

fn exchange_code(
    provider: OAuthProvider,
    client: &Client,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<OAuthTokenResponse, String> {
    let mut form = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("redirect_uri", redirect_uri),
        ("grant_type", "authorization_code"),
    ];
    if matches!(provider, OAuthProvider::Outlook) {
        form.push(("scope", provider.scopes()));
    }
    client
        .post(provider.token_endpoint())
        .form(&form)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| "Сервис авторизации отклонил код входа".to_string())?
        .json::<OAuthTokenResponse>()
        .map_err(|_| "Получен некорректный ответ авторизации".to_string())
}

fn token_entry(provider: OAuthProvider, account_id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        OAUTH_KEYRING_SERVICE,
        &format!("{}:{account_id}", provider.name()),
    )
    .map_err(|_| "Системное хранилище токенов недоступно".into())
}

fn save_refresh_token(
    provider: OAuthProvider,
    account_id: &str,
    token: &str,
) -> Result<(), String> {
    token_entry(provider, account_id)?
        .set_secret(token.as_bytes())
        .map_err(|_| "Не удалось сохранить токен в системном хранилище".into())
}

fn load_refresh_token(
    provider: OAuthProvider,
    account_id: &str,
) -> Result<Zeroizing<Vec<u8>>, String> {
    token_entry(provider, account_id)?
        .get_secret()
        .map(Zeroizing::new)
        .map_err(|_| "Сессия не найдена. Подключите почту заново".to_string())
}

fn access_token(
    provider: OAuthProvider,
    account_id: &str,
    client: &Client,
) -> Result<Zeroizing<String>, String> {
    let refresh_token = load_refresh_token(provider, account_id)?;
    let refresh_token = std::str::from_utf8(refresh_token.as_slice())
        .map_err(|_| "Сохранённая сессия повреждена. Подключите почту заново".to_string())?;
    let client_id = provider.client_id()?;
    let mut form = vec![
        ("client_id", client_id.as_str()),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];
    if matches!(provider, OAuthProvider::Outlook) {
        form.push(("scope", provider.scopes()));
    }
    let response = client
        .post(provider.token_endpoint())
        .form(&form)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| "Не удалось обновить сессию. Подключите почту заново".to_string())?
        .json::<OAuthTokenResponse>()
        .map_err(|_| "Сервис авторизации вернул некорректный ответ".to_string())?;
    if let Some(rotated_refresh_token) = response.refresh_token.as_deref() {
        save_refresh_token(provider, account_id, rotated_refresh_token)?;
    }
    Ok(Zeroizing::new(response.access_token.clone()))
}

fn bearer_get<T: for<'de> Deserialize<'de>>(
    client: &Client,
    url: &str,
    token: &str,
) -> Result<T, String> {
    client
        .get(url)
        .bearer_auth(token)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| "Почтовый сервис временно недоступен".to_string())?
        .json::<T>()
        .map_err(|_| "Почтовый сервис вернул некорректный ответ".to_string())
}

fn bearer_get_limited<T: for<'de> Deserialize<'de>>(
    client: &Client,
    url: Url,
    token: &str,
    prefer_plain_text: bool,
    max_bytes: usize,
) -> Result<T, String> {
    let mut request = client.get(url).bearer_auth(token);
    if prefer_plain_text {
        request = request.header("Prefer", "outlook.body-content-type=\"text\"");
    }
    let response = request
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| "Не удалось загрузить содержимое письма".to_string())?;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("Письмо слишком большое для безопасного просмотра".into());
    }
    let mut bytes = Vec::new();
    response
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Не удалось прочитать содержимое письма".to_string())?;
    if bytes.len() > max_bytes {
        return Err("Письмо слишком большое для безопасного просмотра".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Почтовый сервис вернул некорректное письмо".to_string())
}

fn bearer_get_bytes_limited(
    client: &Client,
    url: Url,
    token: &str,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .bearer_auth(token)
        .send()
        .and_then(reqwest::blocking::Response::error_for_status)
        .map_err(|_| "Не удалось загрузить вложение".to_string())?;
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes as u64)
    {
        return Err("Вложение слишком большое для безопасной загрузки".into());
    }
    let mut bytes = Vec::new();
    response
        .take(max_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Не удалось прочитать вложение".to_string())?;
    if bytes.is_empty() || bytes.len() > max_bytes {
        return Err("Размер вложения должен быть от 1 байта до 20 МБ".into());
    }
    Ok(bytes)
}

pub(crate) fn send_oauth_mime(
    provider: OAuthProvider,
    account_id: &str,
    mime: &[u8],
) -> Result<(), String> {
    validate_account_id(account_id)?;
    if mime.is_empty() || mime.len() > 4 * 1024 * 1024 {
        return Err("Письмо слишком большое для безопасной отправки".into());
    }
    let client = http_client()?;
    let token = access_token(provider, account_id, &client)?;
    let response = match provider {
        OAuthProvider::Gmail => client
            .post("https://gmail.googleapis.com/gmail/v1/users/me/messages/send")
            .bearer_auth(token.as_str())
            .json(&serde_json::json!({ "raw": URL_SAFE_NO_PAD.encode(mime) }))
            .send(),
        OAuthProvider::Outlook => client
            .post("https://graph.microsoft.com/v1.0/me/sendMail")
            .bearer_auth(token.as_str())
            .header(reqwest::header::CONTENT_TYPE, "text/plain")
            .body(STANDARD.encode(mime))
            .send(),
    }
    .map_err(|_| "Не удалось связаться с почтовым сервисом".to_string())?;
    if response.status().is_success() {
        Ok(())
    } else if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        Err("Для отправки писем нужно переподключить аккаунт и разрешить DayDesk отправку".into())
    } else if response.status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
        Err("Письмо превышает лимит почтового сервиса".into())
    } else {
        Err("Почтовый сервис не принял письмо".into())
    }
}

fn provider_message_url(provider: OAuthProvider, message_id: &str) -> Result<Url, String> {
    validate_message_id(message_id)?;
    let base = match provider {
        OAuthProvider::Gmail => "https://gmail.googleapis.com/gmail/v1/users/me/messages/",
        OAuthProvider::Outlook => "https://graph.microsoft.com/v1.0/me/messages/",
    };
    let mut url =
        Url::parse(base).map_err(|_| "Не удалось подготовить адрес письма".to_string())?;
    url.path_segments_mut()
        .map_err(|_| "Не удалось подготовить адрес письма".to_string())?
        .push(message_id);
    match provider {
        OAuthProvider::Gmail => {
            url.query_pairs_mut().append_pair("format", "full");
        }
        OAuthProvider::Outlook => {
            url.query_pairs_mut()
                .append_pair("$select", "body,hasAttachments");
        }
    }
    Ok(url)
}

fn google_part_data(part: &GoogleContentPart, mime_type: &str) -> Option<String> {
    if part.filename.is_empty() && part.mime_type.eq_ignore_ascii_case(mime_type) {
        if let Some(data) = part.body.data.as_deref() {
            let decoded = URL_SAFE
                .decode(data)
                .or_else(|_| URL_SAFE_NO_PAD.decode(data))
                .ok()?;
            return Some(String::from_utf8_lossy(&decoded).to_string());
        }
    }
    part.parts
        .iter()
        .find_map(|child| google_part_data(child, mime_type))
}

fn google_has_attachments(part: &GoogleContentPart) -> bool {
    (!part.filename.is_empty() && part.body.attachment_id.is_some())
        || part.parts.iter().any(google_has_attachments)
}

fn google_attachment_key(part: &GoogleContentPart) -> Option<String> {
    part.body
        .attachment_id
        .as_ref()
        .map(|id| format!("remote:{id}"))
        .or_else(|| {
            part.body
                .data
                .as_ref()
                .filter(|_| !part.part_id.is_empty())
                .map(|_| format!("part:{}", part.part_id))
        })
}

fn collect_google_attachments(part: &GoogleContentPart, attachments: &mut Vec<MailAttachmentDto>) {
    if !part.filename.is_empty() && attachments.len() < 50 {
        if let Some(id) = google_attachment_key(part) {
            attachments.push(MailAttachmentDto {
                id,
                name: safe_filename(&part.filename),
                size: part.body.size,
                mime_type: if part.mime_type.is_empty() {
                    "application/octet-stream".to_string()
                } else {
                    part.mime_type.clone()
                },
                downloadable: part.body.size as usize <= MAX_ATTACHMENT_BYTES,
            });
        }
    }
    for child in &part.parts {
        collect_google_attachments(child, attachments);
    }
}

fn google_attachment_list(part: &GoogleContentPart) -> Vec<MailAttachmentDto> {
    let mut attachments = Vec::new();
    collect_google_attachments(part, &mut attachments);
    attachments
}

fn find_google_attachment<'a>(
    part: &'a GoogleContentPart,
    attachment_id: &str,
) -> Option<&'a GoogleContentPart> {
    if google_attachment_key(part).as_deref() == Some(attachment_id) && !part.filename.is_empty() {
        return Some(part);
    }
    part.parts
        .iter()
        .find_map(|child| find_google_attachment(child, attachment_id))
}

fn decode_google_attachment(data: &str) -> Result<Vec<u8>, String> {
    let bytes = URL_SAFE
        .decode(data)
        .or_else(|_| URL_SAFE_NO_PAD.decode(data))
        .map_err(|_| "Почтовый сервис вернул повреждённое вложение".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("Размер вложения должен быть от 1 байта до 20 МБ".to_string());
    }
    Ok(bytes)
}

fn google_attachment_bytes(
    client: &Client,
    token: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<(String, Vec<u8>), String> {
    validate_attachment_id(attachment_id)?;
    let message_url = provider_message_url(OAuthProvider::Gmail, message_id)?;
    let message: GoogleContentMessage = bearer_get_limited(
        client,
        message_url,
        token,
        false,
        MAX_ATTACHMENT_RESPONSE_BYTES,
    )?;
    let part = find_google_attachment(&message.payload, attachment_id)
        .ok_or_else(|| "Вложение не найдено".to_string())?;
    if part.body.size as usize > MAX_ATTACHMENT_BYTES {
        return Err("Вложение слишком большое для безопасной загрузки".to_string());
    }
    let bytes = if let Some(remote_id) = attachment_id.strip_prefix("remote:") {
        validate_attachment_id(remote_id)?;
        let mut url = provider_message_url(OAuthProvider::Gmail, message_id)?;
        url.set_query(None);
        {
            let mut segments = url
                .path_segments_mut()
                .map_err(|_| "Не удалось подготовить адрес вложения".to_string())?;
            segments.push("attachments").push(remote_id);
        }
        let body: GoogleAttachmentBody =
            bearer_get_limited(client, url, token, false, MAX_ATTACHMENT_RESPONSE_BYTES)?;
        if body.size as usize > MAX_ATTACHMENT_BYTES {
            return Err("Вложение слишком большое для безопасной загрузки".to_string());
        }
        decode_google_attachment(&body.data)?
    } else if attachment_id.starts_with("part:") {
        decode_google_attachment(
            part.body
                .data
                .as_deref()
                .ok_or_else(|| "Данные вложения недоступны".to_string())?,
        )?
    } else {
        return Err("Некорректный идентификатор вложения".to_string());
    };
    Ok((safe_filename(&part.filename), bytes))
}

fn microsoft_attachments_url(message_id: &str) -> Result<Url, String> {
    let mut url = provider_message_url(OAuthProvider::Outlook, message_id)?;
    url.set_query(None);
    url.path_segments_mut()
        .map_err(|_| "Не удалось подготовить адрес вложений".to_string())?
        .push("attachments");
    url.query_pairs_mut()
        .append_pair("$top", "50")
        .append_pair("$select", "id,name,contentType,size,isInline");
    Ok(url)
}

fn microsoft_attachment_list(
    client: &Client,
    token: &str,
    message_id: &str,
) -> Result<Vec<MicrosoftAttachment>, String> {
    let url = microsoft_attachments_url(message_id)?;
    let list: MicrosoftAttachmentList =
        bearer_get_limited(client, url, token, false, MAX_MESSAGE_RESPONSE_BYTES)?;
    Ok(list
        .value
        .into_iter()
        .filter(|attachment| !attachment.is_inline)
        .take(50)
        .collect())
}

fn microsoft_attachment_dtos(attachments: &[MicrosoftAttachment]) -> Vec<MailAttachmentDto> {
    attachments
        .iter()
        .map(|attachment| MailAttachmentDto {
            id: attachment.id.clone(),
            name: safe_filename(&attachment.name),
            size: attachment.size,
            mime_type: if attachment.content_type.is_empty() {
                "application/octet-stream".to_string()
            } else {
                attachment.content_type.clone()
            },
            downloadable: !attachment.odata_type.ends_with("referenceAttachment")
                && attachment.size as usize <= MAX_ATTACHMENT_BYTES,
        })
        .collect()
}

fn microsoft_attachment_bytes(
    client: &Client,
    token: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<(String, Vec<u8>), String> {
    validate_attachment_id(attachment_id)?;
    let attachments = microsoft_attachment_list(client, token, message_id)?;
    let attachment = attachments
        .into_iter()
        .find(|attachment| attachment.id == attachment_id)
        .ok_or_else(|| "Вложение не найдено".to_string())?;
    if attachment.odata_type.ends_with("referenceAttachment") {
        return Err("Ссылочное вложение можно открыть только в Outlook".to_string());
    }
    if attachment.size as usize > MAX_ATTACHMENT_BYTES {
        return Err("Вложение слишком большое для безопасной загрузки".to_string());
    }
    let mut url = microsoft_attachments_url(message_id)?;
    url.set_query(None);
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Не удалось подготовить адрес вложения".to_string())?;
        segments.push(attachment_id).push("$value");
    }
    let bytes = bearer_get_bytes_limited(client, url, token, MAX_ATTACHMENT_BYTES)?;
    Ok((safe_filename(&attachment.name), bytes))
}

fn google_message_content(
    client: &Client,
    token: &str,
    message_id: &str,
) -> Result<MailContentDto, String> {
    let url = provider_message_url(OAuthProvider::Gmail, message_id)?;
    let message: GoogleContentMessage =
        bearer_get_limited(client, url, token, false, MAX_MESSAGE_RESPONSE_BYTES)?;
    let body = google_part_data(&message.payload, "text/plain")
        .map(|value| normalize_body(&value))
        .or_else(|| {
            google_part_data(&message.payload, "text/html").map(|value| html_to_text(&value))
        })
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| {
            let snippet = normalize_body(&message.snippet);
            if snippet.is_empty() {
                "В письме нет доступного текстового содержимого".to_string()
            } else {
                snippet
            }
        });
    let attachments = google_attachment_list(&message.payload);
    Ok(MailContentDto {
        body,
        has_attachments: google_has_attachments(&message.payload) || !attachments.is_empty(),
        attachments,
    })
}

fn microsoft_message_content(
    client: &Client,
    token: &str,
    message_id: &str,
) -> Result<MailContentDto, String> {
    let url = provider_message_url(OAuthProvider::Outlook, message_id)?;
    let message: MicrosoftMessageContent =
        bearer_get_limited(client, url, token, true, MAX_MESSAGE_RESPONSE_BYTES)?;
    let body = if message.body.content_type.eq_ignore_ascii_case("html") {
        html_to_text(&message.body.content)
    } else {
        normalize_body(&message.body.content)
    };
    let attachments = if message.has_attachments {
        microsoft_attachment_list(client, token, message_id)?
    } else {
        Vec::new()
    };
    let attachment_dtos = microsoft_attachment_dtos(&attachments);
    Ok(MailContentDto {
        body: if body.trim().is_empty() {
            "В письме нет доступного текстового содержимого".to_string()
        } else {
            body
        },
        has_attachments: message.has_attachments,
        attachments: attachment_dtos,
    })
}

fn google_header(message: &GoogleMessage, name: &str, fallback: &str) -> String {
    message
        .payload
        .headers
        .iter()
        .find(|header| header.name.eq_ignore_ascii_case(name))
        .map(|header| header.value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn google_messages(client: &Client, token: &str) -> Result<Vec<OAuthMessageDto>, String> {
    let list: GoogleMessageList = bearer_get(
        client,
        &format!("https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults={MESSAGE_LIMIT}"),
        token,
    )?;
    let mut messages = Vec::with_capacity(list.messages.len());
    for item in list.messages {
        let url = format!(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/{}?format=metadata&metadataHeaders=From&metadataHeaders=Subject",
            item.id
        );
        let message: GoogleMessage = bearer_get(client, &url, token)?;
        let received_at = message
            .internal_date
            .parse::<i64>()
            .ok()
            .and_then(DateTime::<Utc>::from_timestamp_millis)
            .map(|value| value.to_rfc3339_opts(SecondsFormat::Secs, true))
            .unwrap_or_else(|| Utc::now().to_rfc3339());
        messages.push(OAuthMessageDto {
            id: message.id.clone(),
            sender: google_header(&message, "From", "Неизвестный отправитель"),
            subject: google_header(&message, "Subject", "Без темы"),
            preview: if message.snippet.trim().is_empty() {
                "Откройте письмо в Gmail".into()
            } else {
                message.snippet.trim().to_string()
            },
            received_at,
            unread: message.label_ids.iter().any(|label| label == "UNREAD"),
        });
    }
    Ok(messages)
}

fn microsoft_messages(client: &Client, token: &str) -> Result<Vec<OAuthMessageDto>, String> {
    let url = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?%24top=20&%24select=id%2Csubject%2Cfrom%2CreceivedDateTime%2CisRead%2CbodyPreview&%24orderby=receivedDateTime%20desc";
    let list: MicrosoftMessageList = bearer_get(client, url, token)?;
    Ok(list
        .value
        .into_iter()
        .map(|message| {
            let sender = message
                .from
                .map(|recipient| {
                    let address = recipient.email_address.address;
                    recipient
                        .email_address
                        .name
                        .filter(|name| {
                            !name.trim().is_empty() && !name.eq_ignore_ascii_case(&address)
                        })
                        .map(|name| format!("{name} <{address}>"))
                        .unwrap_or(address)
                })
                .unwrap_or_else(|| "Неизвестный отправитель".into());
            OAuthMessageDto {
                id: message.id,
                sender,
                subject: message
                    .subject
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or_else(|| "Без темы".into()),
                preview: if message.body_preview.trim().is_empty() {
                    "Откройте письмо в Outlook".into()
                } else {
                    message.body_preview.trim().to_string()
                },
                received_at: message.received_date_time,
                unread: !message.is_read,
            }
        })
        .collect())
}

fn fetch_messages(
    provider: OAuthProvider,
    client: &Client,
    token: &str,
) -> Result<Vec<OAuthMessageDto>, String> {
    match provider {
        OAuthProvider::Gmail => google_messages(client, token),
        OAuthProvider::Outlook => microsoft_messages(client, token),
    }
}

#[tauri::command]
pub fn oauth_provider_status() -> OAuthProviderStatus {
    OAuthProviderStatus {
        gmail: OAuthProvider::Gmail.configured_client_id().is_some(),
        outlook: OAuthProvider::Outlook.configured_client_id().is_some(),
    }
}

#[tauri::command]
pub async fn connect_oauth(input: OAuthAccountInput) -> Result<OAuthConnectResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_account_id(&input.account_id)?;
        let client_id = input.provider.client_id()?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|_| "Не удалось запустить локальный OAuth callback".to_string())?;
        let port = listener
            .local_addr()
            .map_err(|_| "Не удалось определить адрес OAuth callback".to_string())?
            .port();
        let redirect_uri = format!("http://localhost:{port}/oauth/callback");
        let verifier = Zeroizing::new(random_urlsafe(64));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let state = Zeroizing::new(random_urlsafe(32));
        let url = authorization_url(
            input.provider,
            &client_id,
            &redirect_uri,
            state.as_str(),
            &challenge,
        )?;
        open::that(url.as_str())
            .map_err(|_| "Не удалось открыть системный браузер".to_string())?;
        let code = Zeroizing::new(wait_for_authorization(listener, state.as_str())?);
        let client = http_client()?;
        let token = exchange_code(
            input.provider,
            &client,
            &client_id,
            code.as_str(),
            verifier.as_str(),
            &redirect_uri,
        )?;
        let access = Zeroizing::new(token.access_token.clone());
        let messages = fetch_messages(input.provider, &client, access.as_str())?;
        let (address, label) = match input.provider {
            OAuthProvider::Gmail => {
                let profile: GoogleProfile = bearer_get(
                    &client,
                    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
                    access.as_str(),
                )?;
                (profile.email_address, "Gmail".to_string())
            }
            OAuthProvider::Outlook => {
                let profile: MicrosoftProfile = bearer_get(
                    &client,
                    "https://graph.microsoft.com/v1.0/me?%24select=displayName%2Cmail%2CuserPrincipalName",
                    access.as_str(),
                )?;
                (
                    profile.mail.unwrap_or(profile.user_principal_name),
                    profile.display_name,
                )
            }
        };
        let refresh_token = token
            .refresh_token
            .as_deref()
            .ok_or_else(|| "Сервис авторизации не выдал долговременную сессию".to_string())?;
        save_refresh_token(input.provider, &input.account_id, refresh_token)?;
        Ok(OAuthConnectResult {
            address,
            label,
            messages,
        })
    })
    .await
    .map_err(|_| "Не удалось завершить OAuth-подключение".to_string())?
}

#[tauri::command]
pub async fn sync_oauth(input: OAuthAccountInput) -> Result<Vec<OAuthMessageDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_account_id(&input.account_id)?;
        let client = http_client()?;
        let token = access_token(input.provider, &input.account_id, &client)?;
        fetch_messages(input.provider, &client, token.as_str())
    })
    .await
    .map_err(|_| "Не удалось завершить синхронизацию".to_string())?
}

#[tauri::command]
pub async fn get_oauth_message_content(
    input: OAuthMessageContentInput,
) -> Result<MailContentDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_account_id(&input.account_id)?;
        validate_message_id(&input.message_id)?;
        let client = http_client()?;
        let token = access_token(input.provider, &input.account_id, &client)?;
        match input.provider {
            OAuthProvider::Gmail => {
                google_message_content(&client, token.as_str(), &input.message_id)
            }
            OAuthProvider::Outlook => {
                microsoft_message_content(&client, token.as_str(), &input.message_id)
            }
        }
    })
    .await
    .map_err(|_| "Не удалось завершить загрузку письма".to_string())?
}

#[tauri::command]
pub async fn download_oauth_attachment(
    app: AppHandle,
    input: OAuthAttachmentInput,
) -> Result<DownloadResultDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_account_id(&input.account_id)?;
        validate_message_id(&input.message_id)?;
        validate_attachment_id(&input.attachment_id)?;
        let client = http_client()?;
        let token = access_token(input.provider, &input.account_id, &client)?;
        let (name, bytes) = match input.provider {
            OAuthProvider::Gmail => google_attachment_bytes(
                &client,
                token.as_str(),
                &input.message_id,
                &input.attachment_id,
            )?,
            OAuthProvider::Outlook => microsoft_attachment_bytes(
                &client,
                token.as_str(),
                &input.message_id,
                &input.attachment_id,
            )?,
        };
        save_attachment(&app, &name, &bytes)
    })
    .await
    .map_err(|_| "Не удалось завершить загрузку вложения".to_string())?
}

#[tauri::command]
pub async fn disconnect_oauth(input: OAuthAccountInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_account_id(&input.account_id)?;
        if matches!(input.provider, OAuthProvider::Gmail) {
            if let (Ok(token), Ok(client)) = (
                load_refresh_token(input.provider, &input.account_id),
                http_client(),
            ) {
                if let Ok(token) = std::str::from_utf8(token.as_slice()) {
                    let _ = client
                        .post("https://oauth2.googleapis.com/revoke")
                        .form(&[("token", token)])
                        .send();
                }
            }
        }
        match token_entry(input.provider, &input.account_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Не удалось удалить OAuth-сессию из системного хранилища".into()),
        }
    })
    .await
    .map_err(|_| "Не удалось завершить отключение аккаунта".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_pkce_values_have_enough_entropy() {
        let verifier = random_urlsafe(64);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        assert!((43..=128).contains(&verifier.len()));
        assert_eq!(challenge.len(), 43);
    }

    #[test]
    fn authorization_url_contains_pkce_and_state() {
        let url = authorization_url(
            OAuthProvider::Gmail,
            "client-id",
            "http://localhost:3456/oauth/callback",
            "state-value",
            "challenge-value",
        )
        .unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(query.get("state").unwrap(), "state-value");
        assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(query.get("access_type").unwrap(), "offline");
        assert!(query.get("scope").expect("scope").contains("gmail.send"));
    }

    #[test]
    fn account_ids_are_restricted() {
        assert!(validate_account_id("mail_123-safe").is_ok());
        assert!(validate_account_id("../token").is_err());
    }

    #[test]
    fn message_ids_are_validated_before_building_urls() {
        assert!(provider_message_url(OAuthProvider::Outlook, "AAMk-123_=").is_ok());
        assert!(provider_message_url(OAuthProvider::Gmail, "../messages/other").is_err());
        assert!(provider_message_url(OAuthProvider::Gmail, "id?format=raw").is_err());
    }

    #[test]
    fn extracts_plain_google_body_from_nested_parts() {
        let encoded = URL_SAFE_NO_PAD.encode("Текст письма");
        let part = GoogleContentPart {
            mime_type: "multipart/alternative".into(),
            parts: vec![GoogleContentPart {
                mime_type: "text/plain".into(),
                body: GoogleContentBody {
                    data: Some(encoded),
                    ..Default::default()
                },
                ..Default::default()
            }],
            ..Default::default()
        };
        assert_eq!(
            google_part_data(&part, "text/plain").as_deref(),
            Some("Текст письма")
        );
    }

    #[test]
    fn lists_google_attachments_without_exposing_binary_data() {
        let part = GoogleContentPart {
            part_id: "2".into(),
            mime_type: "application/pdf".into(),
            filename: "../report.pdf".into(),
            body: GoogleContentBody {
                data: None,
                attachment_id: Some("remote-id".into()),
                size: 512,
            },
            parts: Vec::new(),
        };
        let attachments = google_attachment_list(&part);
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].id, "remote:remote-id");
        assert_eq!(attachments[0].name, "report.pdf");
        assert!(attachments[0].downloadable);
    }

    #[test]
    fn loopback_callback_accepts_matching_state() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let receiver = thread::spawn(move || wait_for_authorization(listener, "safe-state"));
        let mut stream = std::net::TcpStream::connect(address).unwrap();
        stream
            .write_all(
                b"GET /oauth/callback?code=authorization-code&state=safe-state HTTP/1.1\r\nHost: localhost\r\n\r\n",
            )
            .unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(2)))
            .expect("set response timeout");
        stream
            .shutdown(std::net::Shutdown::Write)
            .expect("finish callback request");
        let mut response = [0_u8; 1_024];
        let count = stream.read(&mut response).expect("read callback response");
        assert!(String::from_utf8_lossy(&response[..count]).contains("200 OK"));
        assert_eq!(receiver.join().unwrap().unwrap(), "authorization-code");
    }
}
