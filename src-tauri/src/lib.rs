mod compose;
mod downloads;
mod mail;
mod mail_cache;
mod oauth;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(compose::ComposeState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
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
            oauth::disconnect_oauth
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить DayDesk");
}
