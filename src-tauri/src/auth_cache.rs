use log::error;
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
            error!("has_cached_session: failed to open store: {e}");
            return false;
        }
    };
    store
        .get(HAS_SESSION_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

pub fn set_cached_session(app: &AppHandle, has_session: bool) {
    match app.store(AUTH_STATE_STORE) {
        Ok(store) => store.set(HAS_SESSION_KEY, serde_json::json!(has_session)),
        Err(e) => error!("set_cached_session: failed to open store: {e}"),
    }
}
