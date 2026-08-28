//! Encrypted-at-rest local cache for dashboard screen-save images.
//!
//! The Saved page's `image_url` is a short-lived signed GCS URL, so it is
//! stripped before it ever touches the JS disk cache and images otherwise only
//! render from a live fetch (blank when offline or once the URL expires). This
//! module pulls the bytes through Rust - the browser can render a cross-origin
//! signed URL in an <img> but cannot read its bytes (GCS sends no CORS header),
//! so a webview `fetch` is a dead end - encrypts them with the same
//! AES-256-GCM + DPAPI key the capture pipeline uses, and hands decrypted bytes
//! back over the binary IPC pattern `meeting::read_segment` established.
//!
//! Everything platform-specific is `#[cfg(windows)]` (the crypto module is
//! Windows-only); on other platforms the commands answer with an error so a
//! macOS build still compiles.

use tauri::AppHandle;

#[cfg(windows)]
use crate::meeting::crypto;
#[cfg(windows)]
use std::path::PathBuf;
#[cfg(windows)]
use tauri::Manager;

/// Per-install cache directory, a sibling of the capture stores under the
/// app-local data dir.
#[cfg(windows)]
fn images_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("saved-images"))
}

/// On-disk filename for a save. The backend `item_id` is hex-encoded so an
/// arbitrary id (which may contain `/` or other path-unsafe characters) can
/// never escape the cache directory.
#[cfg(windows)]
fn enc_filename(item_id: &str) -> String {
    use std::fmt::Write;
    let mut name = String::with_capacity(item_id.len() * 2 + 4);
    for byte in item_id.as_bytes() {
        let _ = write!(name, "{byte:02x}");
    }
    name.push_str(".enc");
    name
}

/// Downloads a save's image (once) and writes it encrypted to disk. Idempotent:
/// an existing file short-circuits before any network call, so re-opening the
/// page never re-fetches. Returns whether a local copy exists afterwards.
#[tauri::command]
pub async fn cache_saved_image(app: AppHandle, item_id: String, url: String) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let dir = images_dir(&app)?;
        let path = dir.join(enc_filename(&item_id));
        if path.exists() {
            return Ok(true);
        }

        // Network on the async runtime (off the window thread); GCS signed URLs
        // 403 once expired, which error_for_status turns into a caught error so
        // the next live fetch simply retries with a fresh URL.
        let bytes = reqwest::get(&url)
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .bytes()
            .await
            .map_err(|e| e.to_string())?;

        let blocking_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let key = crypto::load_or_create_key(&blocking_app)?;
            let encrypted = crypto::encrypt(&key, &bytes)?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            crate::fsx::write_atomic(&path, &encrypted, crate::fsx::Durability::BestEffort)?;
            Ok::<bool, String>(true)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, item_id, url);
        Err("saved-image cache is Windows-only".to_string())
    }
}

/// Decrypts one cached image and returns its raw bytes over binary IPC (JS
/// wraps them in a Blob). Errors if the item was never cached.
#[tauri::command]
pub async fn read_saved_image(app: AppHandle, item_id: String) -> Result<tauri::ipc::Response, String> {
    #[cfg(windows)]
    {
        let blocking_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let path = images_dir(&blocking_app)?.join(enc_filename(&item_id));
            let encrypted = std::fs::read(&path).map_err(|e| e.to_string())?;
            let key = crypto::load_or_create_key(&blocking_app)?;
            let plain = crypto::decrypt(&key, &encrypted)?;
            Ok(tauri::ipc::Response::new(plain))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, item_id);
        Err("saved-image cache is Windows-only".to_string())
    }
}

/// Evicts every cached image whose id is not in `keep_ids`, mirroring the cache
/// to the current saved set (so un-saved items and stale accounts fall away).
/// Returns the number of files removed.
#[tauri::command]
pub async fn prune_saved_images(app: AppHandle, keep_ids: Vec<String>) -> Result<usize, String> {
    #[cfg(windows)]
    {
        let blocking_app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let dir = images_dir(&blocking_app)?;
            if !dir.exists() {
                return Ok(0);
            }
            let keep: std::collections::HashSet<String> =
                keep_ids.iter().map(|id| enc_filename(id)).collect();
            let mut removed = 0;
            for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
                let entry = entry.map_err(|e| e.to_string())?;
                let path = entry.path();
                // Skips `.enc.tmp` in-flight writes (extension is "tmp").
                if path.extension().and_then(|value| value.to_str()) != Some("enc") {
                    continue;
                }
                let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                    continue;
                };
                if !keep.contains(name) {
                    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
                    removed += 1;
                }
            }
            Ok(removed)
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, keep_ids);
        Ok(0)
    }
}
