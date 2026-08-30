mod compose;
mod downloads;
mod lifecycle;
mod mail;
mod mail_cache;
mod oauth;
mod reminders;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let start_hidden = std::env::args().any(|argument| argument == "--background");
    let app = tauri::Builder::default()
        .manage(compose::ComposeState::default())
        .manage(reminders::ReminderState::default())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--background"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(move |app| {
            lifecycle::setup_tray(app)?;
            reminders::start_scheduler(app.handle().clone());
            if start_hidden {
                if let Some(window) = app.get_webview_window("main") {
                    window.hide()?;
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            mail::connect_imap,
            mail::sync_imap,
            mail::get_imap_message_content,
            mail::download_imap_attachment,
            mail::disconnect_imap,
            compose::register_mail_attachments,
            compose::clear_mail_attachments,
            compose::send_mail,
            mail_cache::load_mail_cache,
            mail_cache::replace_mail_cache,
            mail_cache::search_mail_cache,
            oauth::oauth_provider_status,
            oauth::connect_oauth,
            oauth::sync_oauth,
            oauth::get_oauth_message_content,
            oauth::download_oauth_attachment,
            oauth::disconnect_oauth,
            reminders::replace_reminders,
            lifecycle::is_autostart_enabled,
            lifecycle::set_autostart_enabled,
            lifecycle::quit_daydesk
        ])
        .build(tauri::generate_context!())
        .expect("не удалось собрать DayDesk");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            lifecycle::show_main_window(app);
        }
    });
}
