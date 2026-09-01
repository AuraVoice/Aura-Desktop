//! The short-lived transcription credential, in memory and nowhere else.
//!
//! The permanent provider API key does not exist in this process, in the
//! frontend bundle, in any config file, or in the installer. It lives only in
//! the backend's secret store. What the desktop holds is a token minted per
//! device session by `POST /dictation/stt-token`, valid for minutes, scoped to
//! transcription, and thrown away on sign-out.
//!
//! Why the webview mints it and Rust merely receives it: every authenticated
//! backend call in this app goes through `authFetch` in `src/lib/api.ts`,
//! which attaches a fresh Firebase ID token. Rust has no Firebase session and
//! no way to get one. So React mints, Rust holds. React also refreshes ahead
//! of expiry, which means a chord press finds a warm token and pays no minting
//! round trip at all.
//!
//! Storage rules, all deliberate:
//! - RAM only. Never the Tauri store, never a file, never the registry. A
//!   token on disk would outlive the session that was allowed to have it.
//! - No `Serialize`, no `Debug`. It must be impossible to accidentally put
//!   this in an event payload, a log line, or a Sentry context.
//! - Expiry is checked on read, with a safety margin, so a token that would
//!   die mid-handshake is treated as already gone.


use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Refuse a token this close to its expiry. The handshake itself takes tens of
/// milliseconds, but the user may hold the chord for a while before speaking,
/// and a token that expires between the press and the connect would surface as
/// a confusing auth failure rather than a clean re-mint.
const EXPIRY_MARGIN: Duration = Duration::from_secs(10);

struct Credential {
    token: String,
    expires_at: Instant,
}

static CREDENTIAL: Mutex<Option<Credential>> = Mutex::new(None);

/// Stores a freshly minted token. `ttl` is what the provider said the token is
/// good for, not a locally chosen number.
pub fn set(token: String, ttl: Duration) {
    let mut slot = CREDENTIAL.lock().unwrap_or_else(|e| e.into_inner());
    *slot = Some(Credential {
        token,
        expires_at: Instant::now() + ttl,
    });
    // Duration only. Never the token, never its length, never a prefix.
    log::info!(
        "dictation.credential: state=stored ttl_s={}",
        ttl.as_secs()
    );
}

/// Drops the token. Called on sign-out and on an auth rejection, so the next
/// press re-mints instead of retrying a credential the provider already
/// refused.
pub fn clear() {
    let mut slot = CREDENTIAL.lock().unwrap_or_else(|e| e.into_inner());
    if slot.take().is_some() {
        log::info!("dictation.credential: state=cleared");
    }
}

/// A usable token, or `None` when there is none or it is too close to expiry.
/// Returns a copy: the session holds it only for as long as the handshake.
pub fn usable() -> Option<String> {
    let mut slot = CREDENTIAL.lock().unwrap_or_else(|e| e.into_inner());
    let expired = slot
        .as_ref()
        .is_some_and(|credential| Instant::now() + EXPIRY_MARGIN >= credential.expires_at);
    if expired {
        *slot = None;
        return None;
    }
    slot.as_ref().map(|credential| credential.token.clone())
}

/// Whether dictation currently has a credential, for `DictationStatus`. Does
/// not hand the token out.
pub fn is_present() -> bool {
    usable().is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// These tests share one process-global slot, so they run under a mutex of
    /// their own rather than relying on cargo's thread scheduling.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn guard() -> std::sync::MutexGuard<'static, ()> {
        let guard = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        clear();
        guard
    }

    #[test]
    fn a_fresh_token_is_usable() {
        let _serial = guard();
        set("token-value".to_string(), Duration::from_secs(300));
        assert_eq!(usable().as_deref(), Some("token-value"));
        assert!(is_present());
    }

    #[test]
    fn no_token_means_no_credential() {
        let _serial = guard();
        assert_eq!(usable(), None);
        assert!(!is_present());
    }

    #[test]
    fn a_token_inside_the_expiry_margin_is_refused_and_discarded() {
        let _serial = guard();
        // Shorter than EXPIRY_MARGIN, so it is already unusable on arrival.
        set("about-to-die".to_string(), Duration::from_secs(1));
        assert_eq!(usable(), None, "a token that could expire mid-handshake must be refused");
        // And it is dropped rather than left to be retried forever.
        assert!(!is_present());
    }

    #[test]
    fn clearing_removes_the_token() {
        let _serial = guard();
        set("token-value".to_string(), Duration::from_secs(300));
        clear();
        assert_eq!(usable(), None);
    }

    #[test]
    fn a_second_mint_replaces_the_first() {
        let _serial = guard();
        set("first".to_string(), Duration::from_secs(300));
        set("second".to_string(), Duration::from_secs(300));
        assert_eq!(usable().as_deref(), Some("second"));
    }
}
