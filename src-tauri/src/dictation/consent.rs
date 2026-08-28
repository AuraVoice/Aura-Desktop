//! One-time consent for online dictation.
//!
//! Dictation used to transcribe on-device, so audio never left the machine and
//! there was nothing to consent to. It now streams the microphone to a
//! transcription provider, which is a materially different privacy posture, so
//! it is gated: NOT ONE BYTE of audio is captured or sent until the user has
//! accepted, and the check happens before the microphone is even opened.
//!
//! Persisted through `tauri-plugin-store`, the same mechanism `auth_cache.rs`
//! uses, because the answer has to survive a restart. Only a timestamp is
//! stored - accepting is a fact, not a payload.
//!
//! Revocable from Settings > Dictation. Revoking takes effect on the next
//! chord press; there is nothing to tear down because a hold owns its socket.

#![cfg(windows)]

use log::{error, info};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

const CONSENT_STORE: &str = "dictation-consent.json";
/// Unix milliseconds of the accept. Stored rather than a bare bool so a future
/// disclosure change can re-ask by comparing against its own publish date.
const ACCEPTED_AT_KEY: &str = "online_dictation_accepted_at_ms";

pub fn is_accepted(app: &AppHandle) -> bool {
    let store = match app.store(CONSENT_STORE) {
        Ok(store) => store,
        Err(e) => {
            // Fail CLOSED. A store that cannot be read is not permission to
            // start streaming a microphone to a third party; the user simply
            // sees the consent pill again.
            error!("dictation.consent: failed to open store: {e}");
            return false;
        }
    };
    store
        .get(ACCEPTED_AT_KEY)
        .and_then(|value| value.as_i64())
        .is_some_and(|accepted_at_ms| accepted_at_ms > 0)
}

/// Records or withdraws consent. Returns the resulting state.
pub fn set_accepted(app: &AppHandle, accepted: bool) -> Result<bool, String> {
    let store = app
        .store(CONSENT_STORE)
        .map_err(|e| format!("could not open the dictation consent store: {e}"))?;
    if accepted {
        store.set(ACCEPTED_AT_KEY, serde_json::json!(crate::util::now_ms()));
    } else {
        store.delete(ACCEPTED_AT_KEY);
    }
    store
        .save()
        .map_err(|e| format!("could not save the dictation consent store: {e}"))?;
    info!("dictation.consent: state={}", if accepted { "accepted" } else { "withdrawn" });
    Ok(accepted)
}
