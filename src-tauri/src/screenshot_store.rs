//! Encrypted local retention for screen captures.
//!
//! Every JPEG is encrypted before it reaches disk. Files live under the
//! app-local data directory for 180 days and are pruned on startup, daily,
//! and before each new write.

#![cfg(windows)]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use log::{info, warn};
use tauri::{AppHandle, Manager};

const CAPTURES_DIR: &str = "screen-captures";
const RETENTION_DAYS: u64 = 180;
const RETENTION_MS: u64 = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub fn save_capture(app: &AppHandle, kind: &str, jpeg: &[u8]) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(CAPTURES_DIR);
    let key = crate::meeting::crypto::load_or_create_key(app)?;
    save_capture_in(&base_dir, &key, kind, jpeg, now_ms())
}

pub fn startup_maintenance(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let maintenance_app = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let base_dir = maintenance_app
                    .path()
                    .app_local_data_dir()
                    .map_err(|e| e.to_string())?
                    .join(CAPTURES_DIR);
                prune_expired_in(&base_dir, now_ms())
            })
            .await;
            match result {
                Ok(Ok(removed)) if removed > 0 => {
                    info!("screenshot store: pruned {removed} expired capture(s)")
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => warn!("screenshot store: maintenance failed: {e}"),
                Err(e) => warn!("screenshot store: maintenance worker failed: {e}"),
            }
            tokio::time::sleep(MAINTENANCE_INTERVAL).await;
        }
    });
}

fn save_capture_in(
    base_dir: &Path,
    key: &[u8; 32],
    kind: &str,
    jpeg: &[u8],
    captured_at_ms: u64,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
    prune_expired_in(base_dir, captured_at_ms)?;

    let encrypted = crate::meeting::crypto::encrypt(key, jpeg)?;
    let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let filename = format!(
        "{captured_at_ms}-{}-{sequence}-{kind}.jpg.enc",
        std::process::id()
    );
    let final_path = base_dir.join(filename);
    let temp_path = final_path.with_extension("enc.tmp");
    std::fs::write(&temp_path, encrypted).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&temp_path, &final_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(e.to_string());
    }
    Ok(final_path)
}

fn prune_expired_in(base_dir: &Path, now_ms: u64) -> Result<usize, String> {
    if !base_dir.exists() {
        return Ok(0);
    }
    let entries = std::fs::read_dir(base_dir).map_err(|e| e.to_string())?;
    let cutoff = now_ms.saturating_sub(RETENTION_MS);
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("enc") {
            continue;
        }
        let Some(captured_at_ms) = path
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|value| value.split('-').next())
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        if captured_at_ms < cutoff {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "aura-screen-store-{}-{}-{name}",
            std::process::id(),
            now_ms()
        ))
    }

    #[test]
    fn saves_encrypted_jpeg_and_prunes_only_expired_captures() {
        let base = test_dir("retention");
        let key = [7u8; 32];
        let old_ms = 1_000;
        let now = old_ms + RETENTION_MS + 1;
        let old = save_capture_in(&base, &key, "turn", b"old-jpeg", old_ms).unwrap();
        let current = save_capture_in(&base, &key, "turn", b"current-jpeg", now).unwrap();

        assert!(!old.exists());
        assert!(current.exists());
        let on_disk = std::fs::read(&current).unwrap();
        assert!(!on_disk
            .windows(b"current-jpeg".len())
            .any(|w| w == b"current-jpeg"));
        assert_eq!(
            crate::meeting::crypto::decrypt(&key, &on_disk).unwrap(),
            b"current-jpeg"
        );

        std::fs::remove_dir_all(base).unwrap();
    }
}
