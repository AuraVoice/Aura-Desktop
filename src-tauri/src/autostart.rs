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
    // A dev build must never own the login item. `current_exe()` there is
    // target/debug/aura-desktop inside the repo, and the entry the plugin
    // writes outlives the `tauri dev` session that wrote it, so the next
    // reboot starts a stale debug binary instead of the installed app: an
    // ad-hoc code identity with none of the TCC grants, offering an update it
    // cannot install. lib.rs already keeps apply_startup_policy out of debug
    // builds, but the tray toggle and the Settings row reach `set` directly,
    // and that is the door it actually came through on 2026-09-03.
    if cfg!(debug_assertions) {
        tray::sync_autostart_item(app, is_enabled(app));
        return;
    }

    let autolaunch = app.autolaunch();
    let current = autolaunch.is_enabled().unwrap_or(false);
    // Enabling re-asserts the entry on every start, not just on a state
    // change. `is_enabled` answers "is there an entry", never "does that
    // entry still point at THIS binary": on macOS it is a bare existence
    // check on ~/Library/LaunchAgents/<name>.plist, on Windows a lookup of
    // the Run value by name. So a plist left behind by a `tauri dev` run read
    // as "already enabled", the old `if current != enable` short-circuit
    // skipped the write, and the login item stayed pointed at target/debug
    // through every reinstall and every update until a reboot finally ran it
    // (2026-09-07). Both backends overwrite their entry in place, so
    // re-asserting is idempotent and repairs a wrong path as a side effect.
    // Disabling still needs the guard: the crate reports disable() on a
    // missing entry as an error.
    if enable || current {
        let action = if enable { "enable" } else { "disable" };
        let result = if enable {
            autolaunch.enable()
        } else {
            autolaunch.disable()
        };
        match result {
            // Only a real transition is worth a line; the re-assert above
            // runs every start and would otherwise log on every launch.
            Ok(()) => {
                if current != enable {
                    info!("autostart: launch at login {action}d");
                }
            }
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
