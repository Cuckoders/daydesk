use chrono::{DateTime, NaiveDate};
use reqwest::blocking::{Client, Response};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{io::Read, net::IpAddr, time::Duration};
use url::Url;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const SYNC_KEYRING_SERVICE: &str = "ru.daydesk.desktop.sync";
const SYNC_KEYRING_ACCOUNT: &str = "device";
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_CHANGES: usize = 500;

#[derive(Deserialize, Serialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncCredential {
    api_url: String,
    device_id: String,
    device_token: String,
    device_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDeviceStatus {
    api_url: String,
    device_id: String,
    device_name: String,
}

impl From<&SyncCredential> for SyncDeviceStatus {
    fn from(value: &SyncCredential) -> Self {
        Self {
            api_url: value.api_url.clone(),
            device_id: value.device_id.clone(),
            device_name: value.device_name.clone(),
        }
    }
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterSyncDeviceInput {
    api_url: String,
    setup_code: String,
    device_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationRequest<'a> {
    setup_code: &'a str,
    name: &'a str,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct RegistrationEnvelope {
    status: String,
    data: RegistrationData,
}

#[derive(Deserialize, Zeroize, ZeroizeOnDrop)]
#[serde(deny_unknown_fields)]
struct RegistrationData {
    id: String,
    token: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopRecurrence {
    mode: String,
    days: Vec<u8>,
    series_id: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncedTask {
    id: String,
    title: String,
    completed: bool,
    due_at: String,
    priority: String,
    category: String,
    reminder_enabled: bool,
    remind_before_minutes: u32,
    recurrence: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    desktop_recurrence: Option<DesktopRecurrence>,
    #[serde(skip_serializing_if = "Option::is_none")]
    snoozed_until: Option<String>,
    updated_at: String,
    sync_version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncedEvent {
    id: String,
    title: String,
    starts_at: String,
    ends_at: String,
    #[serde(rename = "type")]
    event_type: String,
    location: Option<String>,
    remind_before_minutes: u32,
    reminder_enabled: bool,
    all_day: Option<bool>,
    all_day_start_date: Option<String>,
    all_day_end_date: Option<String>,
    updated_at: String,
    sync_version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SyncedRoutine {
    id: String,
    title: String,
    time: String,
    days: Vec<u8>,
    kind: String,
    remind_before_minutes: u32,
    enabled: bool,
    updated_at: String,
    sync_version: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClientChange {
    id: String,
    entity: String,
    entity_id: String,
    operation: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncRequestBody {
    cursor: u64,
    changes: Vec<ClientChange>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerChange {
    sequence: u64,
    entity: String,
    entity_id: String,
    operation: String,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    payload: Option<serde_json::Value>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncResponseBody {
    cursor: u64,
    accepted_operation_ids: Vec<String>,
    changes: Vec<ServerChange>,
    has_more: bool,
    server_time: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SyncEnvelope {
    status: String,
    data: SyncResponseBody,
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(SYNC_KEYRING_SERVICE, SYNC_KEYRING_ACCOUNT)
        .map_err(|_| "Системное хранилище синхронизации недоступно".into())
}

fn load_credential() -> Result<Option<SyncCredential>, String> {
    let secret = match credential_entry()?.get_secret() {
        Ok(value) => Zeroizing::new(value),
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => return Err("Не удалось прочитать защищённые настройки синхронизации".into()),
    };
    serde_json::from_slice(secret.as_slice())
        .map(Some)
        .map_err(|_| "Настройки синхронизации повреждены. Подключите устройство заново".into())
}

fn save_credential(credential: &SyncCredential) -> Result<(), String> {
    let serialized = Zeroizing::new(
        serde_json::to_string(credential)
            .map_err(|_| "Не удалось подготовить настройки синхронизации".to_string())?,
    );
    credential_entry()?
        .set_secret(serialized.as_bytes())
        .map_err(|_| "Не удалось сохранить токен в системном хранилище".into())
}

fn normalize_api_url(value: &str) -> Result<String, String> {
    let mut url =
        Url::parse(value.trim()).map_err(|_| "Укажите корректный адрес сервера".to_string())?;
    if url.username() != ""
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Адрес сервера не должен содержать логин, параметры или фрагмент".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "В адресе сервера отсутствует хост".to_string())?;
    let local = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|address| {
                address.is_loopback()
                    || match address {
                        IpAddr::V4(ip) => ip.is_private(),
                        IpAddr::V6(ip) => ip.is_unique_local(),
                    }
            })
            .unwrap_or(false);
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err("Для внешнего сервера синхронизации необходим HTTPS".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn valid_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_iso(value: &str) -> bool {
    (20..=35).contains(&value.len()) && DateTime::parse_from_rfc3339(value).is_ok()
}

fn validate_task(task: &SyncedTask) -> Result<(), String> {
    if !valid_identifier(&task.id)
        || task.title.trim().is_empty()
        || task.title.len() > 500
        || task.category.trim().is_empty()
        || task.category.len() > 100
        || task
            .title
            .chars()
            .chain(task.category.chars())
            .any(char::is_control)
        || !valid_iso(&task.due_at)
        || !valid_iso(&task.updated_at)
        || !matches!(task.priority.as_str(), "high" | "medium" | "low")
        || !matches!(
            task.recurrence.as_str(),
            "none" | "daily" | "weekdays" | "weekly"
        )
        || task.remind_before_minutes > 10_080
        || task.sync_version == 0
    {
        return Err("Одна из задач содержит некорректные данные".into());
    }
    if let Some(value) = &task.snoozed_until {
        if !valid_iso(value) {
            return Err("Некорректное время отложенного напоминания".into());
        }
    }
    if let Some(value) = &task.desktop_recurrence {
        if !matches!(
            value.mode.as_str(),
            "daily" | "weekdays" | "weekly" | "custom"
        ) || value.series_id.is_empty()
            || value.series_id.len() > 100
            || value.series_id.chars().any(char::is_control)
            || value.days.len() > 7
            || value.days.iter().any(|day| *day > 6)
            || (value.mode == "custom" && value.days.is_empty())
        {
            return Err("Некорректное правило повтора задачи".into());
        }
    }
    Ok(())
}

fn validate_event(event: &SyncedEvent) -> Result<(), String> {
    let starts_at = DateTime::parse_from_rfc3339(&event.starts_at)
        .map_err(|_| "Некорректное начало события".to_string())?;
    let ends_at = DateTime::parse_from_rfc3339(&event.ends_at)
        .map_err(|_| "Некорректное окончание события".to_string())?;
    if !valid_identifier(&event.id)
        || event.title.trim().is_empty()
        || event.title.len() > 300
        || event.title.chars().any(char::is_control)
        || ends_at <= starts_at
        || !matches!(
            event.event_type.as_str(),
            "meeting" | "meal" | "focus" | "personal"
        )
        || event
            .location
            .as_ref()
            .is_some_and(|value| value.len() > 500 || value.chars().any(char::is_control))
        || event.remind_before_minutes > 10_080
        || !valid_iso(&event.updated_at)
        || event.sync_version == 0
    {
        return Err("Событие содержит некорректные данные".into());
    }
    if event.all_day.unwrap_or(false) {
        let start = event
            .all_day_start_date
            .as_deref()
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
        let end = event
            .all_day_end_date
            .as_deref()
            .and_then(|value| NaiveDate::parse_from_str(value, "%Y-%m-%d").ok());
        if !matches!((start, end), (Some(start), Some(end)) if end > start) {
            return Err("Событие на весь день содержит некорректный диапазон".into());
        }
    } else if event.all_day_start_date.is_some() || event.all_day_end_date.is_some() {
        return Err("Обычное событие не должно содержать даты всего дня".into());
    }
    let _ = event.reminder_enabled;
    Ok(())
}

fn validate_routine(routine: &SyncedRoutine) -> Result<(), String> {
    let valid_time = routine.time.len() == 5
        && routine.time.as_bytes().get(2) == Some(&b':')
        && routine.time[..2]
            .parse::<u8>()
            .is_ok_and(|hours| hours <= 23)
        && routine.time[3..]
            .parse::<u8>()
            .is_ok_and(|minutes| minutes <= 59);
    if !valid_identifier(&routine.id)
        || routine.title.trim().is_empty()
        || routine.title.len() > 100
        || routine.title.chars().any(char::is_control)
        || !valid_time
        || routine.days.is_empty()
        || routine.days.len() > 7
        || routine.days.iter().any(|day| *day > 6)
        || !matches!(
            routine.kind.as_str(),
            "water" | "meal" | "break" | "focus" | "custom"
        )
        || routine.remind_before_minutes > 10_080
        || !valid_iso(&routine.updated_at)
        || routine.sync_version == 0
    {
        return Err("Ритуал содержит некорректные данные".into());
    }
    let _ = routine.enabled;
    Ok(())
}

fn validate_payload(
    entity: &str,
    entity_id: &str,
    updated_at: &str,
    payload: &serde_json::Value,
) -> Result<(), String> {
    match entity {
        "task" => {
            let task: SyncedTask = serde_json::from_value(payload.clone())
                .map_err(|_| "Некорректные данные задачи".to_string())?;
            if task.id != entity_id || task.updated_at != updated_at {
                return Err("Изменение задачи не совпадает с его данными".into());
            }
            validate_task(&task)
        }
        "event" => {
            let event: SyncedEvent = serde_json::from_value(payload.clone())
                .map_err(|_| "Некорректные данные события".to_string())?;
            if event.id != entity_id || event.updated_at != updated_at {
                return Err("Изменение события не совпадает с его данными".into());
            }
            validate_event(&event)
        }
        "routine" => {
            let routine: SyncedRoutine = serde_json::from_value(payload.clone())
                .map_err(|_| "Некорректные данные ритуала".to_string())?;
            if routine.id != entity_id || routine.updated_at != updated_at {
                return Err("Изменение ритуала не совпадает с его данными".into());
            }
            validate_routine(&routine)
        }
        _ => Err("Неизвестный тип синхронизируемых данных".into()),
    }
}

fn validate_request(request: &SyncRequestBody) -> Result<(), String> {
    if request.changes.len() > MAX_CHANGES {
        return Err("За один раз можно синхронизировать не больше 500 изменений".into());
    }
    for change in &request.changes {
        if !valid_identifier(&change.id)
            || !matches!(change.entity.as_str(), "task" | "event" | "routine")
            || !valid_identifier(&change.entity_id)
            || !matches!(change.operation.as_str(), "upsert" | "delete")
            || !valid_iso(&change.updated_at)
        {
            return Err("Очередь синхронизации содержит некорректное изменение".into());
        }
        match (&*change.operation, &change.payload) {
            ("upsert", Some(payload)) => validate_payload(
                &change.entity,
                &change.entity_id,
                &change.updated_at,
                payload,
            )?,
            ("delete", None) => {}
            _ => return Err("Изменение не совпадает с его данными".into()),
        }
    }
    Ok(())
}

fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(12))
        .user_agent("DayDesk/0.1")
        .build()
        .map_err(|_| "Не удалось подготовить соединение синхронизации".into())
}

fn read_json<T: DeserializeOwned>(mut response: Response, message: &str) -> Result<T, String> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
        return Err(message.into());
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| message.to_string())?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(message.into());
    }
    serde_json::from_slice(&bytes).map_err(|_| message.into())
}

fn map_http_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 => "Сервер отклонил авторизацию устройства".into(),
        429 => "Слишком много запросов. Попробуйте позже".into(),
        _ => "Сервер синхронизации временно недоступен".into(),
    }
}

#[tauri::command]
pub async fn sync_device_status() -> Result<Option<SyncDeviceStatus>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        load_credential().map(|value| value.as_ref().map(Into::into))
    })
    .await
    .map_err(|_| "Не удалось проверить настройки синхронизации".to_string())?
}

#[tauri::command]
pub async fn register_sync_device(
    input: RegisterSyncDeviceInput,
) -> Result<SyncDeviceStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let api_url = normalize_api_url(&input.api_url)?;
        let setup_code = input.setup_code.trim();
        let device_name = input.device_name.trim();
        if !(12..=256).contains(&setup_code.len()) {
            return Err("Setup-код должен содержать от 12 до 256 символов".into());
        }
        if device_name.is_empty()
            || device_name.len() > 80
            || device_name.chars().any(char::is_control)
        {
            return Err("Укажите корректное название устройства".into());
        }
        let response = client()?
            .post(format!("{api_url}/v1/devices/register"))
            .json(&RegistrationRequest {
                setup_code,
                name: device_name,
            })
            .send()
            .map_err(|_| "Не удалось подключиться к серверу синхронизации".to_string())?;
        if !response.status().is_success() {
            return Err(map_http_error(response.status()));
        }
        let registration: RegistrationEnvelope =
            read_json(response, "Сервер вернул некорректный ответ регистрации")?;
        if registration.status != "success"
            || !valid_identifier(&registration.data.id)
            || registration.data.token.len() < 32
        {
            return Err("Сервер вернул некорректный ответ регистрации".into());
        }
        let credential = SyncCredential {
            api_url,
            device_id: registration.data.id.clone(),
            device_token: registration.data.token.clone(),
            device_name: device_name.to_string(),
        };
        save_credential(&credential)?;
        Ok(SyncDeviceStatus::from(&credential))
    })
    .await
    .map_err(|_| "Не удалось завершить подключение синхронизации".to_string())?
}

#[tauri::command]
pub async fn exchange_sync_changes(request: SyncRequestBody) -> Result<SyncResponseBody, String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_request(&request)?;
        let credential =
            load_credential()?.ok_or_else(|| "Сначала подключите синхронизацию".to_string())?;
        let response = client()?
            .post(format!("{}/v1/sync", credential.api_url))
            .bearer_auth(&credential.device_token)
            .header("x-device-id", &credential.device_id)
            .json(&request)
            .send()
            .map_err(|_| "Не удалось подключиться к серверу синхронизации".to_string())?;
        if !response.status().is_success() {
            return Err(map_http_error(response.status()));
        }
        let envelope: SyncEnvelope =
            read_json(response, "Сервер вернул некорректный ответ синхронизации")?;
        if envelope.status != "success" || envelope.data.changes.len() > MAX_CHANGES {
            return Err("Сервер вернул некорректный ответ синхронизации".into());
        }
        for change in &envelope.data.changes {
            if !matches!(change.entity.as_str(), "task" | "event" | "routine")
                || !valid_identifier(&change.entity_id)
                || !valid_iso(&change.updated_at)
            {
                return Err("Сервер вернул некорректное изменение".into());
            }
            match (&*change.operation, &change.payload) {
                ("upsert", Some(payload)) => validate_payload(
                    &change.entity,
                    &change.entity_id,
                    &change.updated_at,
                    payload,
                )?,
                ("delete", None) => {}
                _ => return Err("Сервер вернул некорректное изменение".into()),
            }
        }
        Ok(envelope.data)
    })
    .await
    .map_err(|_| "Не удалось завершить синхронизацию".to_string())?
}

#[tauri::command]
pub async fn disconnect_sync_device() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(credential) = load_credential()? else {
            return Ok(());
        };
        let response = client()?
            .delete(format!("{}/v1/devices/current", credential.api_url))
            .bearer_auth(&credential.device_token)
            .header("x-device-id", &credential.device_id)
            .send()
            .map_err(|_| "Не удалось подключиться к серверу синхронизации".to_string())?;
        if !response.status().is_success() && response.status() != reqwest::StatusCode::UNAUTHORIZED
        {
            return Err(map_http_error(response.status()));
        }
        match credential_entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("Не удалось удалить токен из системного хранилища".into()),
        }
    })
    .await
    .map_err(|_| "Не удалось завершить отключение синхронизации".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_local_http_and_requires_https_elsewhere() {
        assert!(normalize_api_url("http://127.0.0.1:4310/").is_ok());
        assert!(normalize_api_url("http://192.168.1.10:4310").is_ok());
        assert!(normalize_api_url("https://sync.example.com").is_ok());
        assert!(normalize_api_url("http://sync.example.com").is_err());
    }

    #[test]
    fn validates_event_ranges_and_payload_identity() {
        let updated_at = "2026-08-30T16:00:00.000Z";
        let valid = serde_json::json!({
            "id": "event-team", "title": "Встреча", "startsAt": "2026-09-01T10:00:00.000Z",
            "endsAt": "2026-09-01T11:00:00.000Z", "type": "meeting", "location": "Переговорная",
            "remindBeforeMinutes": 10, "reminderEnabled": true, "updatedAt": updated_at, "syncVersion": 1
        });
        assert!(validate_payload("event", "event-team", updated_at, &valid).is_ok());
        let mut invalid = valid;
        invalid["endsAt"] = serde_json::json!("2026-09-01T09:00:00.000Z");
        assert!(validate_payload("event", "event-team", updated_at, &invalid).is_err());
        assert!(validate_payload("event", "another-event", updated_at, &invalid).is_err());
    }

    #[test]
    fn validates_routine_schedule() {
        let updated_at = "2026-08-30T16:00:00.000Z";
        let valid = serde_json::json!({
            "id": "routine-lunch", "title": "Обед", "time": "13:00", "days": [1, 2, 3, 4, 5],
            "kind": "meal", "remindBeforeMinutes": 10, "enabled": true, "updatedAt": updated_at, "syncVersion": 1
        });
        assert!(validate_payload("routine", "routine-lunch", updated_at, &valid).is_ok());
        let mut invalid = valid;
        invalid["days"] = serde_json::json!([]);
        assert!(validate_payload("routine", "routine-lunch", updated_at, &invalid).is_err());
    }
}
