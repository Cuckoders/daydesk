use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::Deserialize;
use std::{collections::HashSet, sync::Mutex, thread, time::Duration};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;

const MAX_REMINDERS: usize = 10_000;
const MAX_TITLE_CHARS: usize = 300;
const MAX_LOCATION_CHARS: usize = 500;
const MAX_REMINDER_MINUTES: i64 = 7 * 24 * 60;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderInput {
    id: String,
    title: String,
    starts_at: String,
    location: Option<String>,
    remind_before_minutes: i64,
    reminder_enabled: bool,
}

#[derive(Clone, Debug)]
struct ScheduledReminder {
    key: String,
    title: String,
    starts_at: DateTime<Utc>,
    location: Option<String>,
    remind_before_minutes: i64,
}

#[derive(Default)]
struct ReminderBook {
    scheduled: Vec<ScheduledReminder>,
    notified: HashSet<String>,
}

#[derive(Default)]
pub struct ReminderState(Mutex<ReminderBook>);

#[derive(Clone, Debug)]
struct DueReminder {
    key: String,
    title: String,
    body: String,
}

fn validate_text(value: &str, field: &str, max_chars: usize) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err(format!("Поле «{field}» не может быть пустым"));
    }
    if trimmed.chars().count() > max_chars {
        return Err(format!("Поле «{field}» слишком длинное"));
    }
    Ok(trimmed.to_string())
}

fn normalize_reminders(events: Vec<ReminderInput>) -> Result<Vec<ScheduledReminder>, String> {
    let events = events
        .into_iter()
        .filter(|event| event.reminder_enabled)
        .collect::<Vec<_>>();
    if events.len() > MAX_REMINDERS {
        return Err("Слишком много событий для фоновых напоминаний".into());
    }

    events
        .into_iter()
        .map(|event| {
            if event.remind_before_minutes > MAX_REMINDER_MINUTES {
                return Err("Интервал напоминания не может превышать семь дней".into());
            }

            let id = validate_text(&event.id, "ID события", 200)?;
            let title = validate_text(&event.title, "Название", MAX_TITLE_CHARS)?;
            let starts_at = DateTime::parse_from_rfc3339(&event.starts_at)
                .map_err(|_| "Некорректное время события".to_string())?
                .with_timezone(&Utc);
            let location = event
                .location
                .map(|value| validate_text(&value, "Место", MAX_LOCATION_CHARS))
                .transpose()?;

            Ok(ScheduledReminder {
                key: format!("{id}:{}", starts_at.to_rfc3339()),
                title,
                starts_at,
                location,
                remind_before_minutes: event.remind_before_minutes,
            })
        })
        .collect()
}

fn take_due(book: &mut ReminderBook, now: DateTime<Utc>) -> Vec<DueReminder> {
    let mut due = Vec::new();

    for reminder in &book.scheduled {
        let grace = if reminder.remind_before_minutes == 0 {
            ChronoDuration::seconds(30)
        } else {
            ChronoDuration::zero()
        };
        if book.notified.contains(&reminder.key) || reminder.starts_at + grace <= now {
            continue;
        }
        let notify_at =
            reminder.starts_at - ChronoDuration::minutes(reminder.remind_before_minutes);
        if now < notify_at {
            continue;
        }

        let seconds_left = (reminder.starts_at - now).num_seconds().max(0);
        let minutes_left = (seconds_left + 59) / 60;
        book.notified.insert(reminder.key.clone());
        due.push(DueReminder {
            key: reminder.key.clone(),
            title: if reminder.remind_before_minutes == 0 {
                format!("Сейчас: {}", reminder.title)
            } else {
                format!("Через {minutes_left} мин: {}", reminder.title)
            },
            body: reminder
                .location
                .clone()
                .unwrap_or_else(|| "DayDesk напомнит вовремя".into()),
        });
    }

    due
}

fn deliver_due(app: &AppHandle) {
    let state = app.state::<ReminderState>();
    let due = {
        let Ok(mut book) = state.0.lock() else {
            return;
        };
        take_due(&mut book, Utc::now())
    };

    for reminder in due {
        let delivered = app
            .notification()
            .builder()
            .title(reminder.title)
            .body(reminder.body)
            .show()
            .is_ok();
        if !delivered {
            if let Ok(mut book) = state.0.lock() {
                book.notified.remove(&reminder.key);
            }
        }
    }
}

pub fn start_scheduler(app: AppHandle) {
    thread::spawn(move || loop {
        deliver_due(&app);
        thread::sleep(Duration::from_secs(15));
    });
}

#[tauri::command]
pub fn replace_reminders(
    events: Vec<ReminderInput>,
    state: State<'_, ReminderState>,
) -> Result<(), String> {
    let scheduled = normalize_reminders(events)?;
    let active_keys = scheduled
        .iter()
        .map(|reminder| reminder.key.clone())
        .collect::<HashSet<_>>();
    let mut book = state
        .0
        .lock()
        .map_err(|_| "Не удалось обновить фоновые напоминания".to_string())?;
    book.notified.retain(|key| active_keys.contains(key));
    book.scheduled = scheduled;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(starts_at: &str, remind_before_minutes: i64) -> ReminderInput {
        ReminderInput {
            id: "event-1".into(),
            title: "Встреча".into(),
            starts_at: starts_at.into(),
            location: Some("Переговорная".into()),
            remind_before_minutes,
            reminder_enabled: remind_before_minutes > 0,
        }
    }

    #[test]
    fn due_reminder_is_returned_only_once() {
        let now = DateTime::parse_from_rfc3339("2026-08-30T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let scheduled = normalize_reminders(vec![input("2026-08-30T12:09:00Z", 10)]).unwrap();
        let mut book = ReminderBook {
            scheduled,
            ..Default::default()
        };

        let first = take_due(&mut book, now);
        assert_eq!(first.len(), 1);
        assert!(first[0].title.contains("Через 9 мин"));
        assert_eq!(take_due(&mut book, now).len(), 0);
    }

    #[test]
    fn future_and_expired_reminders_do_not_fire() {
        let now = DateTime::parse_from_rfc3339("2026-08-30T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let scheduled = normalize_reminders(vec![
            input("2026-08-30T13:00:00Z", 10),
            ReminderInput {
                id: "event-2".into(),
                ..input("2026-08-30T11:59:00Z", 10)
            },
        ])
        .unwrap();
        let mut book = ReminderBook {
            scheduled,
            ..Default::default()
        };

        assert!(take_due(&mut book, now).is_empty());
    }

    #[test]
    fn invalid_reminders_are_rejected() {
        assert!(normalize_reminders(vec![input("not-a-date", 10)]).is_err());
        assert!(normalize_reminders(vec![input("2026-08-30T12:00:00Z", 10_081)]).is_err());
        assert!(normalize_reminders(vec![ReminderInput {
            title: "   ".into(),
            ..input("2026-08-30T12:00:00Z", 10)
        }])
        .is_err());
    }

    #[test]
    fn supports_enabled_at_start_reminders() {
        let now = DateTime::parse_from_rfc3339("2026-08-30T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc);
        let scheduled = normalize_reminders(vec![ReminderInput {
            reminder_enabled: true,
            ..input("2026-08-30T12:00:00Z", 0)
        }])
        .unwrap();
        let mut book = ReminderBook {
            scheduled,
            ..Default::default()
        };
        let due = take_due(&mut book, now);
        assert_eq!(due.len(), 1);
        assert!(due[0].title.starts_with("Сейчас:"));
    }

    #[test]
    fn counts_only_enabled_reminders_against_the_limit() {
        let disabled = ReminderInput {
            reminder_enabled: false,
            ..input("2026-08-30T12:00:00Z", 0)
        };
        assert!(normalize_reminders(vec![disabled; MAX_REMINDERS + 1])
            .unwrap()
            .is_empty());
    }
}
