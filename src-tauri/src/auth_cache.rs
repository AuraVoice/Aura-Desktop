use log::{error, warn};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const AUTH_STATE_STORE: &str = "auth-state.json";
const HAS_SESSION_KEY: &str = "has_session";

/// Mirrors the frontend's Firebase auth state so Rust can decide, without
/// waiting on the webview to mount, whether a hotkey press or cold start
/// should open avatar mode or route straight to the pairing screen.
pub fn has_cached_session(app: &AppHandle) -> bool {
    let store = match app.store(AUTH_STATE_STORE) {
        Ok(store) => store,
        Err(e) => {
            // A transient disk/permissions error here silently shows a signed-in
            // user the pairing screen at cold start - report it, not just log it
            // locally, since a beta tester won't know to send their log file for
            // a failure that looks like "I got signed out for no reason."
            error!("has_cached_session: failed to open store: {e}");
            sentry::capture_message(
                &format!("has_cached_session: failed to open store: {e}"),
                sentry::Level::Error,
            );
            return false;
        }
    };
    match store.get(HAS_SESSION_KEY) {
        None => false, // expected on first run - no session cached yet
        Some(value) => value.as_bool().unwrap_or_else(|| {
            warn!("has_cached_session: {HAS_SESSION_KEY} present but not a bool: {value:?}");
            false
        }),
    }
}

pub fn set_cached_session(app: &AppHandle, has_session: bool) {
    match app.store(AUTH_STATE_STORE) {
        Ok(store) => store.set(HAS_SESSION_KEY, serde_json::json!(has_session)),
        Err(e) => {
            error!("set_cached_session: failed to open store: {e}");
            sentry::capture_message(
                &format!("set_cached_session: failed to open store: {e}"),
                sentry::Level::Error,
            );
        }
    }
}
