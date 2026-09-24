//! One-time opt-in for the Background Browser Agent (entry section 9.2a).
//!
//! Same mechanism as `dictation/consent.rs`: a timestamp in a
//! `tauri-plugin-store` file, read fail-closed, revocable from Settings. The
//! value is also mirrored into `security.rs` at startup and on every change,
//! because the authorization decision (`Operation::StartBrowserTask`) is
//! made there without an AppHandle and must not read a file per call.

use log::{error, info};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const CONSENT_STORE: &str = "browser-agent-consent.json";
const ACCEPTED_AT_KEY: &str = "browser_agent_accepted_at_ms";

pub fn is_accepted(app: &AppHandle) -> bool {
    let store = match app.store(CONSENT_STORE) {
        Ok(store) => store,
        Err(e) => {
            // Fail CLOSED: an unreadable store is not permission to launch a
            // browser that acts on the web for the user.
            error!("agent_browser.consent: failed to open store: {e}");
            return false;
        }
    };
    store
        .get(ACCEPTED_AT_KEY)
        .and_then(|value| value.as_i64())
        .is_some_and(|accepted_at_ms| accepted_at_ms > 0)
}

/// Records or withdraws consent, and mirrors it into the security state.
pub fn set_accepted(app: &AppHandle, accepted: bool) -> Result<bool, String> {
    let store = app
        .store(CONSENT_STORE)
        .map_err(|e| format!("could not open the browser agent consent store: {e}"))?;
    if accepted {
        store.set(ACCEPTED_AT_KEY, serde_json::json!(crate::util::now_ms()));
    } else {
        store.delete(ACCEPTED_AT_KEY);
    }
    store
        .save()
        .map_err(|e| format!("could not save the browser agent consent store: {e}"))?;
    crate::security::set_browser_task_consent(app, accepted);
    info!(
        "agent_browser.consent: state={}",
        if accepted { "accepted" } else { "withdrawn" }
    );
    Ok(accepted)
}
