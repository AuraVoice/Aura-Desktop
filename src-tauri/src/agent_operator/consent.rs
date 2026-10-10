//! One-time opt-in for the desktop Operator (future-features.txt, "OPERATOR
//! HANDS + DYNAMIC STEPPING", section 6). A copy of agent_browser/consent.rs
//! with its own store: turning one agent on never turns on the other.
//!
//! Same mechanism as `dictation/consent.rs`: a timestamp in a
//! `tauri-plugin-store` file, read fail-closed, revocable from Settings. The
//! value is also mirrored into `security.rs` at startup and on every change,
//! because the authorization decision (`Operation::OperatorTask`) is
//! made there without an AppHandle and must not read a file per call.

use log::{error, info};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const CONSENT_STORE: &str = "desktop-agent-consent.json";
const ACCEPTED_AT_KEY: &str = "desktop_agent_accepted_at_ms";

pub fn is_accepted(app: &AppHandle) -> bool {
    let store = match app.store(CONSENT_STORE) {
        Ok(store) => store,
        Err(e) => {
            // Fail CLOSED: an unreadable store is not permission to act in the
            // user's other applications.
            error!("agent_operator.consent: failed to open store: {e}");
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
        .map_err(|e| format!("could not open the desktop agent consent store: {e}"))?;
    if accepted {
        store.set(ACCEPTED_AT_KEY, serde_json::json!(crate::util::now_ms()));
    } else {
        store.delete(ACCEPTED_AT_KEY);
    }
    store
        .save()
        .map_err(|e| format!("could not save the desktop agent consent store: {e}"))?;
    crate::security::set_operator_task_consent(app, accepted);
    info!(
        "agent_operator.consent: state={}",
        if accepted { "accepted" } else { "withdrawn" }
    );
    Ok(accepted)
}
