//! The one Save As behind every export (a Swarm document, meeting notes, a dictation, an
//! interview prep sheet, a manager's memory, a recording bundle). The dialog opens HERE,
//! inside the command that writes, so the webview never hands Rust a path to write to:
//! the user picks it in the operating system's own dialog, which also asks before
//! replacing a file that is already there.
//!
//! Every path a dialog returned is remembered for the session, and `open_saved_file`
//! opens or reveals only those. That is what lets "Open" and "Show in folder" work on a
//! file saved anywhere without widening the opener plugin's scope to the whole disk.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

/// Where the next dialog opens: the folder the user picked last, for this session.
static LAST_FOLDER: Mutex<Option<PathBuf>> = Mutex::new(None);
/// Paths the user chose this session; the only ones `open_saved_file` will touch.
static CHOSEN: Mutex<Vec<PathBuf>> = Mutex::new(Vec::new());
const CHOSEN_MAX: usize = 200;

fn start_folder(app: &AppHandle) -> Option<PathBuf> {
    let last = LAST_FOLDER.lock().ok().and_then(|guard| guard.clone());
    last.filter(|dir| dir.is_dir()).or_else(|| app.path().download_dir().ok())
}

fn remember(path: &Path, folder: Option<&Path>) {
    if let Some(folder) = folder {
        if let Ok(mut last) = LAST_FOLDER.lock() {
            *last = Some(folder.to_path_buf());
        }
    }
    if let Ok(mut chosen) = CHOSEN.lock() {
        chosen.retain(|p| p != path);
        chosen.push(path.to_path_buf());
        let overflow = chosen.len().saturating_sub(CHOSEN_MAX);
        chosen.drain(..overflow);
    }
}

/// Lets `open_saved_file` reach a path a command derived from a chosen folder (the
/// recording bundle's own subfolder).
pub fn allow_open(path: &Path) {
    remember(path, None);
}

fn was_chosen(path: &Path) -> bool {
    CHOSEN.lock().map(|chosen| chosen.iter().any(|p| p == path)).unwrap_or(false)
}

/// The dashboard owns every export button, so the dialog is modal to it when it is open.
fn with_parent<R: tauri::Runtime>(
    app: &AppHandle,
    builder: tauri_plugin_dialog::FileDialogBuilder<R>,
) -> tauri_plugin_dialog::FileDialogBuilder<R> {
    match app.get_webview_window(crate::dashboard::DASHBOARD_WINDOW) {
        Some(window) => builder.set_parent(&window),
        None => builder,
    }
}

/// Asks where to save a file. `Ok(None)` means the user cancelled, which every caller
/// treats as "nothing happened", never as an error. The returned path always ends in
/// one of `extensions`: a name typed without one gets the first appended.
pub async fn ask_save_path(
    app: &AppHandle,
    suggested_name: &str,
    filter_label: &str,
    extensions: &[&str],
) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut builder = app
        .dialog()
        .file()
        .set_title("Save as")
        .set_file_name(suggested_name)
        .add_filter(filter_label, extensions);
    if let Some(folder) = start_folder(app) {
        builder = builder.set_directory(folder);
    }
    with_parent(app, builder).save_file(move |picked| {
        let _ = sender.send(picked);
    });
    let Some(picked) = receiver.await.map_err(|_| "The save dialog closed unexpectedly.".to_string())? else {
        return Ok(None);
    };
    let mut path = picked.into_path().map_err(|error| error.to_string())?;
    let has_extension = path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| extensions.iter().any(|allowed| allowed.eq_ignore_ascii_case(ext)))
        .unwrap_or(false);
    if !has_extension {
        if let Some(first) = extensions.first() {
            let mut name: OsString = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
            name.push(format!(".{first}"));
            path.set_file_name(name);
        }
    }
    remember(&path, path.parent());
    Ok(Some(path))
}

/// Asks for a folder (an export that writes a whole folder of its own inside it).
pub async fn ask_folder(app: &AppHandle, title: &str) -> Result<Option<PathBuf>, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file().set_title(title);
    if let Some(folder) = start_folder(app) {
        builder = builder.set_directory(folder);
    }
    with_parent(app, builder).pick_folder(move |picked| {
        let _ = sender.send(picked);
    });
    let Some(picked) = receiver.await.map_err(|_| "The folder dialog closed unexpectedly.".to_string())? else {
        return Ok(None);
    };
    let folder = picked.into_path().map_err(|error| error.to_string())?;
    if let Ok(mut last) = LAST_FOLDER.lock() {
        *last = Some(folder.clone());
    }
    Ok(Some(folder))
}

/// Writes a chosen file whole: a same-folder temporary, then a rename, so a failed write
/// never leaves half a document where the user's old one was.
pub fn write_chosen(path: &Path, bytes: &[u8]) -> Result<(), String> {
    crate::fsx::write_atomic(path, bytes, crate::fsx::Durability::Fsync)
}

/// Opens a file saved through a dialog this session, or shows it in its folder.
#[tauri::command]
pub async fn open_saved_file(app: AppHandle, path: String, reveal: bool) -> Result<(), String> {
    let path = PathBuf::from(path);
    if !was_chosen(&path) {
        return Err("Aura can only open files you saved from it.".to_string());
    }
    let result = if reveal {
        app.opener().reveal_item_in_dir(&path)
    } else {
        app.opener().open_path(path.to_string_lossy(), None::<&str>)
    };
    result.map_err(|error| error.to_string())
}
