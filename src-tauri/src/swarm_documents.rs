//! Saves a document a Swarm manager drafted (a resume, a cover letter, a plan), or a meeting's
//! notes and transcript exported from the Meetings page, into `Downloads/Aura Documents`.
//! The bytes are built in the webview (`src/lib/swarmDocumentFile.ts`, `src/lib/meetingExport.ts`)
//! from what the user just read; this side only owns where they land.
//!
//! Never overwrites: a name that already exists becomes "name (2).docx", "name (3).docx", so
//! saving twice, or saving a revision of a file the user keeps in that folder, can never
//! destroy anything. The file name is reduced to safe characters here, whatever the
//! webview sent, so a draft title cannot walk out of the folder.

use base64::Engine as _;
use serde::Serialize;
use std::io::Write as _;
use tauri::{AppHandle, Manager};

const FOLDER: &str = "Aura Documents";
const MAX_BYTES: usize = 8 * 1024 * 1024;
const EXTENSIONS: [&str; 5] = ["docx", "pdf", "txt", "md", "vtt"];

#[derive(Serialize)]
pub struct SavedDocument {
    path: String,
}

pub(crate) fn safe_stem(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.chars() {
        if ch.is_alphanumeric() || matches!(ch, ' ' | '-' | '_' | '(' | ')' | '.' | ',' | '&') {
            out.push(ch);
        } else {
            out.push(' ');
        }
        if out.chars().count() >= 80 {
            break;
        }
    }
    let collapsed = out.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim_matches(|c: char| c == '.' || c == ' ');
    if trimmed.is_empty() {
        "Aura document".to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub async fn save_swarm_document(
    app: AppHandle,
    stem: String,
    extension: String,
    data_base64: String,
) -> Result<SavedDocument, String> {
    let extension = extension.to_ascii_lowercase();
    if !EXTENSIONS.contains(&extension.as_str()) {
        return Err("Only Word, PDF, text, Markdown and subtitle files can be saved.".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|_| "The document could not be prepared.".to_string())?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("The document is empty or too large.".to_string());
    }
    let ticket = crate::security::authorize(&app, crate::security::Operation::SaveDocument)?;
    let folder = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?
        .join(FOLDER);
    let stem = safe_stem(&stem);
    let path = tauri::async_runtime::spawn_blocking(move || -> Result<std::path::PathBuf, String> {
        std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;
        for n in 1..=99 {
            let name = if n == 1 {
                format!("{stem}.{extension}")
            } else {
                format!("{stem} ({n}).{extension}")
            };
            let candidate = folder.join(name);
            match std::fs::OpenOptions::new().write(true).create_new(true).open(&candidate) {
                Ok(mut file) => {
                    file.write_all(&bytes).map_err(|error| error.to_string())?;
                    file.sync_all().map_err(|error| error.to_string())?;
                    return Ok(candidate);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("There are too many files with that name in Aura Documents.".to_string())
    })
    .await
    .map_err(|error| error.to_string())??;
    crate::security::recheck(&app, crate::security::Operation::SaveDocument, &ticket)?;
    log::info!("swarm.documents: saved extension={} bytes={}", path.extension().and_then(|e| e.to_str()).unwrap_or(""), path.metadata().map(|m| m.len()).unwrap_or(0));
    Ok(SavedDocument {
        path: path.to_string_lossy().to_string(),
    })
}
