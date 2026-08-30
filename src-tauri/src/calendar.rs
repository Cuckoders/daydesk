use crate::oauth::{access_token, http_client, validate_account_id, OAuthProvider};
use chrono::{DateTime, Duration, Local, NaiveDate, SecondsFormat, TimeZone, Utc};
use reqwest::{
    blocking::{Client, RequestBuilder, Response},
    StatusCode,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Take};
use url::Url;

const MAX_CALENDAR_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SYNCED_EVENTS_BYTES: usize = 2 * 1024 * 1024;
const MAX_EVENTS: usize = 5_000;
const MAX_PAGES: usize = 40;
const MAX_TITLE_CHARS: usize = 300;
const MAX_LOCATION_CHARS: usize = 500;
const MAX_REMOTE_ID_CHARS: usize = 1_024;
const MAX_RANGE_DAYS: i64 = 400;
const MAX_EVENT_DAYS: i64 = 31;
const MAX_REMINDER_MINUTES: i64 = 7 * 24 * 60;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarRangeInput {
    provider: OAuthProvider,
    account_id: String,
    time_min: String,
    time_max: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventInput {
    provider: OAuthProvider,
    account_id: String,
    remote_id: Option<String>,
    title: String,
    starts_at: String,
    ends_at: String,
    location: Option<String>,
    remind_before_minutes: i64,
    #[serde(default)]
    reminder_enabled: bool,
    #[serde(default)]
    uses_default_reminder: bool,
    #[serde(default)]
    update_reminders: bool,
    #[serde(default)]
    update_title: bool,
    #[serde(default)]
    update_time: bool,
    #[serde(default)]
    update_location: bool,
    version: Option<String>,
    operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDeleteInput {
    provider: OAuthProvider,
    account_id: String,
    remote_id: String,
    version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEventDto {
    remote_id: String,
    title: String,
    starts_at: String,
    ends_at: String,
    location: Option<String>,
    remind_before_minutes: i64,
    reminder_enabled: bool,
    all_day: bool,
    uses_default_reminder: bool,
    start_date: Option<String>,
    end_date: Option<String>,
    version: Option<String>,
}

#[derive(Debug)]
struct ValidatedEvent {
    remote_id: Option<String>,
    title: String,
    starts_at: DateTime<Utc>,
    ends_at: DateTime<Utc>,
    location: Option<String>,
    remind_before_minutes: i64,
    reminder_enabled: bool,
    uses_default_reminder: bool,
    update_reminders: bool,
    update_title: bool,
    update_time: bool,
    update_location: bool,
    version: Option<String>,
    operation_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventList {
    #[serde(default)]
    items: Vec<GoogleEvent>,
    next_page_token: Option<String>,
    #[serde(default)]
    default_reminders: Vec<GoogleReminderOverride>,
}

#[derive(Deserialize)]
struct GoogleEvent {
    id: String,
    etag: Option<String>,
    #[serde(default)]
    status: String,
    summary: Option<String>,
    location: Option<String>,
    start: GoogleEventTime,
    end: GoogleEventTime,
    reminders: Option<GoogleReminders>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleEventTime {
    date_time: Option<String>,
    date: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleReminders {
    #[serde(default)]
    use_default: bool,
    #[serde(default)]
    overrides: Vec<GoogleReminderOverride>,
}

#[derive(Deserialize)]
struct GoogleReminderOverride {
    minutes: i64,
}

#[derive(Deserialize)]
struct MicrosoftEventList {
    #[serde(default)]
    value: Vec<MicrosoftEvent>,
    #[serde(rename = "@odata.nextLink")]
    next_link: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftEvent {
    id: String,
    #[serde(rename = "@odata.etag")]
    etag: Option<String>,
    change_key: Option<String>,
    subject: Option<String>,
    start: MicrosoftEventTime,
    end: MicrosoftEventTime,
    location: Option<MicrosoftLocation>,
    #[serde(default)]
    is_reminder_on: bool,
    #[serde(default)]
    reminder_minutes_before_start: i64,
    #[serde(default)]
    is_all_day: bool,
    #[serde(default)]
    is_cancelled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftEventTime {
    date_time: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MicrosoftLocation {
    display_name: Option<String>,
}

fn validate_text(
    value: &str,
    field: &str,
    max_chars: usize,
    required: bool,
) -> Result<Option<String>, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return if required {
            Err(format!("Поле «{field}» не может быть пустым"))
        } else {
            Ok(None)
        };
    }
    if trimmed.chars().count() > max_chars || trimmed.chars().any(char::is_control) {
        return Err(format!("Поле «{field}» содержит недопустимое значение"));
    }
    Ok(Some(trimmed.to_string()))
}

fn parse_timestamp(value: &str, field: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|date| date.with_timezone(&Utc))
        .map_err(|_| format!("Некорректное поле «{field}»"))
}

fn validate_range(input: &CalendarRangeInput) -> Result<(DateTime<Utc>, DateTime<Utc>), String> {
    validate_account_id(&input.account_id)?;
    let time_min = parse_timestamp(&input.time_min, "Начало периода")?;
    let time_max = parse_timestamp(&input.time_max, "Конец периода")?;
    let days = (time_max - time_min).num_days();
    if days <= 0 || days > MAX_RANGE_DAYS {
        return Err("Период синхронизации должен быть от одного до 400 дней".into());
    }
    Ok((time_min, time_max))
}

fn validate_remote_id(value: &str) -> Result<String, String> {
    let value = validate_text(value, "ID события", MAX_REMOTE_ID_CHARS, true)?
        .expect("обязательное поле проверено");
    if value.contains("..")
        || !value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'=' | b'+' | b'/')
        })
    {
        return Err("Некорректный идентификатор события".into());
    }
    Ok(value)
}

fn validate_version(value: &str) -> Result<String, String> {
    validate_text(value, "Версия события", MAX_REMOTE_ID_CHARS, true)?
        .ok_or_else(|| "Некорректная версия события".to_string())
}

fn validate_operation_id(value: &str) -> Result<String, String> {
    let value = validate_text(value, "ID операции", 128, true)?
        .ok_or_else(|| "Некорректный ID операции".to_string())?;
    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Некорректный ID операции".into());
    }
    Ok(value)
}

fn validate_event(input: CalendarEventInput) -> Result<ValidatedEvent, String> {
    validate_account_id(&input.account_id)?;
    let title = validate_text(&input.title, "Название", MAX_TITLE_CHARS, true)?
        .expect("обязательное поле проверено");
    let starts_at = parse_timestamp(&input.starts_at, "Начало события")?;
    let ends_at = parse_timestamp(&input.ends_at, "Конец события")?;
    let duration = ends_at - starts_at;
    if duration.num_seconds() <= 0 || duration.num_days() > MAX_EVENT_DAYS {
        return Err("Событие должно длиться от одной секунды до 31 дня".into());
    }
    if !(0..=MAX_REMINDER_MINUTES).contains(&input.remind_before_minutes) {
        return Err("Интервал напоминания должен быть от 0 минут до 7 дней".into());
    }
    let location = input
        .location
        .map(|value| validate_text(&value, "Место", MAX_LOCATION_CHARS, false))
        .transpose()?
        .flatten();
    let remote_id = input
        .remote_id
        .map(|value| validate_remote_id(&value))
        .transpose()?;
    let version = input
        .version
        .map(|value| validate_version(&value))
        .transpose()?;
    if remote_id.is_some() && version.is_none() {
        return Err("Событие изменилось или ещё не синхронизировано. Обновите календарь".into());
    }
    if remote_id.is_some()
        && !(input.update_title
            || input.update_time
            || input.update_location
            || input.update_reminders)
    {
        return Err("В событии нет изменений для отправки в календарь".into());
    }
    let operation_id = input
        .operation_id
        .map(|value| validate_operation_id(&value))
        .transpose()?;
    if remote_id.is_none() && operation_id.is_none() {
        return Err("Не удалось подготовить безопасное создание события".into());
    }
    Ok(ValidatedEvent {
        remote_id,
        title,
        starts_at,
        ends_at,
        location,
        remind_before_minutes: input.remind_before_minutes,
        reminder_enabled: input.reminder_enabled,
        uses_default_reminder: input.uses_default_reminder,
        update_reminders: input.update_reminders,
        update_title: input.update_title,
        update_time: input.update_time,
        update_location: input.update_location,
        version,
        operation_id,
    })
}

fn response_error(response: &Response) -> String {
    if matches!(
        response.status(),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN
    ) {
        "Переподключите аккаунт и разрешите DayDesk работу с календарём".into()
    } else if response.status() == StatusCode::TOO_MANY_REQUESTS {
        "Календарный сервис временно ограничил частоту запросов".into()
    } else if matches!(
        response.status(),
        StatusCode::PRECONDITION_FAILED | StatusCode::CONFLICT
    ) {
        "Событие уже изменилось в календаре. Обновите календарь и повторите действие".into()
    } else {
        "Календарный сервис временно недоступен".into()
    }
}

fn read_json<T: DeserializeOwned>(response: Response) -> Result<T, String> {
    if !response.status().is_success() {
        return Err(response_error(&response));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_CALENDAR_RESPONSE_BYTES as u64)
    {
        return Err("Ответ календаря слишком большой".into());
    }
    let mut bytes = Vec::new();
    let mut limited: Take<Response> = response.take(MAX_CALENDAR_RESPONSE_BYTES as u64 + 1);
    limited
        .read_to_end(&mut bytes)
        .map_err(|_| "Не удалось прочитать ответ календаря".to_string())?;
    if bytes.len() > MAX_CALENDAR_RESPONSE_BYTES {
        return Err("Ответ календаря слишком большой".into());
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| "Календарный сервис вернул некорректный ответ".to_string())
}

fn send_json<T: DeserializeOwned>(request: RequestBuilder) -> Result<T, String> {
    let response = request
        .send()
        .map_err(|_| "Не удалось связаться с календарным сервисом".to_string())?;
    read_json(response)
}

fn parse_local_date(date: &str) -> Result<DateTime<Utc>, String> {
    let date = NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|_| "Календарь вернул некорректную дату".to_string())?;
    let midnight = date.and_hms_opt(0, 0, 0).expect("полночь допустима");
    // В некоторых часовых поясах переход на летнее время происходит ровно
    // в полночь. Берём первый существующий момент календарной даты, не
    // отбрасывая корректное all-day событие целиком.
    (0..=180)
        .find_map(|minutes| {
            Local
                .from_local_datetime(&(midnight + Duration::minutes(minutes)))
                .earliest()
        })
        .map(|local| local.with_timezone(&Utc))
        .ok_or_else(|| "Не удалось определить локальную дату события".to_string())
}

fn parse_google_time(value: &GoogleEventTime) -> Result<(DateTime<Utc>, bool), String> {
    if let Some(date_time) = value.date_time.as_deref() {
        return parse_timestamp(date_time, "Время события").map(|time| (time, false));
    }
    let date = value
        .date
        .as_deref()
        .ok_or_else(|| "Календарь вернул событие без времени".to_string())?;
    parse_local_date(date).map(|time| (time, true))
}

fn google_event_to_dto(
    event: GoogleEvent,
    default_reminders: &[GoogleReminderOverride],
) -> Result<Option<CalendarEventDto>, String> {
    if event.status == "cancelled" {
        return Ok(None);
    }
    let remote_id = validate_remote_id(&event.id)?;
    let start_date = event.start.date.clone();
    let end_date = event.end.date.clone();
    let (starts_at, start_all_day) = parse_google_time(&event.start)?;
    let (ends_at, end_all_day) = parse_google_time(&event.end)?;
    if ends_at <= starts_at {
        return Err("Календарь вернул событие с некорректной длительностью".into());
    }
    let uses_default_reminder = event
        .reminders
        .as_ref()
        .is_some_and(|reminders| reminders.use_default);
    let effective_reminders = event.reminders.as_ref().map_or(&[][..], |reminders| {
        if reminders.use_default {
            default_reminders
        } else {
            reminders.overrides.as_slice()
        }
    });
    let reminder = effective_reminders
        .iter()
        .map(|item| item.minutes)
        .min()
        .filter(|minutes| (0..=MAX_REMINDER_MINUTES).contains(minutes))
        .unwrap_or(0);
    let reminder_enabled = effective_reminders
        .iter()
        .any(|item| (0..=MAX_REMINDER_MINUTES).contains(&item.minutes));
    Ok(Some(CalendarEventDto {
        remote_id,
        title: event
            .summary
            .and_then(|title| {
                validate_text(&title, "Название", MAX_TITLE_CHARS, false)
                    .ok()
                    .flatten()
            })
            .unwrap_or_else(|| "Без названия".into()),
        starts_at: starts_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        ends_at: ends_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        location: event.location.and_then(|value| {
            validate_text(&value, "Место", MAX_LOCATION_CHARS, false)
                .ok()
                .flatten()
        }),
        remind_before_minutes: reminder,
        reminder_enabled,
        all_day: start_all_day && end_all_day,
        uses_default_reminder,
        start_date,
        end_date,
        version: event.etag.and_then(|value| validate_version(&value).ok()),
    }))
}

fn push_synced_event(
    events: &mut Vec<CalendarEventDto>,
    serialized_bytes: &mut usize,
    event: CalendarEventDto,
) -> Result<(), String> {
    let event_bytes = serde_json::to_vec(&event)
        .map_err(|_| "Не удалось подготовить события календаря".to_string())?
        .len();
    *serialized_bytes = serialized_bytes.saturating_add(event_bytes);
    if events.len() >= MAX_EVENTS || *serialized_bytes > MAX_SYNCED_EVENTS_BYTES {
        return Err("В календаре слишком много событий для безопасной синхронизации".into());
    }
    events.push(event);
    Ok(())
}

fn google_events(
    client: &Client,
    token: &str,
    time_min: DateTime<Utc>,
    time_max: DateTime<Utc>,
) -> Result<Vec<CalendarEventDto>, String> {
    let mut events = Vec::new();
    let mut serialized_bytes = 0;
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = Url::parse("https://www.googleapis.com/calendar/v3/calendars/primary/events")
            .map_err(|_| "Не удалось подготовить адрес Google Calendar".to_string())?;
        {
            let mut query = url.query_pairs_mut();
            query
                .append_pair("singleEvents", "true")
                .append_pair("orderBy", "startTime")
                .append_pair("showDeleted", "false")
                .append_pair("maxResults", "250")
                .append_pair("fields", "nextPageToken,defaultReminders(method,minutes),items(id,etag,status,summary,location,start(date,dateTime),end(date,dateTime),reminders(useDefault,overrides(method,minutes)))")
                .append_pair("timeMin", &time_min.to_rfc3339())
                .append_pair("timeMax", &time_max.to_rfc3339());
            if let Some(token) = page_token.as_deref() {
                query.append_pair("pageToken", token);
            }
        }
        let page: GoogleEventList = send_json(client.get(url).bearer_auth(token))?;
        for event in page.items {
            if let Some(event) = google_event_to_dto(event, &page.default_reminders)? {
                push_synced_event(&mut events, &mut serialized_bytes, event)?;
            }
        }
        page_token = page.next_page_token;
        if page_token.is_none() {
            break;
        }
    }
    if page_token.is_some() {
        return Err("Календарь вернул неполный список событий".into());
    }
    Ok(events)
}

fn parse_microsoft_utc_time(value: &str) -> Result<DateTime<Utc>, String> {
    if let Ok(date) = DateTime::parse_from_rfc3339(value) {
        return Ok(date.with_timezone(&Utc));
    }
    parse_timestamp(&format!("{value}Z"), "Время события")
}

fn parse_microsoft_all_day(value: &str) -> Result<DateTime<Utc>, String> {
    let date = value
        .get(..10)
        .ok_or_else(|| "Календарь вернул некорректную дату".to_string())?;
    parse_local_date(date)
}

fn microsoft_event_to_dto(event: MicrosoftEvent) -> Result<Option<CalendarEventDto>, String> {
    if event.is_cancelled {
        return Ok(None);
    }
    let start_date = event
        .is_all_day
        .then(|| event.start.date_time.get(..10).map(str::to_string))
        .flatten();
    let end_date = event
        .is_all_day
        .then(|| event.end.date_time.get(..10).map(str::to_string))
        .flatten();
    let starts_at = if event.is_all_day {
        parse_microsoft_all_day(&event.start.date_time)?
    } else {
        parse_microsoft_utc_time(&event.start.date_time)?
    };
    let ends_at = if event.is_all_day {
        parse_microsoft_all_day(&event.end.date_time)?
    } else {
        parse_microsoft_utc_time(&event.end.date_time)?
    };
    if ends_at <= starts_at {
        return Err("Календарь вернул событие с некорректной длительностью".into());
    }
    Ok(Some(CalendarEventDto {
        remote_id: validate_remote_id(&event.id)?,
        title: event
            .subject
            .and_then(|title| {
                validate_text(&title, "Название", MAX_TITLE_CHARS, false)
                    .ok()
                    .flatten()
            })
            .unwrap_or_else(|| "Без названия".into()),
        starts_at: starts_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        ends_at: ends_at.to_rfc3339_opts(SecondsFormat::Millis, true),
        location: event
            .location
            .and_then(|location| location.display_name)
            .and_then(|value| {
                validate_text(&value, "Место", MAX_LOCATION_CHARS, false)
                    .ok()
                    .flatten()
            }),
        remind_before_minutes: if event.is_reminder_on {
            event
                .reminder_minutes_before_start
                .clamp(0, MAX_REMINDER_MINUTES)
        } else {
            0
        },
        reminder_enabled: event.is_reminder_on,
        all_day: event.is_all_day,
        uses_default_reminder: false,
        start_date,
        end_date,
        version: event
            .etag
            .or_else(|| event.change_key.map(|value| format!("W/\"{value}\"")))
            .and_then(|value| validate_version(&value).ok()),
    }))
}

fn validate_graph_next_link(value: &str) -> Result<Url, String> {
    let url =
        Url::parse(value).map_err(|_| "Календарь вернул некорректную страницу".to_string())?;
    if url.scheme() != "https" || url.host_str() != Some("graph.microsoft.com") {
        return Err("Календарь вернул небезопасный адрес страницы".into());
    }
    Ok(url)
}

fn microsoft_events(
    client: &Client,
    token: &str,
    time_min: DateTime<Utc>,
    time_max: DateTime<Utc>,
) -> Result<Vec<CalendarEventDto>, String> {
    let mut url = Url::parse("https://graph.microsoft.com/v1.0/me/calendarView")
        .map_err(|_| "Не удалось подготовить адрес Outlook Calendar".to_string())?;
    url.query_pairs_mut()
        .append_pair("startDateTime", &time_min.to_rfc3339())
        .append_pair("endDateTime", &time_max.to_rfc3339())
        .append_pair("$top", "250")
        .append_pair(
            "$select",
            "id,subject,start,end,location,isReminderOn,reminderMinutesBeforeStart,isAllDay,isCancelled,changeKey",
        );
    let mut events = Vec::new();
    let mut serialized_bytes = 0;
    let mut next = Some(url);
    for _ in 0..MAX_PAGES {
        let Some(page_url) = next.take() else {
            break;
        };
        let page: MicrosoftEventList = send_json(
            client
                .get(page_url)
                .bearer_auth(token)
                .header("Prefer", "outlook.timezone=\"UTC\""),
        )?;
        for event in page.value {
            if let Some(event) = microsoft_event_to_dto(event)? {
                push_synced_event(&mut events, &mut serialized_bytes, event)?;
            }
        }
        next = page
            .next_link
            .as_deref()
            .map(validate_graph_next_link)
            .transpose()?;
    }
    if next.is_some() {
        return Err("Календарь вернул неполный список событий".into());
    }
    Ok(events)
}

fn calendar_path(provider: OAuthProvider, remote_id: Option<&str>) -> Result<Url, String> {
    let base = match provider {
        OAuthProvider::Gmail => "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        OAuthProvider::Outlook => "https://graph.microsoft.com/v1.0/me/events",
    };
    let mut url =
        Url::parse(base).map_err(|_| "Не удалось подготовить адрес календаря".to_string())?;
    if let Some(id) = remote_id {
        url.path_segments_mut()
            .map_err(|_| "Не удалось подготовить адрес события".to_string())?
            .push(id);
    }
    Ok(url)
}

fn google_payload(event: &ValidatedEvent) -> serde_json::Value {
    let overrides = if event.reminder_enabled {
        vec![serde_json::json!({ "method": "popup", "minutes": event.remind_before_minutes })]
    } else {
        Vec::new()
    };
    let reminders = if event.uses_default_reminder {
        serde_json::json!({ "useDefault": true })
    } else {
        serde_json::json!({ "useDefault": false, "overrides": overrides })
    };
    let mut payload = serde_json::json!({
        "summary": event.title,
        "location": event.location,
        "start": { "dateTime": event.starts_at.to_rfc3339_opts(SecondsFormat::Millis, true) },
        "end": { "dateTime": event.ends_at.to_rfc3339_opts(SecondsFormat::Millis, true) },
        "reminders": reminders
    });
    if event.remote_id.is_some() {
        let object = payload.as_object_mut().expect("объект события");
        if !event.update_title {
            object.remove("summary");
        }
        if !event.update_time {
            object.remove("start");
            object.remove("end");
        }
        if !event.update_location {
            object.remove("location");
        }
        if !event.update_reminders {
            object.remove("reminders");
        }
    }
    if event.remote_id.is_none() {
        if let Some(operation_id) = event.operation_id.as_deref() {
            payload["id"] = serde_json::Value::String(google_operation_event_id(operation_id));
        }
    }
    payload
}

fn google_operation_event_id(operation_id: &str) -> String {
    let digest = Sha256::digest(operation_id.as_bytes());
    format!("{digest:x}")[..32].to_string()
}

fn microsoft_datetime(value: DateTime<Utc>) -> String {
    value.format("%Y-%m-%dT%H:%M:%S%.3f").to_string()
}

fn microsoft_payload(event: &ValidatedEvent) -> serde_json::Value {
    let mut payload = serde_json::json!({
        "subject": event.title,
        "start": { "dateTime": microsoft_datetime(event.starts_at), "timeZone": "UTC" },
        "end": { "dateTime": microsoft_datetime(event.ends_at), "timeZone": "UTC" },
        "location": { "displayName": event.location.clone().unwrap_or_default() },
        "isReminderOn": event.reminder_enabled,
        "reminderMinutesBeforeStart": event.remind_before_minutes
    });
    if event.remote_id.is_some() {
        let object = payload.as_object_mut().expect("объект события");
        if !event.update_title {
            object.remove("subject");
        }
        if !event.update_time {
            object.remove("start");
            object.remove("end");
        }
        if !event.update_location {
            object.remove("location");
        }
        if !event.update_reminders {
            object.remove("isReminderOn");
            object.remove("reminderMinutesBeforeStart");
        }
    }
    if event.remote_id.is_none() {
        if let Some(operation_id) = event.operation_id.as_deref() {
            payload["transactionId"] = serde_json::Value::String(operation_id.to_string());
        }
    }
    payload
}

fn upsert_event(
    provider: OAuthProvider,
    client: &Client,
    token: &str,
    event: ValidatedEvent,
) -> Result<CalendarEventDto, String> {
    let url = calendar_path(provider, event.remote_id.as_deref())?;
    let payload = match provider {
        OAuthProvider::Gmail => google_payload(&event),
        OAuthProvider::Outlook => microsoft_payload(&event),
    };
    let mut request = if event.remote_id.is_some() {
        client.patch(url)
    } else {
        client.post(url)
    }
    .bearer_auth(token)
    .json(&payload);
    if let Some(version) = event.version.as_deref() {
        request = request.header(reqwest::header::IF_MATCH, version);
    }
    match provider {
        OAuthProvider::Gmail => {
            let response = request
                .send()
                .map_err(|_| "Не удалось связаться с календарным сервисом".to_string())?;
            let response: GoogleEvent =
                if response.status() == StatusCode::CONFLICT && event.remote_id.is_none() {
                    let operation_id = event.operation_id.as_deref().ok_or_else(|| {
                        "Не удалось восстановить созданное событие календаря".to_string()
                    })?;
                    send_json(
                        client
                            .get(calendar_path(
                                OAuthProvider::Gmail,
                                Some(&google_operation_event_id(operation_id)),
                            )?)
                            .bearer_auth(token),
                    )?
                } else {
                    read_json(response)?
                };
            let fallback_defaults = if event.uses_default_reminder && event.reminder_enabled {
                vec![GoogleReminderOverride {
                    minutes: event.remind_before_minutes,
                }]
            } else {
                Vec::new()
            };
            google_event_to_dto(response, &fallback_defaults)?
                .ok_or_else(|| "Календарный сервис отменил сохранённое событие".into())
        }
        OAuthProvider::Outlook => {
            let response: MicrosoftEvent =
                send_json(request.header("Prefer", "outlook.timezone=\"UTC\""))?;
            microsoft_event_to_dto(response)?
                .ok_or_else(|| "Календарный сервис отменил сохранённое событие".into())
        }
    }
}

fn delete_event(
    provider: OAuthProvider,
    client: &Client,
    token: &str,
    remote_id: &str,
    version: Option<&str>,
) -> Result<(), String> {
    let mut request = client
        .delete(calendar_path(provider, Some(remote_id))?)
        .bearer_auth(token);
    if let Some(version) = version {
        request = request.header(reqwest::header::IF_MATCH, version);
    }
    let response = request
        .send()
        .map_err(|_| "Не удалось связаться с календарным сервисом".to_string())?;
    if response.status().is_success()
        || response.status() == StatusCode::NOT_FOUND
        || (matches!(provider, OAuthProvider::Gmail) && response.status() == StatusCode::GONE)
    {
        Ok(())
    } else {
        Err(response_error(&response))
    }
}

#[tauri::command]
pub async fn sync_calendar(input: CalendarRangeInput) -> Result<Vec<CalendarEventDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (time_min, time_max) = validate_range(&input)?;
        let client = http_client()?;
        let token = access_token(input.provider, &input.account_id, &client)?;
        match input.provider {
            OAuthProvider::Gmail => google_events(&client, token.as_str(), time_min, time_max),
            OAuthProvider::Outlook => microsoft_events(&client, token.as_str(), time_min, time_max),
        }
    })
    .await
    .map_err(|_| "Не удалось завершить синхронизацию календаря".to_string())?
}

#[tauri::command]
pub async fn upsert_calendar_event(input: CalendarEventInput) -> Result<CalendarEventDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let provider = input.provider;
        let account_id = input.account_id.clone();
        let event = validate_event(input)?;
        let client = http_client()?;
        let token = access_token(provider, &account_id, &client)?;
        upsert_event(provider, &client, token.as_str(), event)
    })
    .await
    .map_err(|_| "Не удалось завершить сохранение события".to_string())?
}

#[tauri::command]
pub async fn delete_calendar_event(input: CalendarDeleteInput) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        validate_account_id(&input.account_id)?;
        let remote_id = validate_remote_id(&input.remote_id)?;
        let version = input.version.as_deref().map(validate_version).transpose()?;
        let client = http_client()?;
        let token = access_token(input.provider, &input.account_id, &client)?;
        delete_event(
            input.provider,
            &client,
            token.as_str(),
            &remote_id,
            version.as_deref(),
        )
    })
    .await
    .map_err(|_| "Не удалось завершить удаление события".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_ranges_and_event_duration() {
        let valid = CalendarRangeInput {
            provider: OAuthProvider::Gmail,
            account_id: "mail_account-1".into(),
            time_min: "2026-08-01T00:00:00Z".into(),
            time_max: "2027-08-01T00:00:00Z".into(),
        };
        assert!(validate_range(&valid).is_ok());
        assert!(validate_range(&CalendarRangeInput {
            time_max: "2028-08-01T00:00:00Z".into(),
            ..valid
        })
        .is_err());
    }

    #[test]
    fn rejects_unsafe_remote_ids_and_next_links() {
        assert!(validate_remote_id("../events/other").is_err());
        assert!(validate_graph_next_link("https://evil.example/calendar").is_err());
        assert!(validate_graph_next_link(
            "https://graph.microsoft.com/v1.0/me/calendarView?$skip=2"
        )
        .is_ok());
    }

    #[test]
    fn parses_google_timed_and_all_day_values() {
        let timed = GoogleEventTime {
            date_time: Some("2026-08-30T12:00:00+03:00".into()),
            date: None,
        };
        assert!(!parse_google_time(&timed).unwrap().1);
        let all_day = GoogleEventTime {
            date_time: None,
            date: Some("2026-08-30".into()),
        };
        assert!(parse_google_time(&all_day).unwrap().1);
        let microsoft = parse_microsoft_all_day("2026-08-30T00:00:00.0000000").unwrap();
        assert_eq!(
            microsoft.with_timezone(&Local).date_naive(),
            NaiveDate::from_ymd_opt(2026, 8, 30).unwrap()
        );
        assert_eq!(
            parse_microsoft_utc_time("2026-08-30T12:00:00.0000000")
                .unwrap()
                .to_rfc3339(),
            "2026-08-30T12:00:00+00:00"
        );
    }

    #[test]
    fn honors_disabled_google_reminders() {
        let event = GoogleEvent {
            id: "event_1".into(),
            etag: Some("etag-1".into()),
            status: "confirmed".into(),
            summary: Some("Без напоминания".into()),
            location: None,
            start: GoogleEventTime {
                date_time: Some("2026-08-30T12:00:00Z".into()),
                date: None,
            },
            end: GoogleEventTime {
                date_time: Some("2026-08-30T13:00:00Z".into()),
                date: None,
            },
            reminders: Some(GoogleReminders {
                use_default: false,
                overrides: Vec::new(),
            }),
        };
        let event = google_event_to_dto(event, &[]).unwrap().unwrap();
        assert_eq!(event.remind_before_minutes, 0);
        assert!(!event.reminder_enabled);
    }

    #[test]
    fn preserves_at_start_provider_reminders() {
        let event = GoogleEvent {
            id: "event_1".into(),
            etag: Some("etag-1".into()),
            status: "confirmed".into(),
            summary: Some("В момент начала".into()),
            location: None,
            start: GoogleEventTime {
                date_time: Some("2026-08-30T12:00:00Z".into()),
                date: None,
            },
            end: GoogleEventTime {
                date_time: Some("2026-08-30T13:00:00Z".into()),
                date: None,
            },
            reminders: Some(GoogleReminders {
                use_default: false,
                overrides: vec![GoogleReminderOverride { minutes: 0 }],
            }),
        };
        let event = google_event_to_dto(event, &[]).unwrap().unwrap();
        assert_eq!(event.remind_before_minutes, 0);
        assert!(event.reminder_enabled);
    }

    #[test]
    fn resolves_google_calendar_default_reminders() {
        let event = GoogleEvent {
            id: "event_1".into(),
            etag: Some("etag-1".into()),
            status: "confirmed".into(),
            summary: Some("С настройками календаря".into()),
            location: None,
            start: GoogleEventTime {
                date_time: Some("2026-08-30T12:00:00Z".into()),
                date: None,
            },
            end: GoogleEventTime {
                date_time: Some("2026-08-30T13:00:00Z".into()),
                date: None,
            },
            reminders: Some(GoogleReminders {
                use_default: true,
                overrides: Vec::new(),
            }),
        };
        let defaults = vec![GoogleReminderOverride { minutes: 15 }];
        let event = google_event_to_dto(event, &defaults).unwrap().unwrap();
        assert_eq!(event.remind_before_minutes, 15);
        assert!(event.reminder_enabled);
        assert!(event.uses_default_reminder);
    }

    #[test]
    fn keeps_empty_google_calendar_defaults_disabled() {
        let event = GoogleEvent {
            id: "event_1".into(),
            etag: Some("etag-1".into()),
            status: "confirmed".into(),
            summary: Some("Без напоминания по умолчанию".into()),
            location: None,
            start: GoogleEventTime {
                date_time: Some("2026-08-30T12:00:00Z".into()),
                date: None,
            },
            end: GoogleEventTime {
                date_time: Some("2026-08-30T13:00:00Z".into()),
                date: None,
            },
            reminders: Some(GoogleReminders {
                use_default: true,
                overrides: Vec::new(),
            }),
        };
        let event = google_event_to_dto(event, &[]).unwrap().unwrap();
        assert_eq!(event.remind_before_minutes, 0);
        assert!(!event.reminder_enabled);
        assert!(event.uses_default_reminder);
    }

    #[test]
    fn accepts_all_day_date_during_a_midnight_dst_gap() {
        assert!(parse_local_date("2026-09-06").is_ok());
    }

    #[test]
    fn bounds_the_serialized_calendar_cache() {
        let event = CalendarEventDto {
            remote_id: "event_1".into(),
            title: "Встреча".into(),
            starts_at: "2026-08-30T12:00:00.000Z".into(),
            ends_at: "2026-08-30T13:00:00.000Z".into(),
            location: None,
            remind_before_minutes: 0,
            reminder_enabled: false,
            all_day: false,
            uses_default_reminder: false,
            start_date: None,
            end_date: None,
            version: Some("etag-1".into()),
        };
        let mut events = Vec::new();
        let mut bytes = MAX_SYNCED_EVENTS_BYTES;
        assert!(push_synced_event(&mut events, &mut bytes, event).is_err());
        assert!(events.is_empty());
    }

    #[test]
    fn validates_event_fields() {
        let event = CalendarEventInput {
            provider: OAuthProvider::Outlook,
            account_id: "mail_account-1".into(),
            remote_id: None,
            title: "Встреча".into(),
            starts_at: "2026-08-30T12:00:00Z".into(),
            ends_at: "2026-08-30T13:00:00Z".into(),
            location: Some("Переговорная".into()),
            remind_before_minutes: 10,
            reminder_enabled: true,
            uses_default_reminder: false,
            update_reminders: true,
            update_title: true,
            update_time: true,
            update_location: true,
            version: None,
            operation_id: Some("operation-1".into()),
        };
        assert!(validate_event(event).is_ok());
    }

    #[test]
    fn omits_unchanged_reminders_from_patch_payloads() {
        let event = ValidatedEvent {
            remote_id: Some("event_1".into()),
            title: "Встреча".into(),
            starts_at: parse_timestamp("2026-08-30T12:00:00Z", "Начало").unwrap(),
            ends_at: parse_timestamp("2026-08-30T13:00:00Z", "Конец").unwrap(),
            location: None,
            remind_before_minutes: 15,
            reminder_enabled: true,
            uses_default_reminder: false,
            update_reminders: false,
            update_title: true,
            update_time: false,
            update_location: false,
            version: Some("etag-1".into()),
            operation_id: None,
        };
        assert!(google_payload(&event).get("reminders").is_none());
        assert!(microsoft_payload(&event).get("isReminderOn").is_none());
        assert!(google_payload(&event).get("start").is_none());
        assert!(microsoft_payload(&event).get("location").is_none());
        assert_eq!(microsoft_payload(&event)["subject"], "Встреча");
    }

    #[test]
    fn creates_idempotent_provider_payloads() {
        let event = ValidatedEvent {
            remote_id: None,
            title: "Встреча".into(),
            starts_at: parse_timestamp("2026-08-30T12:00:00Z", "Начало").unwrap(),
            ends_at: parse_timestamp("2026-08-30T13:00:00Z", "Конец").unwrap(),
            location: None,
            remind_before_minutes: 10,
            reminder_enabled: true,
            uses_default_reminder: false,
            update_reminders: true,
            update_title: true,
            update_time: true,
            update_location: true,
            version: None,
            operation_id: Some("operation-1".into()),
        };
        assert_eq!(google_payload(&event)["id"].as_str().unwrap().len(), 32);
        assert_eq!(microsoft_payload(&event)["transactionId"], "operation-1");
    }
}
