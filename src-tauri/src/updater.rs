use std::sync::Mutex;
use std::time::Duration;

use log::{error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::{meeting, overlay, tray};

/// How often the long-running app re-checks the feed after the startup check.
/// This app autostarts and then lives for days, so a startup-only check would
/// leave most installs permanently on whatever version existed at boot.
const RECHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

/// Marker file (in app local data) written by the old version right before a
/// user-initiated install, read+deleted by the new version at next startup.
/// Needed because an update restart relaunches with the ORIGINAL args (the
/// NSIS installer's /ARGS on Windows, request_restart elsewhere), so an
/// instance that was boot-launched with --autostart would come back hidden
/// right after the user clicked "Restart now" - the marker forces the summon
/// and carries the version for the one-time "Updated to vX" caption.
const JUST_UPDATED_MARKER: &str = "just-updated";

/// Holds a downloaded-but-not-yet-installed update. Installing is gated on
/// the frontend accepting a "restart to apply" notice and on no voice call
/// being active (see `install_pending_update`), so a background download can
/// never surprise a user mid-session with an unannounced relaunch - the
/// previous behavior (`download_and_install` in one call, no notice, no
/// voice-active check) is exactly what this replaces.
#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<(Update, Vec<u8>)>>);

/// Version whose in-app banner was dismissed for this process. The downloaded
/// update remains available from the tray, and a fresh app launch offers it
/// again.
#[derive(Default)]
pub struct DismissedUpdate(pub Mutex<Option<String>>);

/// Version read from the just-updated marker at startup. Consumed (taken)
/// by the `just_updated_version` command so the confirmation caption shows
/// once per post-update launch, not again on every VoiceBar remount.
#[derive(Default)]
pub struct UpdatedNotice(pub Mutex<Option<String>>);

#[derive(Clone, Serialize)]
struct UpdateReadyPayload {
    version: String,
}

#[derive(Serialize)]
pub struct ManualUpdateCheckResult {
    status: &'static str,
    version: Option<String>,
}

/// Startup check, then periodic re-checks for the whole app lifetime.
/// TODO: once a real update feed/host exists, revisit whether its manifest
/// format carries a staged/percentage rollout field the client should
/// respect before installing, since the standard Tauri updater protocol has no
/// built-in support for that, so it would need custom handling here.
pub async fn run_update_loop(app: AppHandle) {
    // Startup must never surprise the user with an install. It may download
    // and park an update, but applying it stays behind a user click.
    check_once(&app, false).await;
    loop {
        tokio::time::sleep(RECHECK_INTERVAL).await;
        // A session may exist now - always go through the visible notice.
        check_once(&app, false).await;
    }
}

async fn check_once(app: &AppHandle, auto_install: bool) {
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
            // A 6h re-check finding the version that's already downloaded and
            // waiting must not re-download or re-announce it - the user may
            // have deliberately clicked "Later". A strictly newer version
            // replaces the pending one below.
            if let Some(handle) = app.try_state::<PendingUpdate>() {
                let pending = handle.0.lock().unwrap_or_else(|e| e.into_inner());
                if pending.as_ref().is_some_and(|(p, _)| p.version == update.version) {
                    info!("update check: v{} already pending", update.version);
                    return;
                }
            }
            info!(
                "update check: found {} -> {}, downloading",
                update.current_version, update.version
            );
            match update.download(|_, _| {}, || {}).await {
                Ok(bytes) => handle_downloaded(app, update, bytes, auto_install),
                Err(e) => error!("update check: download failed: {e}"),
            }
        }
        Ok(None) => info!("update check: already up to date"),
        Err(e) => error!("update check: failed: {e}"),
    }
}

/// Background checks park the update and announce it: tray item plus the
/// "update-ready" event the VoiceBar chip listens for. The auto-install branch
/// is retained for explicit internal callers, but startup passes false.
fn handle_downloaded(app: &AppHandle, update: Update, bytes: Vec<u8>, auto_install: bool) {
    // The voice gate still matters at startup: a fast user can summon and
    // start a call while the download is in flight. Meeting capture gates the
    // same way - a restart must never eat a recording.
    if auto_install
        && !overlay::is_voice_active(app)
        && !meeting::is_capture_active(app)
        && !crate::interview::is_active(app)
    {
        info!("update check: installing v{} at startup", update.version);
        match update.install(&bytes) {
            // On Windows this line is unreachable: install() launches the
            // NSIS installer and exits the process, and the installer's /R
            // flag relaunches the app itself. On macOS/Linux install() swaps
            // files in place and returns, so this restart is the relaunch.
            Ok(()) => {
                app.request_restart();
                return;
            }
            // macOS specifically can fail here when the bundle isn't
            // user-writable and the admin prompt is denied - fall back to
            // the visible notice instead of failing silently.
            Err(e) => error!("update check: startup install failed, falling back to notice: {e}"),
        }
    }

    let version = update.version.clone();
    if let Some(handle) = app.try_state::<PendingUpdate>() {
        *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
    }
    announce_update_ready(app, &version);
}

fn announce_update_ready(app: &AppHandle, version: &str) {
    if let Some(handle) = app.try_state::<DismissedUpdate>() {
        *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    tray::mark_update_ready(app, version);
    info!("update check: v{version} downloaded, ready once accepted");
    if let Err(e) = app.emit(crate::events::UPDATE_READY, UpdateReadyPayload { version: version.to_string() }) {
        error!("update check: failed to emit update-ready: {e}");
    }
}

/// Called when the user accepts the "restart to apply" notice (tray item or
/// the VoiceBar chip). Refuses to install while a voice call is active,
/// returning `Ok(false)` rather than installing, so the frontend can tell the
/// user to retry after the call instead of silently doing nothing (or worse,
/// installing anyway).
pub fn install_pending_update(app: &AppHandle) -> Result<bool, String> {
    if overlay::is_voice_active(app) {
        info!("install_pending_update: voice call active, deferring install");
        return Ok(false);
    }
    if meeting::is_capture_active(app) {
        info!("install_pending_update: meeting capture active, deferring install");
        return Ok(false);
    }
    if crate::interview::is_active(app) {
        info!("install_pending_update: Interview Companion active, deferring install");
        return Ok(false);
    }
    let Some(handle) = app.try_state::<PendingUpdate>() else {
        return Err("updater state unavailable".to_string());
    };
    let pending = handle.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    match pending {
        Some((update, bytes)) => {
            // Written before install because on Windows install() never
            // returns - there is no "after" in which to write it.
            write_just_updated_marker(app, &update.version);
            match update.install(&bytes) {
                Ok(()) => {
                    info!("install_pending_update: installed, relaunch to apply");
                    Ok(true)
                }
                Err(e) => {
                    remove_just_updated_marker(app);
                    error!("install_pending_update: install failed: {e}");
                    match read_only_bundle_hint(&e) {
                        // Put this one back. Re-downloading would fail in
                        // exactly the same place, and the banner asks the user
                        // to reopen Aura from the Applications folder and try
                        // again, so the update has to still be here when they
                        // do rather than waiting out the next re-check.
                        Some(hint) => {
                            *handle.0.lock().unwrap_or_else(|e| e.into_inner()) =
                                Some((update, bytes));
                            Err(hint)
                        }
                        // The taken pending update is dropped here on purpose:
                        // the next periodic re-check re-downloads it fresh.
                        None => Err(e.to_string()),
                    }
                }
            }
        }
        None => Ok(false),
    }
}

/// Marker the banner matches on. Not a sentence, because the copy that reaches
/// the user lives in `src/lib/copy.ts` with the rest of it.
const READ_ONLY_BUNDLE: &str = "bundle-read-only";

/// The updater swaps the bundle in place, so it needs the bundle to be
/// writable. It is not when the app runs from a mounted disk image or, far more
/// often, from the read-only AppTranslocation mirror macOS gives a bundle that
/// still carries com.apple.quarantine. Both arrive here as EROFS, which the
/// plugin does not treat as an install problem it can prompt about: its admin
/// privileges fallback fires only for PermissionDenied. Naming it lets the
/// banner say what to do instead of promising a retry that cannot work.
fn read_only_bundle_hint(e: &tauri_plugin_updater::Error) -> Option<String> {
    match e {
        tauri_plugin_updater::Error::Io(io) if io.raw_os_error() == Some(30) => {
            Some(READ_ONLY_BUNDLE.to_string())
        }
        _ => None,
    }
}

/// The JS-callable install path. `install()` does real file IO (and on
/// Windows spawns the installer), so it runs on a blocking thread per this
/// repo's main-thread rule. `false` means a voice call deferred the install.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<bool, String> {
    let handle = app.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || install_pending_update(&handle))
        .await
        .map_err(|e| e.to_string())??;
    if installed {
        // Only ever reached on macOS/Linux - on Windows the process is
        // already gone and the installer relaunches the app itself.
        app.request_restart();
    }
    Ok(installed)
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<ManualUpdateCheckResult, String> {
    if let Some(version) = pending_update_version(app.clone()) {
        announce_update_ready(&app, &version);
        return Ok(ManualUpdateCheckResult {
            status: "ready",
            version: Some(version),
        });
    }

    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Ok(ManualUpdateCheckResult {
            status: "up_to_date",
            version: None,
        });
    };

    let version = update.version.clone();
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    {
        let Some(handle) = app.try_state::<PendingUpdate>() else {
            return Err("updater state unavailable".to_string());
        };
        *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = Some((update, bytes));
    }
    announce_update_ready(&app, &version);
    Ok(ManualUpdateCheckResult {
        status: "ready",
        version: Some(version),
    })
}

/// Cheap sync mutex read, covering the race where the download finished
/// before the frontend mounted its "update-ready" listener - same idiom as
/// `current_overlay_state` next to `overlay-changed`.
#[tauri::command]
pub fn pending_update_version(app: AppHandle) -> Option<String> {
    let handle = app.try_state::<PendingUpdate>()?;
    let pending = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    pending.as_ref().map(|(update, _)| update.version.clone())
}

#[tauri::command]
pub fn pending_update_banner_version(app: AppHandle) -> Option<String> {
    let version = pending_update_version(app.clone())?;
    let dismissed = app.try_state::<DismissedUpdate>()?;
    let dismissed = dismissed.0.lock().unwrap_or_else(|e| e.into_inner());
    (dismissed.as_deref() != Some(version.as_str())).then_some(version)
}

#[tauri::command]
pub fn dismiss_update_banner(app: AppHandle, version: String) -> bool {
    if pending_update_version(app.clone()).as_deref() != Some(version.as_str()) {
        return false;
    }
    let Some(handle) = app.try_state::<DismissedUpdate>() else {
        return false;
    };
    *handle.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(version.clone());
    if let Err(e) = app.emit(crate::events::UPDATE_DISMISSED, UpdateReadyPayload { version }) {
        error!("updater: failed to emit update-dismissed: {e}");
    }
    true
}

/// One-shot: taking (not reading) the notice is what guarantees the caption
/// shows once per post-update launch even though VoiceBar remounts freely
/// (pill roundtrips, sign-out/in).
#[tauri::command]
pub fn just_updated_version(app: AppHandle) -> Option<String> {
    let handle = app.try_state::<UpdatedNotice>()?;
    let notice = handle.0.lock().unwrap_or_else(|e| e.into_inner()).take();
    notice
}

/// Reads and deletes the marker left by the pre-update instance. Called once
/// from setup(); returns the version that instance installed, which may not
/// match the running version if the install failed underneath the marker.
pub fn take_just_updated_marker(app: &AppHandle) -> Option<String> {
    let path = marker_path(app)?;
    let version = std::fs::read_to_string(&path).ok()?;
    if let Err(e) = std::fs::remove_file(&path) {
        warn!("updater: failed to remove just-updated marker: {e}");
    }
    let version = version.trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

fn write_just_updated_marker(app: &AppHandle, version: &str) {
    let Some(path) = marker_path(app) else { return };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            error!("updater: failed to create marker dir: {e}");
            return;
        }
    }
    if let Err(e) = std::fs::write(&path, version) {
        error!("updater: failed to write just-updated marker: {e}");
    }
}

fn remove_just_updated_marker(app: &AppHandle) {
    let Some(path) = marker_path(app) else { return };
    if let Err(e) = std::fs::remove_file(&path) {
        warn!("updater: failed to remove just-updated marker: {e}");
    }
}

fn marker_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    match app.path().app_local_data_dir() {
        Ok(dir) => Some(dir.join(JUST_UPDATED_MARKER)),
        Err(e) => {
            error!("updater: app local data dir unavailable for marker: {e}");
            None
        }
    }
}
