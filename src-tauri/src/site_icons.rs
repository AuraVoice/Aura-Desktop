//! Local cache for the favicons shown on research source chips.
//!
//! The app's CSP is `img-src 'self' data: blob:`, so an `<img>` pointed straight
//! at a remote favicon renders as a broken box. This module pulls the bytes
//! through Rust the same way `saved_images.rs` does and hands them back over
//! binary IPC, which the webview turns into a `blob:` URL the CSP allows.
//!
//! Unlike `saved_images.rs` there is no encryption and no `#[cfg(windows)]`
//! gate: a public favicon is not user content, so it is stored as plain bytes.
//! What IS worth protecting is the fact that the cache directory doubles as a
//! list of domains the user researched, which is why the pruner keeps it
//! bounded rather than letting it grow for the life of the install.
//!
//! Every failure answers with an empty response instead of an `Err`. A host
//! with no icon is the normal case, not an error, and the UI already has a
//! coloured monogram to fall back to.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Anything past this is not a favicon, it is a mis-served asset.
const MAX_ICON_BYTES: usize = 512 * 1024;
/// Files kept before the pruner runs, and how many it drops when it does.
const KEEP_ICONS: usize = 400;
const PRUNE_BATCH: usize = 100;

/// Per-install cache directory, a sibling of the saved-image store.
fn icons_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("site-icons"))
}

/// Cache filename for a host. The host is hashed rather than used directly so
/// the name is fixed length and can never contain a path separator.
fn icon_stem(host: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(host.as_bytes());
    let mut stem = String::with_capacity(64);
    for byte in digest.iter() {
        use std::fmt::Write;
        let _ = write!(stem, "{byte:02x}");
    }
    stem
}

/// True for a plain domain like `sub.example.co.uk`. Checked before any request
/// is built so a malformed URL cannot turn into a request somewhere unintended.
fn is_plain_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.contains('.')
        && !host.starts_with('.')
        && !host.ends_with('.')
        && !host.contains("..")
        && host
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-')
}

fn empty_response() -> tauri::ipc::Response {
    tauri::ipc::Response::new(Vec::<u8>::new())
}

/// Fetches one candidate URL, returning the bytes only if the response really
/// looks like an image. Several sites answer `/favicon.ico` with a 200 HTML
/// error page, which would otherwise be cached and rendered as a broken image.
async fn fetch_icon(url: &str) -> Option<Vec<u8>> {
    let response = reqwest::get(url).await.ok()?.error_for_status().ok()?;
    let is_image = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.starts_with("image/"))
        .unwrap_or(false);
    if !is_image {
        return None;
    }
    let bytes = response.bytes().await.ok()?;
    if bytes.is_empty() || bytes.len() > MAX_ICON_BYTES {
        return None;
    }
    Some(bytes.to_vec())
}

/// Returns one host's favicon bytes, downloading it the first time and reading
/// it off disk every time after. An empty response means "this host has no
/// usable icon", which the caller renders as a monogram.
#[tauri::command]
pub async fn site_icon(app: AppHandle, host: String) -> Result<tauri::ipc::Response, String> {
    if !is_plain_host(&host) {
        return Ok(empty_response());
    }

    let dir = icons_dir(&app)?;
    let stem = icon_stem(&host);
    let icon_path = dir.join(format!("{stem}.img"));
    let miss_path = dir.join(format!("{stem}.none"));

    if let Ok(bytes) = std::fs::read(&icon_path) {
        return Ok(tauri::ipc::Response::new(bytes));
    }
    if miss_path.exists() {
        return Ok(empty_response());
    }

    // DuckDuckGo's icon service first: it normalises size and format and
    // answers for sites that only declare a favicon in their HTML head. The
    // site's own well-known path is the fallback.
    let bytes = match fetch_icon(&format!("https://icons.duckduckgo.com/ip3/{host}.ico")).await {
        Some(bytes) => Some(bytes),
        None => fetch_icon(&format!("https://{host}/favicon.ico")).await,
    };

    // File IO off the window thread, tmp-then-rename so a torn write is never
    // read back as a truncated icon.
    let write_bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if std::fs::create_dir_all(&dir).is_err() {
            return;
        }
        let (path, contents) = match &write_bytes {
            Some(bytes) => (icon_path, bytes.as_slice()),
            None => (miss_path, [].as_slice()),
        };
        let temp_path = path.with_extension("tmp");
        if std::fs::write(&temp_path, contents).is_err() {
            return;
        }
        if std::fs::rename(&temp_path, &path).is_err() {
            let _ = std::fs::remove_file(&temp_path);
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(match bytes {
        Some(bytes) => tauri::ipc::Response::new(bytes),
        None => empty_response(),
    })
}

/// Keeps the icon cache bounded: once it holds more than `KEEP_ICONS` entries,
/// drops the `PRUNE_BATCH` least recently modified. Returns how many went.
#[tauri::command]
pub async fn prune_site_icons(app: AppHandle) -> Result<usize, String> {
    let dir = icons_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        if !dir.exists() {
            return Ok(0);
        }
        let mut entries: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
        for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            // Skips in-flight `.tmp` writes.
            let extension = path.extension().and_then(|value| value.to_str());
            if extension != Some("img") && extension != Some("none") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            entries.push((modified, path));
        }
        if entries.len() <= KEEP_ICONS {
            return Ok(0);
        }
        entries.sort_by(|a, b| a.0.cmp(&b.0));
        let mut removed = 0;
        for (_, path) in entries.iter().take(PRUNE_BATCH) {
            if std::fs::remove_file(path).is_ok() {
                removed += 1;
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}
