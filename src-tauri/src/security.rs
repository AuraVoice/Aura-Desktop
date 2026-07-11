//! Native authorization boundary for the sensitive command surface.
//!
//! React state (a Firebase listener, an "armed" boolean, a meeting claim) is
//! not a security boundary: anything running in the webview can invoke any
//! registered command. Every sensitive command therefore checks this
//! Rust-owned state first and fails closed. The state is memory-only and
//! never persisted, so a fresh process always starts fully locked
//! (signed-out, voice inactive, disarmed) until the live auth listener says
//! otherwise. The persisted `has_session` flag in auth_cache.rs is a UI
//! startup hint only and is deliberately never read here.
//!
//! Honest limits: the transitions themselves (`set_auth_state`,
//! `set_voice_active`, arming) are still driven by the webview, because
//! that's where Firebase and LiveKit live. What this module guarantees is a
//! single auditable checkpoint, lifecycle invariants (sign-out, voice
//! disconnect, and restart always clear authorization, so stale or replayed
//! operations die), and that no single hostile data-channel message can reach
//! an OS resource without the surrounding session state actually existing.
//!
//! Lock rule: the `SecurityHandle` mutex is a leaf lock. Never call
//! `window.*`, `overlay::*`, `emit`, or take any other lock while holding it;
//! every use is a short scoped lock, poison-recovered with
//! `unwrap_or_else(|e| e.into_inner())` like every other mutex in this app.
//!
//! No secret is compared across the IPC boundary here (meeting IDs are known
//! to both sides by design and segment keys never leave crypto.rs), so
//! constant-time comparison is not applicable to any check below.

use std::fmt;
use std::sync::Mutex;

use log::{info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// Who the native side currently believes is signed in. Set only from the
/// frontend's live `onAuthStateChanged` via `set_auth_state` - never from the
/// persisted auth cache.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub enum Session {
    #[default]
    SignedOut,
    SignedIn {
        uid: String,
    },
}

#[derive(Debug, Default)]
pub struct SecurityState {
    session: Session,
    voice_active: bool,
    screen_sight_armed: bool,
    /// A screen frame was actually captured (and authorized) during the
    /// current voice session - the precondition for `point_at`, since a
    /// legitimate `element.point` can only ever answer a frame we sent.
    captured_this_voice_session: bool,
    /// Diagnostics only - never part of an authorization decision.
    last_capture_at_ms: Option<i64>,
    /// Bumped on sign-out and on uid change (NOT on voice transitions - the
    /// meeting upload pump legitimately reads segments with no voice session).
    /// In-flight async work re-checks this after its blocking stage, so an
    /// operation authorized under one account can never complete under
    /// another (or under no account).
    auth_epoch: u64,
}

pub struct SecurityHandle(pub Mutex<SecurityState>);

impl Default for SecurityHandle {
    fn default() -> Self {
        Self(Mutex::new(SecurityState::default()))
    }
}

/// Every sensitive operation this module gates. Stop/status commands are
/// deliberately absent: refusing to stop a recording or read status would be
/// a liability, never a protection.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Operation {
    CaptureScreen,
    PointAt,
    ArmScreenSight,
    StartMeetingCapture,
    QueueSnapshot,
    ReadSegment,
    MarkSegmentUploaded,
    MarkMeetingAcked,
    StartJoinWatch,
}

/// Proof of a successful `authorize` call, carrying the auth epoch it was
/// issued under so `recheck` can reject completions that straddled a
/// sign-out or account switch.
#[derive(Clone, Copy, Debug)]
pub struct Ticket {
    auth_epoch: u64,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Denied {
    SignedOut,
    VoiceInactive,
    NotArmed,
    NoCaptureThisSession,
    StaleAuth,
}

impl fmt::Display for Denied {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            Denied::SignedOut => "denied: no signed-in session",
            Denied::VoiceInactive => "denied: no active voice session",
            Denied::NotArmed => "denied: screen sight is not armed",
            Denied::NoCaptureThisSession => "denied: no screen capture in this voice session",
            Denied::StaleAuth => "denied: session changed while the operation was in flight",
        };
        f.write_str(reason)
    }
}

impl SecurityState {
    fn signed_in(&self) -> bool {
        matches!(self.session, Session::SignedIn { .. })
    }

    /// The one authorization decision point. Pure and AppHandle-free so the
    /// whole matrix is unit-testable.
    pub fn authorize(&self, op: Operation) -> Result<Ticket, Denied> {
        if !self.signed_in() {
            return Err(Denied::SignedOut);
        }
        match op {
            Operation::CaptureScreen => {
                if !self.voice_active {
                    return Err(Denied::VoiceInactive);
                }
                if !self.screen_sight_armed {
                    return Err(Denied::NotArmed);
                }
            }
            // Still-armed is deliberately NOT required: the user may disarm
            // right after asking and the agent's point reply is still theirs.
            Operation::PointAt => {
                if !self.voice_active {
                    return Err(Denied::VoiceInactive);
                }
                if !self.captured_this_voice_session {
                    return Err(Denied::NoCaptureThisSession);
                }
            }
            // Arm-before-call is supported UX, so no voice requirement here.
            Operation::ArmScreenSight => {}
            // Signed-in is the whole gate: meeting-ID validity is anchored in
            // the Rust-written manifest (queue.rs), and restart-recovery
            // uploads of past meetings must work with no voice session.
            Operation::StartMeetingCapture
            | Operation::QueueSnapshot
            | Operation::ReadSegment
            | Operation::MarkSegmentUploaded
            | Operation::MarkMeetingAcked
            | Operation::StartJoinWatch => {}
        }
        Ok(Ticket {
            auth_epoch: self.auth_epoch,
        })
    }

    /// Post-completion check for commands whose real work runs on a blocking
    /// thread: the account must not have changed since `authorize` (epoch),
    /// and the operation must still be allowed under the current state.
    pub fn recheck(&self, op: Operation, ticket: &Ticket) -> Result<(), Denied> {
        if ticket.auth_epoch != self.auth_epoch {
            return Err(Denied::StaleAuth);
        }
        self.authorize(op).map(|_| ())
    }

    /// Applies a live auth-state report. Returns whether the armed bit was
    /// cleared, so the caller can emit the armed-changed event outside the
    /// lock. Idempotent: repeating the current state changes nothing.
    pub fn set_session(&mut self, signed_in: bool, uid: Option<String>) -> bool {
        let next = if signed_in {
            match uid {
                Some(uid) if !uid.is_empty() => Session::SignedIn { uid },
                // A signed-in report with no uid is malformed - fail closed.
                _ => Session::SignedOut,
            }
        } else {
            Session::SignedOut
        };
        if next == self.session {
            return false;
        }
        let lost_authorization = self.session != Session::SignedOut;
        self.session = next;
        if lost_authorization {
            // Sign-out or a direct account switch: everything the previous
            // account authorized dies, including in-flight work (epoch).
            self.auth_epoch += 1;
            self.voice_active = false;
            self.captured_this_voice_session = false;
            if self.screen_sight_armed {
                self.screen_sight_armed = false;
                return true;
            }
        }
        false
    }

    /// Voice session lifecycle. Only a true -> false transition tears down
    /// screen-sight authorization: a redundant `false` (enterErrorState fires
    /// one even when no call ever started) must not wipe an arm-before-call.
    /// Returns whether the armed bit was cleared.
    pub fn set_voice(&mut self, active: bool) -> bool {
        if active == self.voice_active {
            return false;
        }
        self.voice_active = active;
        if active {
            // Fresh session: captures from a previous session don't carry over.
            self.captured_this_voice_session = false;
            false
        } else {
            self.captured_this_voice_session = false;
            if self.screen_sight_armed {
                self.screen_sight_armed = false;
                true
            } else {
                false
            }
        }
    }

    /// Flips the armed bit. `None` means refused (signed out).
    pub fn toggle_armed(&mut self) -> Option<bool> {
        if self.authorize(Operation::ArmScreenSight).is_err() {
            return None;
        }
        self.screen_sight_armed = !self.screen_sight_armed;
        Some(self.screen_sight_armed)
    }

    pub fn note_capture(&mut self, at_ms: i64) {
        self.captured_this_voice_session = true;
        self.last_capture_at_ms = Some(at_ms);
    }
}

#[derive(Clone, Copy, Serialize)]
struct ArmedPayload {
    armed: bool,
}

/// The single Rust -> React signal for the armed bit, fired on every change
/// regardless of trigger (hotkey, eye button, voice end, sign-out). JS
/// mirrors this instead of owning a competing boolean.
fn emit_armed_changed(app: &AppHandle, armed: bool) {
    if let Err(e) = app.emit("screen-sight-armed", ArmedPayload { armed }) {
        log::error!("security: failed to emit screen-sight-armed: {e}");
    }
}

fn handle(app: &AppHandle) -> Option<tauri::State<'_, SecurityHandle>> {
    app.try_state::<SecurityHandle>()
}

/// Convenience for command sites: scoped lock, authorize, map to the app's
/// stringly error convention.
pub fn authorize(app: &AppHandle, op: Operation) -> Result<Ticket, String> {
    let Some(handle) = handle(app) else {
        return Err("security state unavailable".to_string());
    };
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    state.authorize(op).map_err(|d| {
        warn!("security: {op:?} refused - {d}");
        d.to_string()
    })
}

pub fn recheck(app: &AppHandle, op: Operation, ticket: &Ticket) -> Result<(), String> {
    let Some(handle) = handle(app) else {
        return Err("security state unavailable".to_string());
    };
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    state.recheck(op, ticket).map_err(|d| {
        warn!("security: {op:?} result dropped - {d}");
        d.to_string()
    })
}

/// Records a successful, authorized screen capture (enables PointAt).
pub fn note_capture(app: &AppHandle) {
    if let Some(handle) = handle(app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.note_capture(crate::meeting::now_ms());
    }
}

/// Shared sign-in/out transition. On a transition away from a signed-in
/// account this also best-effort stops a live meeting capture natively -
/// recording consent belongs to the person, and the JS stop must not be the
/// only line of defense.
pub fn session_changed(app: &AppHandle, signed_in: bool, uid: Option<String>) {
    let (was_signed_in, armed_cleared) = {
        let Some(handle) = handle(app) else {
            return;
        };
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        let was = state.signed_in();
        let cleared = state.set_session(signed_in, uid);
        (was, cleared)
    };
    info!("security: session -> {}", if signed_in { "signed-in" } else { "signed-out" });
    if armed_cleared {
        emit_armed_changed(app, false);
    }
    if was_signed_in && !signed_in {
        crate::meeting::request_stop(app, "signed_out");
    }
}

/// Voice lifecycle hook - called from the `set_voice_active` command and from
/// overlay's native voice-end paths (Esc / summon hotkey), so a hung webview
/// can't leave voice authorization latched.
pub fn note_voice_active(app: &AppHandle, active: bool) {
    let armed_cleared = {
        let Some(handle) = handle(app) else {
            return;
        };
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.set_voice(active)
    };
    if armed_cleared {
        info!("security: voice session ended - screen sight disarmed");
        emit_armed_changed(app, false);
    }
}

/// Ctrl+Alt+S: toggle armed natively and tell JS. Silently a no-op while
/// signed out (no armed UI even renders then).
pub fn toggle_screen_sight(app: &AppHandle) {
    let toggled = {
        let Some(handle) = handle(app) else {
            return;
        };
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.toggle_armed()
    };
    match toggled {
        Some(armed) => {
            info!("security: screen sight {} (hotkey)", if armed { "armed" } else { "disarmed" });
            emit_armed_changed(app, armed);
        }
        None => info!("security: screen-sight hotkey ignored - not signed in"),
    }
}

/// Ctrl+Shift+D: revoke native authorization immediately, without waiting for
/// the webview's sign-out round trip (which may stall or never come).
pub fn clear_for_sign_out(app: &AppHandle) {
    session_changed(app, false, None);
}

// ── Commands ────────────────────────────────────────────────────────────────

/// The frontend's live `onAuthStateChanged` mirror. AuthProvider awaits this
/// before exposing the user to React, so no signed-in-gated effect can run
/// ahead of the native state.
#[tauri::command]
pub fn set_auth_state(app: AppHandle, signed_in: bool, uid: Option<String>) {
    session_changed(&app, signed_in, uid);
}

/// The VoiceBar eye button's arming path (the hotkey path never leaves Rust).
/// Returns the new armed state; the `screen-sight-armed` event fires as well
/// so every listener converges regardless of trigger.
#[tauri::command]
pub fn toggle_screen_sight_armed(app: AppHandle) -> Result<bool, String> {
    let toggled = {
        let Some(handle) = handle(&app) else {
            return Err("security state unavailable".to_string());
        };
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.toggle_armed()
    };
    match toggled {
        Some(armed) => {
            info!("security: screen sight {} (button)", if armed { "armed" } else { "disarmed" });
            emit_armed_changed(&app, armed);
            Ok(armed)
        }
        None => Err(Denied::SignedOut.to_string()),
    }
}

/// Mount-time mirror seed for the frontend (covers a webview reload while
/// Rust's armed bit is still set - same race `current_overlay_state` covers
/// for presentation).
#[tauri::command]
pub fn screen_sight_armed(app: AppHandle) -> bool {
    handle(&app)
        .map(|h| h.0.lock().unwrap_or_else(|e| e.into_inner()).screen_sight_armed)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_in() -> SecurityState {
        let mut s = SecurityState::default();
        s.set_session(true, Some("uid-1".to_string()));
        s
    }

    fn in_voice_session() -> SecurityState {
        let mut s = signed_in();
        s.set_voice(true);
        s
    }

    fn armed_in_voice_session() -> SecurityState {
        let mut s = in_voice_session();
        assert_eq!(s.toggle_armed(), Some(true));
        s
    }

    const GATED_OPS: [Operation; 9] = [
        Operation::CaptureScreen,
        Operation::PointAt,
        Operation::ArmScreenSight,
        Operation::StartMeetingCapture,
        Operation::QueueSnapshot,
        Operation::ReadSegment,
        Operation::MarkSegmentUploaded,
        Operation::MarkMeetingAcked,
        Operation::StartJoinWatch,
    ];

    #[test]
    fn fresh_state_denies_everything() {
        let s = SecurityState::default();
        for op in GATED_OPS {
            assert_eq!(s.authorize(op).unwrap_err(), Denied::SignedOut, "{op:?}");
        }
    }

    #[test]
    fn signed_in_report_without_uid_fails_closed() {
        let mut s = SecurityState::default();
        s.set_session(true, None);
        assert_eq!(s.authorize(Operation::ReadSegment).unwrap_err(), Denied::SignedOut);
        s.set_session(true, Some(String::new()));
        assert_eq!(s.authorize(Operation::ReadSegment).unwrap_err(), Denied::SignedOut);
    }

    #[test]
    fn capture_needs_voice_and_armed() {
        let s = signed_in();
        assert_eq!(s.authorize(Operation::CaptureScreen).unwrap_err(), Denied::VoiceInactive);

        let mut s = signed_in();
        assert_eq!(s.toggle_armed(), Some(true)); // arm-before-call is legal...
        assert_eq!(s.authorize(Operation::CaptureScreen).unwrap_err(), Denied::VoiceInactive);

        let s = in_voice_session();
        assert_eq!(s.authorize(Operation::CaptureScreen).unwrap_err(), Denied::NotArmed);

        let s = armed_in_voice_session();
        assert!(s.authorize(Operation::CaptureScreen).is_ok());
    }

    #[test]
    fn arming_works_without_voice_but_never_signed_out() {
        let mut s = signed_in();
        assert!(s.authorize(Operation::ArmScreenSight).is_ok());
        assert_eq!(s.toggle_armed(), Some(true));

        let mut s = SecurityState::default();
        assert_eq!(s.toggle_armed(), None);
    }

    #[test]
    fn point_at_needs_a_capture_this_voice_session() {
        let s = armed_in_voice_session();
        assert_eq!(
            s.authorize(Operation::PointAt).unwrap_err(),
            Denied::NoCaptureThisSession
        );

        let mut s = armed_in_voice_session();
        s.note_capture(1);
        assert!(s.authorize(Operation::PointAt).is_ok());

        // Disarming after the capture must NOT revoke the point (the user may
        // disarm right after asking; the agent's reply is still theirs).
        assert_eq!(s.toggle_armed(), Some(false));
        assert!(s.authorize(Operation::PointAt).is_ok());

        // But the capture flag never survives into the next voice session.
        s.set_voice(false);
        s.set_voice(true);
        assert_eq!(
            s.authorize(Operation::PointAt).unwrap_err(),
            Denied::NoCaptureThisSession
        );
    }

    #[test]
    fn meeting_ops_need_only_a_session_not_voice() {
        let s = signed_in();
        for op in [
            Operation::StartMeetingCapture,
            Operation::QueueSnapshot,
            Operation::ReadSegment,
            Operation::MarkSegmentUploaded,
            Operation::MarkMeetingAcked,
            Operation::StartJoinWatch,
        ] {
            assert!(s.authorize(op).is_ok(), "{op:?}");
        }
    }

    #[test]
    fn voice_end_disarms_but_redundant_false_does_not() {
        let mut s = armed_in_voice_session();
        s.note_capture(1);
        assert!(s.set_voice(false)); // true -> false clears the armed bit
        assert_eq!(s.authorize(Operation::CaptureScreen).unwrap_err(), Denied::VoiceInactive);
        assert_eq!(s.authorize(Operation::PointAt).unwrap_err(), Denied::VoiceInactive);

        // Arm-before-call, then a stray redundant `false` (enterErrorState
        // fires one even when no call ever connected): the arm must survive.
        let mut s = signed_in();
        assert_eq!(s.toggle_armed(), Some(true));
        assert!(!s.set_voice(false));
        assert!(s.screen_sight_armed);
    }

    #[test]
    fn sign_out_clears_everything_and_bumps_epoch() {
        let mut s = armed_in_voice_session();
        s.note_capture(1);
        let ticket = s.authorize(Operation::ReadSegment).unwrap();

        s.set_session(false, None);
        for op in GATED_OPS {
            assert_eq!(s.authorize(op).unwrap_err(), Denied::SignedOut, "{op:?}");
        }
        // The epoch check runs first, so an old ticket reads as stale (the
        // more precise denial) - either way the plaintext is dropped.
        assert_eq!(s.recheck(Operation::ReadSegment, &ticket).unwrap_err(), Denied::StaleAuth);

        // Even after someone else signs in, the old ticket stays dead.
        s.set_session(true, Some("uid-2".to_string()));
        assert_eq!(s.recheck(Operation::ReadSegment, &ticket).unwrap_err(), Denied::StaleAuth);
    }

    #[test]
    fn direct_account_switch_revokes_like_a_sign_out() {
        let mut s = armed_in_voice_session();
        let ticket = s.authorize(Operation::ReadSegment).unwrap();

        s.set_session(true, Some("uid-2".to_string()));
        assert!(!s.screen_sight_armed);
        assert!(!s.voice_active);
        assert_eq!(s.recheck(Operation::ReadSegment, &ticket).unwrap_err(), Denied::StaleAuth);
    }

    #[test]
    fn repeated_same_session_report_changes_nothing() {
        let mut s = armed_in_voice_session();
        let ticket = s.authorize(Operation::CaptureScreen).unwrap();
        assert!(!s.set_session(true, Some("uid-1".to_string())));
        assert!(s.screen_sight_armed);
        assert!(s.recheck(Operation::CaptureScreen, &ticket).is_ok());
    }

    #[test]
    fn recheck_catches_disarm_after_authorize() {
        let mut s = armed_in_voice_session();
        let ticket = s.authorize(Operation::CaptureScreen).unwrap();
        assert_eq!(s.toggle_armed(), Some(false));
        assert_eq!(
            s.recheck(Operation::CaptureScreen, &ticket).unwrap_err(),
            Denied::NotArmed
        );
    }

    #[test]
    fn voice_end_does_not_invalidate_meeting_tickets() {
        // The upload pump decrypts queued segments with no voice session at
        // all (restart recovery); a call ending mid-decrypt must not deny it.
        let mut s = armed_in_voice_session();
        let ticket = s.authorize(Operation::ReadSegment).unwrap();
        s.set_voice(false);
        assert!(s.recheck(Operation::ReadSegment, &ticket).is_ok());
    }
}
