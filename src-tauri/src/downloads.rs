use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Manager};

pub(crate) const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MailAttachmentDto {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) size: u64,
    pub(crate) mime_type: String,
    pub(crate) downloadable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResultDto {
    file_name: String,
    path: String,
}

fn is_windows_reserved(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && stem.as_bytes()[3].is_ascii_digit()
            && stem.as_bytes()[3] != b'0')
}

pub(crate) fn safe_filename(value: &str) -> String {
    let mut sanitized = value
        .chars()
        .filter(|character| {
            character.is_alphanumeric()
                || matches!(character, ' ' | '-' | '_' | '.' | '(' | ')' | '[' | ']')
        })
        .take(120)
        .collect::<String>();
    while sanitized.contains("..") {
        sanitized = sanitized.replace("..", ".");
    }
    sanitized = sanitized
        .trim_matches(|character| matches!(character, ' ' | '.'))
        .to_string();
    if sanitized.is_empty() {
        sanitized = "attachment.bin".to_string();
    }
    if is_windows_reserved(&sanitized) {
        sanitized.insert(0, '_');
    }
    sanitized
}

fn available_path(directory: &Path, file_name: &str) -> Result<PathBuf, String> {
    let candidate = directory.join(file_name);
    if !candidate.exists() {
        return Ok(candidate);
    }
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let extension = path.extension().and_then(|value| value.to_str());
    for index in 1..=999 {
        let next_name = match extension {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let next = directory.join(next_name);
        if !next.exists() {
            return Ok(next);
        }
    }
    Err("В папке «Загрузки» слишком много файлов с таким именем".to_string())
}

fn create_download(path: &Path) -> Result<std::fs::File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .map_err(|_| "Не удалось создать файл в папке «Загрузки»".to_string())
}

pub(crate) fn save_attachment(
    app: &AppHandle,
    suggested_name: &str,
    bytes: &[u8],
) -> Result<DownloadResultDto, String> {
    if bytes.is_empty() || bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err("Размер вложения должен быть от 1 байта до 20 МБ".to_string());
    }
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| "Системная папка «Загрузки» недоступна".to_string())?;
    fs::create_dir_all(&directory)
        .map_err(|_| "Не удалось открыть папку «Загрузки»".to_string())?;
    let safe_name = safe_filename(suggested_name);
    let path = available_path(&directory, &safe_name)?;
    let mut file = create_download(&path)?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&path);
        let _ = error;
        return Err("Не удалось сохранить вложение".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&safe_name)
        .to_string();
    Ok(DownloadResultDto {
        file_name,
        path: path.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_paths_and_reserved_names() {
        assert_eq!(safe_filename("../../secret.txt"), "secret.txt");
        assert_eq!(safe_filename("CON.txt"), "_CON.txt");
        assert_eq!(safe_filename("отчёт: август?.pdf"), "отчёт август.pdf");
    }

    #[test]
    fn chooses_a_new_name_without_overwriting() {
        let directory =
            std::env::temp_dir().join(format!("daydesk-download-test-{}", std::process::id()));
        fs::create_dir_all(&directory).expect("create test directory");
        let existing = directory.join("report.pdf");
        fs::write(&existing, b"existing").expect("create existing file");
        let next = available_path(&directory, "report.pdf").expect("choose available path");
        assert_eq!(
            next.file_name().and_then(|value| value.to_str()),
            Some("report (1).pdf")
        );
        fs::remove_file(existing).expect("remove test file");
        fs::remove_dir(directory).expect("remove test directory");
    }
}
