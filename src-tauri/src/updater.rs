use log::{error, info};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// Checks the update feed once at startup and logs every outcome durably.
/// TODO: once a real update feed/host exists, revisit whether its manifest
/// format carries a staged/percentage rollout field the client should
/// respect before installing — the standard Tauri updater protocol has no
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
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(()) => info!("update check: installed, restart to apply"),
                Err(e) => error!("update check: install failed: {e}"),
            }
        }
        Ok(None) => info!("update check: already up to date"),
        Err(e) => error!("update check: failed: {e}"),
    }
}
