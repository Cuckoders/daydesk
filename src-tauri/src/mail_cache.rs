use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng, Payload},
    Aes256Gcm, Nonce,
};
use chrono::DateTime;
use keyring::Entry;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

const KEYRING_SERVICE: &str = "ru.daydesk.desktop.cache";
const KEYRING_ACCOUNT: &str = "mail-cache-v1";
const DATABASE_FILE: &str = "daydesk-mail-v1.sqlite3";
const NONCE_LENGTH: usize = 12;
const MAX_MESSAGES: usize = 2_000;
const MAX_SEARCH_RESULTS: usize = 100;

static DATABASE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedMailMessage {
    id: String,
    account_id: String,
    sender: String,
    initials: String,
    subject: String,
    preview: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    body: Option<String>,
    #[serde(default)]
    has_attachments: bool,
    #[serde(default)]
    attachments: Vec<CachedMailAttachment>,
    received_at: String,
    unread: bool,
    starred: bool,
    color: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CachedMailAttachment {
    id: String,
    name: String,
    size: u64,
    mime_type: String,
    downloadable: bool,
}

#[derive(Debug)]
struct EncryptedMessage {
    id: String,
    account_id: String,
    sender: Vec<u8>,
    initials: Vec<u8>,
    subject: Vec<u8>,
    preview: Vec<u8>,
    body: Option<Vec<u8>>,
    has_attachments: bool,
    attachments: Option<Vec<u8>>,
    received_at: String,
    unread: bool,
    starred: bool,
    color: String,
}

fn user_error() -> String {
    "Не удалось открыть защищённое хранилище почты".to_string()
}

fn database_path(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app.path().app_data_dir().map_err(|_| user_error())?;
    fs::create_dir_all(&directory).map_err(|_| user_error())?;
    secure_directory(&directory)?;
    Ok(directory.join(DATABASE_FILE))
}

#[cfg(unix)]
fn secure_directory(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|_| user_error())
}

#[cfg(not(unix))]
fn secure_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
fn secure_database_file(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|_| user_error())
}

#[cfg(not(unix))]
fn secure_database_file(_path: &Path) -> Result<(), String> {
    Ok(())
}

fn open_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|_| user_error())?;
    secure_database_file(path)?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             CREATE TABLE IF NOT EXISTS mail_messages (
               id TEXT PRIMARY KEY,
               account_id TEXT NOT NULL,
               sender BLOB NOT NULL,
               initials BLOB NOT NULL,
               subject BLOB NOT NULL,
               preview BLOB NOT NULL,
               body BLOB,
               has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
               attachments BLOB,
               received_at TEXT NOT NULL,
               unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
               starred INTEGER NOT NULL CHECK (starred IN (0, 1)),
               color TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS mail_messages_account ON mail_messages(account_id);
             CREATE INDEX IF NOT EXISTS mail_messages_received ON mail_messages(received_at DESC);",
        )
        .map_err(|_| user_error())?;
    ensure_cache_columns(&connection)?;
    Ok(connection)
}

fn ensure_cache_columns(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(mail_messages)")
        .map_err(|_| user_error())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|_| user_error())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| user_error())?;
    drop(statement);
    if !columns.iter().any(|column| column == "body") {
        connection
            .execute("ALTER TABLE mail_messages ADD COLUMN body BLOB", [])
            .map_err(|_| user_error())?;
    }
    if !columns.iter().any(|column| column == "has_attachments") {
        connection
            .execute(
                "ALTER TABLE mail_messages ADD COLUMN has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1))",
                [],
            )
            .map_err(|_| user_error())?;
    }
    if !columns.iter().any(|column| column == "attachments") {
        connection
            .execute("ALTER TABLE mail_messages ADD COLUMN attachments BLOB", [])
            .map_err(|_| user_error())?;
    }
    Ok(())
}

fn encryption_key() -> Result<Zeroizing<Vec<u8>>, String> {
    let entry = Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|_| user_error())?;
    match entry.get_secret() {
        Ok(secret) if secret.len() == 32 => Ok(Zeroizing::new(secret)),
        Ok(mut secret) => {
            secret.zeroize();
            Err(user_error())
        }
        Err(keyring::Error::NoEntry) => {
            let key = Aes256Gcm::generate_key(&mut OsRng);
            entry.set_secret(key.as_slice()).map_err(|_| user_error())?;
            Ok(Zeroizing::new(key.to_vec()))
        }
        Err(_) => Err(user_error()),
    }
}

fn cipher(key: &[u8]) -> Result<Aes256Gcm, String> {
    Aes256Gcm::new_from_slice(key).map_err(|_| user_error())
}

fn field_aad(id: &str, field: &str) -> String {
    format!("daydesk-mail-v1:{id}:{field}")
}

fn encrypt_field(
    cipher: &Aes256Gcm,
    id: &str,
    field: &str,
    value: &str,
) -> Result<Vec<u8>, String> {
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: value.as_bytes(),
                aad: field_aad(id, field).as_bytes(),
            },
        )
        .map_err(|_| user_error())?;
    let mut encrypted = Vec::with_capacity(NONCE_LENGTH + ciphertext.len());
    encrypted.extend_from_slice(nonce.as_slice());
    encrypted.extend_from_slice(&ciphertext);
    Ok(encrypted)
}

fn decrypt_field(
    cipher: &Aes256Gcm,
    id: &str,
    field: &str,
    value: &[u8],
) -> Result<String, String> {
    if value.len() <= NONCE_LENGTH {
        return Err(user_error());
    }
    let nonce = Nonce::from_slice(&value[..NONCE_LENGTH]);
    let plaintext = cipher
        .decrypt(
            nonce,
            Payload {
                msg: &value[NONCE_LENGTH..],
                aad: field_aad(id, field).as_bytes(),
            },
        )
        .map_err(|_| user_error())?;
    String::from_utf8(plaintext).map_err(|_| user_error())
}

fn validate_message(message: &CachedMailMessage) -> Result<(), String> {
    fn valid_text(value: &str, max: usize) -> bool {
        !value.trim().is_empty() && value.chars().count() <= max && !value.contains('\0')
    }

    if !valid_text(&message.id, 512)
        || !valid_text(&message.account_id, 160)
        || !valid_text(&message.sender, 500)
        || !valid_text(&message.initials, 8)
        || !valid_text(&message.subject, 1_000)
        || message.preview.chars().count() > 5_000
        || message.preview.contains('\0')
        || message
            .body
            .as_ref()
            .is_some_and(|body| body.chars().count() > 500_000 || body.contains('\0'))
        || message.attachments.len() > 50
        || message.attachments.iter().any(|attachment| {
            !valid_text(&attachment.id, 2_048)
                || !valid_text(&attachment.name, 255)
                || !valid_text(&attachment.mime_type, 255)
                || attachment.size > 20 * 1024 * 1024
        })
        || DateTime::parse_from_rfc3339(&message.received_at).is_err()
        || message.color.len() != 7
        || !message.color.starts_with('#')
        || !message.color[1..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Одно из писем содержит некорректные данные".to_string());
    }
    Ok(())
}

fn encrypt_message(
    cipher: &Aes256Gcm,
    message: &CachedMailMessage,
) -> Result<EncryptedMessage, String> {
    Ok(EncryptedMessage {
        id: message.id.clone(),
        account_id: message.account_id.clone(),
        sender: encrypt_field(cipher, &message.id, "sender", &message.sender)?,
        initials: encrypt_field(cipher, &message.id, "initials", &message.initials)?,
        subject: encrypt_field(cipher, &message.id, "subject", &message.subject)?,
        preview: encrypt_field(cipher, &message.id, "preview", &message.preview)?,
        body: message
            .body
            .as_deref()
            .map(|body| encrypt_field(cipher, &message.id, "body", body))
            .transpose()?,
        has_attachments: message.has_attachments,
        attachments: if message.attachments.is_empty() {
            None
        } else {
            let serialized =
                serde_json::to_string(&message.attachments).map_err(|_| user_error())?;
            Some(encrypt_field(
                cipher,
                &message.id,
                "attachments",
                &serialized,
            )?)
        },
        received_at: message.received_at.clone(),
        unread: message.unread,
        starred: message.starred,
        color: message.color.clone(),
    })
}

fn decrypt_message(
    cipher: &Aes256Gcm,
    message: EncryptedMessage,
) -> Result<CachedMailMessage, String> {
    Ok(CachedMailMessage {
        sender: decrypt_field(cipher, &message.id, "sender", &message.sender)?,
        initials: decrypt_field(cipher, &message.id, "initials", &message.initials)?,
        subject: decrypt_field(cipher, &message.id, "subject", &message.subject)?,
        preview: decrypt_field(cipher, &message.id, "preview", &message.preview)?,
        body: message
            .body
            .as_deref()
            .map(|body| decrypt_field(cipher, &message.id, "body", body))
            .transpose()?,
        has_attachments: message.has_attachments,
        attachments: match message.attachments.as_deref() {
            Some(attachments) => {
                let serialized = decrypt_field(cipher, &message.id, "attachments", attachments)?;
                serde_json::from_str(&serialized).map_err(|_| user_error())?
            }
            None => Vec::new(),
        },
        id: message.id,
        account_id: message.account_id,
        received_at: message.received_at,
        unread: message.unread,
        starred: message.starred,
        color: message.color,
    })
}

fn read_messages(
    connection: &Connection,
    cipher: &Aes256Gcm,
) -> Result<Vec<CachedMailMessage>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, account_id, sender, initials, subject, preview, body, has_attachments, attachments, received_at, unread, starred, color
             FROM mail_messages ORDER BY received_at DESC LIMIT ?1",
        )
        .map_err(|_| user_error())?;
    let rows = statement
        .query_map(params![MAX_MESSAGES as i64], |row| {
            Ok(EncryptedMessage {
                id: row.get(0)?,
                account_id: row.get(1)?,
                sender: row.get(2)?,
                initials: row.get(3)?,
                subject: row.get(4)?,
                preview: row.get(5)?,
                body: row.get(6)?,
                has_attachments: row.get(7)?,
                attachments: row.get(8)?,
                received_at: row.get(9)?,
                unread: row.get(10)?,
                starred: row.get(11)?,
                color: row.get(12)?,
            })
        })
        .map_err(|_| user_error())?;
    rows.map(|row| {
        row.map_err(|_| user_error())
            .and_then(|message| decrypt_message(cipher, message))
    })
    .collect()
}

fn load_from_path(path: &Path) -> Result<Vec<CachedMailMessage>, String> {
    let key = encryption_key()?;
    let cipher = cipher(&key)?;
    let connection = open_database(path)?;
    read_messages(&connection, &cipher)
}

fn replace_at_path(path: &Path, messages: Vec<CachedMailMessage>) -> Result<(), String> {
    if messages.len() > MAX_MESSAGES {
        return Err("Слишком много писем для локального хранилища".to_string());
    }
    for message in &messages {
        validate_message(message)?;
    }

    let key = encryption_key()?;
    let cipher = cipher(&key)?;
    let mut encrypted = Vec::with_capacity(messages.len());
    for message in &messages {
        encrypted.push(encrypt_message(&cipher, message)?);
    }

    let mut connection = open_database(path)?;
    let transaction = connection.transaction().map_err(|_| user_error())?;
    transaction
        .execute("DELETE FROM mail_messages", [])
        .map_err(|_| user_error())?;
    {
        let mut statement = transaction
            .prepare(
                "INSERT INTO mail_messages
                 (id, account_id, sender, initials, subject, preview, body, has_attachments, attachments, received_at, unread, starred, color)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            )
            .map_err(|_| user_error())?;
        for message in encrypted {
            statement
                .execute(params![
                    message.id,
                    message.account_id,
                    message.sender,
                    message.initials,
                    message.subject,
                    message.preview,
                    message.body,
                    message.has_attachments,
                    message.attachments,
                    message.received_at,
                    message.unread,
                    message.starred,
                    message.color,
                ])
                .map_err(|_| user_error())?;
        }
    }
    transaction.commit().map_err(|_| user_error())
}

#[tauri::command]
pub async fn load_mail_cache(app: AppHandle) -> Result<Vec<CachedMailMessage>, String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = DATABASE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| user_error())?;
        load_from_path(&path)
    })
    .await
    .map_err(|_| user_error())?
}

#[tauri::command]
pub async fn replace_mail_cache(
    app: AppHandle,
    messages: Vec<CachedMailMessage>,
) -> Result<(), String> {
    let path = database_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = DATABASE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| user_error())?;
        replace_at_path(&path, messages)
    })
    .await
    .map_err(|_| user_error())?
}

#[tauri::command]
pub async fn search_mail_cache(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<CachedMailMessage>, String> {
    let normalized = query.trim().to_lowercase();
    if normalized.is_empty() || normalized.chars().count() > 200 {
        return Err("Поисковый запрос должен содержать от 1 до 200 символов".to_string());
    }
    let path = database_path(&app)?;
    let result_limit = limit
        .unwrap_or(MAX_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = DATABASE_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .map_err(|_| user_error())?;
        let mut messages = load_from_path(&path)?;
        messages.retain(|message| {
            message.sender.to_lowercase().contains(&normalized)
                || message.subject.to_lowercase().contains(&normalized)
                || message.preview.to_lowercase().contains(&normalized)
                || message
                    .body
                    .as_ref()
                    .is_some_and(|body| body.to_lowercase().contains(&normalized))
                || message
                    .attachments
                    .iter()
                    .any(|attachment| attachment.name.to_lowercase().contains(&normalized))
        });
        messages.truncate(result_limit);
        Ok(messages)
    })
    .await
    .map_err(|_| user_error())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_cipher() -> Aes256Gcm {
        Aes256Gcm::new_from_slice(&[7_u8; 32]).expect("valid key")
    }

    #[test]
    fn encryption_round_trip_uses_a_random_nonce() {
        let cipher = test_cipher();
        let first = encrypt_field(&cipher, "id-1", "subject", "Секретное письмо").expect("encrypt");
        let second =
            encrypt_field(&cipher, "id-1", "subject", "Секретное письмо").expect("encrypt");
        assert_ne!(first, second);
        assert_eq!(
            decrypt_field(&cipher, "id-1", "subject", &first).expect("decrypt"),
            "Секретное письмо"
        );
    }

    #[test]
    fn authentication_rejects_tampering_and_wrong_field() {
        let cipher = test_cipher();
        let mut encrypted = encrypt_field(&cipher, "id-1", "subject", "Встреча").expect("encrypt");
        let last = encrypted.len() - 1;
        encrypted[last] ^= 1;
        assert!(decrypt_field(&cipher, "id-1", "subject", &encrypted).is_err());

        let intact = encrypt_field(&cipher, "id-1", "subject", "Встреча").expect("encrypt");
        assert!(decrypt_field(&cipher, "id-1", "preview", &intact).is_err());
    }

    #[test]
    fn validation_rejects_invalid_metadata() {
        let message = CachedMailMessage {
            id: "id".into(),
            account_id: "account".into(),
            sender: "Sender".into(),
            initials: "S".into(),
            subject: "Subject".into(),
            preview: "Preview".into(),
            body: None,
            has_attachments: false,
            attachments: Vec::new(),
            received_at: "not-a-date".into(),
            unread: true,
            starred: false,
            color: "purple".into(),
        };
        assert!(validate_message(&message).is_err());
    }

    #[test]
    fn migrates_existing_cache_without_losing_rows() {
        let connection = Connection::open_in_memory().expect("open database");
        connection
            .execute_batch(
                "CREATE TABLE mail_messages (
                   id TEXT PRIMARY KEY,
                   account_id TEXT NOT NULL,
                   sender BLOB NOT NULL,
                   initials BLOB NOT NULL,
                   subject BLOB NOT NULL,
                   preview BLOB NOT NULL,
                   received_at TEXT NOT NULL,
                   unread INTEGER NOT NULL,
                   starred INTEGER NOT NULL,
                   color TEXT NOT NULL
                 );
                 INSERT INTO mail_messages VALUES ('id', 'account', X'01', X'01', X'01', X'01', '2026-08-30T12:00:00Z', 1, 0, '#6857eb');",
            )
            .expect("create legacy schema");
        ensure_cache_columns(&connection).expect("migrate schema");
        let (body, has_attachments, attachments): (Option<Vec<u8>>, bool, Option<Vec<u8>>) =
            connection
                .query_row(
                    "SELECT body, has_attachments, attachments FROM mail_messages WHERE id = 'id'",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .expect("legacy row remains");
        assert!(body.is_none());
        assert!(!has_attachments);
        assert!(attachments.is_none());
    }
}
