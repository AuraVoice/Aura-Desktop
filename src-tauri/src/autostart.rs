use log::{error, info};
use tauri::AppHandle;
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_store::StoreExt;

use crate::tray;

const SETTINGS_STORE: &str = "settings.json";
const AUTOSTART_DISABLED_KEY: &str = "autostart_disabled";

/// Whether the user explicitly turned "Start with Windows" off from the tray.
/// The store records the opt-out rather than the opt-in so the missing-key
/// default (first run, or an update from a build without this feature) means
/// enabled - a hotkey-summoned app is effectively dead after a reboot until
/// its process runs again, so launch-at-login defaults on.
fn user_opted_out(app: &AppHandle) -> bool {
    let store = match app.store(SETTINGS_STORE) {
        Ok(store) => store,
        Err(e) => {
            error!("autostart: failed to open settings store: {e}");
            sentry::capture_message(
                &format!("autostart: failed to open settings store: {e}"),
                sentry::Level::Error,
            );
            return false;
        }
    };
    store
        .get(AUTOSTART_DISABLED_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

/// Actual launch-at-login state (the registry entry on Windows), not intent -
/// this is what the tray checkbox shows, so a failed registry write can never
/// display as enabled.
pub fn is_enabled(app: &AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

/// Re-asserts the user's intent against the real launch-at-login entry on
/// every app start: enabled unless the user opted out. Re-asserting (instead
/// of a one-time first-run setup) is what turns it on for users updating from
/// a build without this feature, and repairs the entry if a cleanup tool
/// stripped it.
pub fn apply_startup_policy(app: &AppHandle) {
    apply(app, !user_opted_out(app));
}

/// Tray toggle: flips the persisted intent, applies it, and resyncs the
/// checkbox from the real resulting state.
pub fn toggle(app: &AppHandle) {
    set(app, user_opted_out(app));
}

/// Records the user's intent and applies it. Shared by the tray toggle and the
/// Settings row so both write the same single source of truth.
pub fn set(app: &AppHandle, enable: bool) {
    match app.store(SETTINGS_STORE) {
        Ok(store) => store.set(AUTOSTART_DISABLED_KEY, serde_json::json!(!enable)),
        Err(e) => {
            error!("autostart: failed to persist toggle: {e}");
            sentry::capture_message(
                &format!("autostart: failed to persist toggle: {e}"),
                sentry::Level::Error,
            );
        }
    }
    apply(app, enable);
}

fn apply(app: &AppHandle, enable: bool) {
    let autolaunch = app.autolaunch();
    // Skip the no-op case rather than calling disable() on a missing entry,
    // which the underlying auto-launch crate reports as an error.
    let current = autolaunch.is_enabled().unwrap_or(false);
    if current != enable {
        let action = if enable { "enable" } else { "disable" };
        let result = if enable {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
        match result {
            Ok(()) => info!("autostart: launch at login {action}d"),
            Err(e) => {
                // A silent failure here looks like "the app randomly stopped
                // starting with Windows" to a beta tester - report it, not
                // just log it locally.
                error!("autostart: failed to {action} launch at login: {e}");
                sentry::capture_message(
                    &format!("autostart: failed to {action} launch at login: {e}"),
                    sentry::Level::Error,
                );
            }
        }
    }
    tray::sync_autostart_item(app, is_enabled(app));
}

/// Settings row: reports the REAL launch-at-login state, same as the tray
/// checkbox, so a failed registry write can never display as enabled.
#[tauri::command]
pub fn autostart_enabled(app: AppHandle) -> bool {
    is_enabled(&app)
}

/// Settings row write. The caller re-reads `autostart_enabled` afterwards
/// rather than trusting the requested value.
#[tauri::command]
pub fn set_autostart_enabled(app: AppHandle, enabled: bool) -> bool {
    set(&app, enabled);
    is_enabled(&app)
}
