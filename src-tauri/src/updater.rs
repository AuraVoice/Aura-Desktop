use std::sync::Mutex;

use log::{error, info};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{overlay, tray};

/// Holds a downloaded-but-not-yet-installed update. Installing is gated on
/// the frontend accepting a "restart to apply" notice and on no voice call
/// being active (see `install_pending_update`), so a background download can
/// never surprise a user mid-session with an unannounced relaunch - the
/// previous behavior (`download_and_install` in one call, no notice, no
/// voice-active check) is exactly what this replaces.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<(Update, Vec<u8>)>>);

/// Checks the update feed once at startup and logs every outcome durably.
/// TODO: once a real update feed/host exists, revisit whether its manifest
/// format carries a staged/percentage rollout field the client should
/// respect before installing, since the standard Tauri updater protocol has no
/// built-in support for that, so it would need custom handling here.
pub async fn check_for_updates(app: AppHandle) {
    info!("update check: starting");

    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(e) => {
            error!("update check: updater unavailable: {e}");
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            info!(
                "update check: found {} -> {}, downloading",
                update.current_version, update.version
            );
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => {
                    info!("update check: downloaded, ready to install once accepted");
                    let version = update.version.clone();
                    if let Some(handle) = app.try_state::<PendingUpdate>() {
                        *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
                    }
                    tray::mark_update_ready(&app, &version);
                }
                Err(e) => error!("update check: download failed: {e}"),
            }
        }
        Ok(None) => info!("update check: already up to date"),
        Err(e) => error!("update check: failed: {e}"),
    }
}

/// Called when the user accepts the "restart to apply" notice. Refuses to
/// install while a voice call is active, returning `Ok(false)` rather than
/// installing, so the frontend can tell the user it'll retry after the call
/// ends instead of silently doing nothing (or worse, installing anyway).
pub fn install_pending_update(app: &AppHandle) -> Result<bool, String> {
    if overlay::is_voice_active(app) {
        info!("install_pending_update: voice call active, deferring install");
        return Ok(false);
    }
    let Some(handle) = app.try_state::<PendingUpdate>() else {
        return Err("updater state unavailable".to_string());
    };
    let pending = handle.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    match pending {
        Some((update, bytes)) => match update.install(bytes) {
            Ok(()) => {
                info!("install_pending_update: installed, relaunch to apply");
                Ok(true)
            }
            Err(e) => {
                error!("install_pending_update: install failed: {e}");
                Err(e.to_string())
            }
        },
        None => Ok(false),
    }
}
