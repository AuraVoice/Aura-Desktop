//! Saves a document a Swarm manager drafted (a resume, a cover letter, a plan), or a meeting's
//! notes and transcript exported from the Meetings page, wherever the user picks in a Save As
//! dialog (`save_dialog.rs`). The bytes are built in the webview (`src/lib/swarmDocumentFile.ts`,
//! `src/lib/meetingExport.ts`) from what the user just read; this side owns where they land.
//!
//! The webview only suggests a name. It is reduced to safe characters here, and the path
//! itself comes from the operating system's dialog, which asks before replacing a file.

use base64::Engine as _;
use serde::Serialize;
use tauri::AppHandle;

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
) -> Result<Option<SavedDocument>, String> {
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
    let stem = safe_stem(&stem);
    let label = match extension.as_str() {
        "docx" => "Word document",
        "pdf" => "PDF",
        "md" => "Markdown",
        "vtt" => "Subtitles",
        _ => "Text",
    };
    let Some(path) = crate::save_dialog::ask_save_path(&app, &format!("{stem}.{extension}"), label, &[extension.as_str()]).await? else {
        return Ok(None);
    };
    let target = path.clone();
    tauri::async_runtime::spawn_blocking(move || crate::save_dialog::write_chosen(&target, &bytes))
        .await
        .map_err(|error| error.to_string())??;
    crate::security::recheck(&app, crate::security::Operation::SaveDocument, &ticket)?;
    log::info!("swarm.documents: saved extension={} bytes={}", path.extension().and_then(|e| e.to_str()).unwrap_or(""), path.metadata().map(|m| m.len()).unwrap_or(0));
    Ok(Some(SavedDocument {
        path: path.to_string_lossy().to_string(),
    }))
}
