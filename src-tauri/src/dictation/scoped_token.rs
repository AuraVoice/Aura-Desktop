//! A short-lived token held in memory, and nothing else.
//!
//! Dictation holds two of these: the ASR provider credential (`credential.rs`)
//! and the backend ID token the polish call uses (`polish.rs`). They were
//! written separately and were the same type twice over, down to the expiry
//! margin being declared with the same value in both files. They had already
//! drifted on the one thing that matters, mutex poison policy, which is exactly
//! the failure mode a second copy produces.
//!
//! The discipline this type enforces:
//!
//! - No `Debug`, no `Serialize`, no `Clone` on the token itself. Nothing can
//!   log or serialize it by accident.
//! - Expiry is checked on READ and clears the slot, so a stale token is dropped
//!   at the moment it is asked for rather than waiting for a sweep.
//! - The log line carries the TTL and nothing else. Never the token, never its
//!   length, never a prefix.

use std::time::{Duration, SystemTime};

/// Refuse a token this close to its expiry. The handshake itself takes tens of
/// milliseconds, but the user may hold the chord for a while before speaking,
/// and a token that expires between the press and the connect surfaces as a
/// confusing auth failure rather than a clean re-mint.
const EXPIRY_MARGIN: Duration = Duration::from_secs(10);

struct Held {
    token: String,
    /// Wall clock, not `Instant`. The issuer's expiry is wall-clock time, and
    /// `Instant` stops ticking while the machine sleeps (CLOCK_UPTIME_RAW on
    /// macOS), so a token minted before a two hour nap looked fresh here
    /// while the provider had long since let it die.
    expires_at: SystemTime,
}

pub struct ScopedToken {
    held: Option<Held>,
    /// Names this token in the log, so two holders are distinguishable without
    /// two log formats.
    label: &'static str,
}

impl ScopedToken {
    /// `const` so a holder can live in a `static Mutex` without a lazy init.
    pub const fn new(label: &'static str) -> Self {
        Self { held: None, label }
    }

    /// Stores a freshly minted token. `ttl` is what the issuer said the token
    /// is good for, never a locally chosen number.
    pub fn set(&mut self, token: String, ttl: Duration) {
        self.held = Some(Held {
            token,
            expires_at: SystemTime::now() + ttl,
        });
        log::info!("{}: state=stored ttl_s={}", self.label, ttl.as_secs());
    }

    /// Drops the token. Called on sign-out and on an auth rejection, so the
    /// next attempt re-mints instead of retrying a credential the issuer has
    /// already refused.
    pub fn clear(&mut self) {
        if self.held.take().is_some() {
            log::info!("{}: state=cleared", self.label);
        }
    }

    /// A usable token, or `None` when there is none or it is too close to
    /// expiry. Returns a copy: the caller holds it only for one request.
    pub fn usable(&mut self) -> Option<String> {
        let expired = self
            .held
            .as_ref()
            .is_some_and(|held| SystemTime::now() + EXPIRY_MARGIN >= held.expires_at);
        if expired {
            self.held = None;
            return None;
        }
        self.held.as_ref().map(|held| held.token.clone())
    }
}
