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
//! NON-GOALS - read this before trusting the module with more than it does.
//! The transitions themselves (`set_auth_state`, `set_voice_active`, arming)
//! are registered commands, callable by anything running in the webview,
//! because that's where Firebase and LiveKit live. This module therefore
//! CANNOT authenticate its own inputs and is NOT a defense against arbitrary
//! code execution inside the webview: compromised JS can walk the legitimate
//! state machine (assert a session, activate voice, arm, capture) exactly as
//! the real UI would. What it IS: a single fail-closed checkpoint for every
//! sensitive command; lifecycle invariants (sign-out, account switch, voice
//! disconnect, and restart always clear authorization, so stale or replayed
//! operations die, including mid-flight via the epoch recheck); and immunity
//! to single-message confused-deputy attacks - a hostile LiveKit data
//! message can no longer reach an OS resource unless the surrounding session
//! state genuinely exists. Every transition logs, so misuse is auditable.
//!
//! Documented upgrade path (deliberately not in this change): verify the
//! Firebase ID token natively inside `set_auth_state` (RS256 against
//! Google's securetoken certs, aud/iss/exp). That would stop a signed-out
//! compromised webview from fabricating a session and stop uid spoofing -
//! but it still cannot stop signed-in XSS, since compromised JS can obtain
//! a genuine ID token from the Firebase SDK it shares a page with.
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
    guide_armed: bool,
    guide_epoch: u64,
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
    CaptureTurnScreen,
    CaptureGuide,
    PointAt,
    DesktopControl,
    ArmScreenSight,
    StartMeetingCapture,
    QueueSnapshot,
    ReadSegment,
    MarkSegmentUploaded,
    MarkMeetingAcked,
    StartJoinWatch,
    ReadLogs,
}

/// Proof of a successful `authorize` call, carrying the auth epoch it was
/// issued under so `recheck` can reject completions that straddled a
/// sign-out or account switch.
#[derive(Clone, Debug)]
pub struct Ticket {
    auth_epoch: u64,
    uid: String,
    guide_epoch: Option<u64>,
}

impl Ticket {
    /// The authenticated account this authorization was issued to. Queue
    /// ownership checks use this value, never a UID supplied over IPC.
    pub fn uid(&self) -> &str {
        &self.uid
    }
}

/// What a session report actually changed - drives the side effects the
/// caller must run outside the state lock.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct SessionTransition {
    /// A previously signed-in session lost authorization (sign-out or a
    /// direct uid change).
    pub revoked: bool,
    /// The armed bit was cleared (caller emits screen-sight-armed).
    pub disarmed: bool,
    pub guide_disarmed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct VoiceTransition {
    pub screen_sight_disarmed: bool,
    pub guide_disarmed: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Denied {
    SignedOut,
    VoiceInactive,
    NotArmed,
    ModeConflict,
    NoCaptureThisSession,
    StaleAuth,
    StaleGuide,
}

impl fmt::Display for Denied {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let reason = match self {
            Denied::SignedOut => "denied: no signed-in session",
            Denied::VoiceInactive => "denied: no active voice session",
            Denied::NotArmed => "denied: screen sight is not armed",
            Denied::ModeConflict => "denied: another screen capture mode is active",
            Denied::NoCaptureThisSession => "denied: no screen capture in this voice session",
            Denied::StaleAuth => "denied: session changed while the operation was in flight",
            Denied::StaleGuide => "denied: Guide session changed while the operation was in flight",
        };
        f.write_str(reason)
    }
}

impl SecurityState {
    /// The one authorization decision point. Pure and AppHandle-free so the
    /// whole matrix is unit-testable.
    pub fn authorize(&self, op: Operation) -> Result<Ticket, Denied> {
        let Session::SignedIn { uid } = &self.session else {
            return Err(Denied::SignedOut);
        };
        match op {
            Operation::CaptureTurnScreen => {
                if self.guide_armed {
                    return Err(Denied::ModeConflict);
                }
                if !self.voice_active {
                    return Err(Denied::VoiceInactive);
                }
            }
            Operation::CaptureScreen => {
                if self.guide_armed {
                    return Err(Denied::ModeConflict);
                }
                if !self.voice_active {
                    return Err(Denied::VoiceInactive);
                }
                if !self.screen_sight_armed {
                    return Err(Denied::NotArmed);
                }
            }
            Operation::CaptureGuide => {
                if !self.voice_active {
                    return Err(Denied::VoiceInactive);
                }
                if !self.guide_armed {
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
            // A desktop-control message (launch app, open URL, media key) is
            // only ever legitimate as the answer to something the user just
            // spoke, so a live voice session is the whole gate - the same
            // reasoning as turn capture. The per-verb allowlist (which URL
            // schemes, which apps) lives in system_control.rs; here we only
            // decide whether ANY desktop action is currently authorized.
            Operation::DesktopControl => {
                if !self.voice_active {
                    return Err(Denied::VoiceInactive);
                }
            }
            // Arm-before-call is supported UX, so no voice requirement here.
            Operation::ArmScreenSight => {
                if self.guide_armed {
                    return Err(Denied::ModeConflict);
                }
            }
            // Signed-in is the whole gate: meeting-ID validity is anchored in
            // the Rust-written manifest (queue.rs), and restart-recovery
            // uploads of past meetings must work with no voice session.
            // ReadLogs rides the same rule - redaction (redact.rs) lowers the
            // log tail's exposure but does not make it public-safe, and the
            // only caller (the feedback button) lives in the signed-in kebab
            // menu; a signed-out invoke degrades gracefully because
            // feedback.ts already catches the error and sends the email with
            // "(no log lines available)".
            Operation::StartMeetingCapture
            | Operation::QueueSnapshot
            | Operation::ReadSegment
            | Operation::MarkSegmentUploaded
            | Operation::MarkMeetingAcked
            | Operation::StartJoinWatch
            | Operation::ReadLogs => {}
        }
        Ok(Ticket {
            auth_epoch: self.auth_epoch,
            uid: uid.clone(),
            guide_epoch: (op == Operation::CaptureGuide).then_some(self.guide_epoch),
        })
    }

    /// Post-completion check for commands whose real work runs on a blocking
    /// thread: the account must not have changed since `authorize` (epoch),
    /// and the operation must still be allowed under the current state.
    pub fn recheck(&self, op: Operation, ticket: &Ticket) -> Result<(), Denied> {
        if ticket.auth_epoch != self.auth_epoch {
            return Err(Denied::StaleAuth);
        }
        if !matches!(&self.session, Session::SignedIn { uid } if uid == &ticket.uid) {
            return Err(Denied::StaleAuth);
        }
        if op == Operation::CaptureGuide && ticket.guide_epoch != Some(self.guide_epoch) {
            return Err(Denied::StaleGuide);
        }
        self.authorize(op).map(|_| ())
    }

    /// Applies a live auth-state report. Returns what the transition did so
    /// the caller can act outside the lock (emit the armed-changed event,
    /// stop a live recording). Idempotent: repeating the current state
    /// reports no changes.
    pub fn set_session(&mut self, signed_in: bool, uid: Option<String>) -> SessionTransition {
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
            return SessionTransition {
                revoked: false,
                disarmed: false,
                guide_disarmed: false,
            };
        }
        let revoked = self.session != Session::SignedOut;
        self.session = next;
        let mut disarmed = false;
        let mut guide_disarmed = false;
        if revoked {
            // Sign-out OR a direct account switch: everything the previous
            // account authorized dies - in-flight work (epoch), voice,
            // arming, and (via the caller) any live recording. uid A -> uid B
            // must revoke exactly like A signing out, or A's meeting capture
            // would keep recording under B's session.
            self.auth_epoch += 1;
            self.voice_active = false;
            self.captured_this_voice_session = false;
            if self.screen_sight_armed {
                self.screen_sight_armed = false;
                disarmed = true;
            }
            guide_disarmed = self.disarm_guide();
        }
        SessionTransition {
            revoked,
            disarmed,
            guide_disarmed,
        }
    }

    /// Voice session lifecycle. Only a true -> false transition tears down
    /// screen-sight authorization: a redundant `false` (enterErrorState fires
    /// one even when no call ever started) must not wipe an arm-before-call.
    /// Returns whether the armed bit was cleared.
    pub fn set_voice(&mut self, active: bool) -> VoiceTransition {
        if active == self.voice_active {
            return VoiceTransition::default();
        }
        self.voice_active = active;
        if active {
            // Fresh session: captures from a previous session don't carry over.
            self.captured_this_voice_session = false;
            VoiceTransition::default()
        } else {
            self.captured_this_voice_session = false;
            if self.screen_sight_armed {
                self.screen_sight_armed = false;
                VoiceTransition {
                    screen_sight_disarmed: true,
                    guide_disarmed: self.disarm_guide(),
                }
            } else {
                VoiceTransition {
                    screen_sight_disarmed: false,
                    guide_disarmed: self.disarm_guide(),
                }
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

    pub fn arm_guide(&mut self) -> Result<(u64, bool), String> {
        if !matches!(self.session, Session::SignedIn { .. }) {
            return Err(Denied::SignedOut.to_string());
        }
        let screen_sight_cleared = std::mem::take(&mut self.screen_sight_armed);
        self.guide_epoch = self.guide_epoch.wrapping_add(1);
        self.guide_armed = true;
        Ok((self.guide_epoch, screen_sight_cleared))
    }

    pub fn disarm_guide(&mut self) -> bool {
        if !self.guide_armed {
            return false;
        }
        self.guide_armed = false;
        self.guide_epoch = self.guide_epoch.wrapping_add(1);
        true
    }

    pub fn guide_armed(&self) -> bool {
        self.guide_armed
    }

    pub fn guide_epoch(&self) -> u64 {
        self.guide_epoch
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
/// regardless of trigger (hotkey, native command, voice end, sign-out). JS
/// mirrors this instead of owning a competing boolean.
pub(crate) fn emit_screen_sight_armed(app: &AppHandle, armed: bool) {
    if let Err(e) = app.emit("screen-sight-armed", ArmedPayload { armed }) {
        log::error!("security: failed to emit screen-sight-armed: {e}");
    }
}

pub(crate) fn handle(app: &AppHandle) -> Option<tauri::State<'_, SecurityHandle>> {
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

pub fn authorize_guide(app: &AppHandle, caller_epoch: u64) -> Result<Ticket, String> {
    let ticket = authorize(app, Operation::CaptureGuide)?;
    if ticket.guide_epoch != Some(caller_epoch) {
        return Err("denied: stale Guide caller epoch".to_string());
    }
    Ok(ticket)
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

/// Current native session identity for filtering non-authorizing status
/// payloads. Sensitive operations must still use `authorize` and its ticket.
pub fn current_uid(app: &AppHandle) -> Option<String> {
    let handle = handle(app)?;
    let state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    match &state.session {
        Session::SignedIn { uid } => Some(uid.clone()),
        Session::SignedOut => None,
    }
}

/// Records a successful, authorized screen capture (enables PointAt).
pub fn note_capture(app: &AppHandle) {
    if let Some(handle) = handle(app) {
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.note_capture(crate::meeting::now_ms());
    }
}

/// Shared sign-in/out transition. Whenever a signed-in session loses
/// authorization - sign-out OR a direct uid switch - this also best-effort
/// stops a live meeting capture natively: recording consent belongs to the
/// person, so account B must never inherit a recording account A armed, and
/// the JS stop must not be the only line of defense.
pub fn session_changed(app: &AppHandle, signed_in: bool, uid: Option<String>) {
    let transition = {
        let Some(handle) = handle(app) else {
            return;
        };
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.set_session(signed_in, uid)
    };
    info!("security: session -> {}", if signed_in { "signed-in" } else { "signed-out" });
    if transition.disarmed {
        emit_screen_sight_armed(app, false);
    }
    if transition.guide_disarmed {
        crate::guide::on_security_disarmed(app);
    }
    if transition.revoked {
        crate::meeting::request_stop(app, "signed_out");
        crate::meeting::stop_all_join_watches(app);
    }
}

/// Voice lifecycle hook - called from the `set_voice_active` command and from
/// overlay's native voice-end paths (Esc / summon hotkey), so a hung webview
/// can't leave voice authorization latched.
pub fn note_voice_active(app: &AppHandle, active: bool) {
    let transition = {
        let Some(handle) = handle(app) else {
            return;
        };
        let mut state = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        state.set_voice(active)
    };
    if transition.screen_sight_disarmed {
        info!("security: voice session ended - screen sight disarmed");
        emit_screen_sight_armed(app, false);
    }
    if transition.guide_disarmed {
        crate::guide::on_security_disarmed(app);
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
            emit_screen_sight_armed(app, armed);
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

/// Frontend-callable arming path retained for non-hotkey callers. Returns the
/// new armed state; the `screen-sight-armed` event fires as well so every
/// listener converges regardless of trigger.
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
            emit_screen_sight_armed(&app, armed);
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

    const GATED_OPS: [Operation; 13] = [
        Operation::CaptureScreen,
        Operation::CaptureTurnScreen,
        Operation::CaptureGuide,
        Operation::PointAt,
        Operation::DesktopControl,
        Operation::ArmScreenSight,
        Operation::StartMeetingCapture,
        Operation::QueueSnapshot,
        Operation::ReadSegment,
        Operation::MarkSegmentUploaded,
        Operation::MarkMeetingAcked,
        Operation::StartJoinWatch,
        Operation::ReadLogs,
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
    fn desktop_control_needs_voice_but_not_armed_or_capture() {
        let s = signed_in();
        assert_eq!(
            s.authorize(Operation::DesktopControl).unwrap_err(),
            Denied::VoiceInactive
        );

        // A live voice session is the whole gate: no arming, no prior capture,
        // unlike PointAt (which answers a frame we sent).
        let s = in_voice_session();
        assert!(s.authorize(Operation::DesktopControl).is_ok());
        assert!(!s.screen_sight_armed);
        assert!(!s.captured_this_voice_session);
    }

    #[test]
    fn turn_screen_capture_needs_voice_but_not_armed() {
        let s = signed_in();
        assert_eq!(
            s.authorize(Operation::CaptureTurnScreen).unwrap_err(),
            Denied::VoiceInactive
        );

        let s = in_voice_session();
        assert!(s.authorize(Operation::CaptureTurnScreen).is_ok());
        assert!(!s.screen_sight_armed);
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
            Operation::ReadLogs,
        ] {
            assert!(s.authorize(op).is_ok(), "{op:?}");
        }
    }

    #[test]
    fn log_reads_need_a_session_and_die_with_it() {
        let s = SecurityState::default();
        assert_eq!(s.authorize(Operation::ReadLogs).unwrap_err(), Denied::SignedOut);

        let mut s = signed_in();
        let ticket = s.authorize(Operation::ReadLogs).unwrap();
        s.set_session(false, None);
        assert!(s.recheck(Operation::ReadLogs, &ticket).is_err());
    }

    #[test]
    fn voice_end_disarms_but_redundant_false_does_not() {
        let mut s = armed_in_voice_session();
        s.note_capture(1);
        assert!(s.set_voice(false).screen_sight_disarmed); // true -> false clears the armed bit
        assert_eq!(s.authorize(Operation::CaptureScreen).unwrap_err(), Denied::VoiceInactive);
        assert_eq!(s.authorize(Operation::PointAt).unwrap_err(), Denied::VoiceInactive);

        // Arm-before-call, then a stray redundant `false` (enterErrorState
        // fires one even when no call ever connected): the arm must survive.
        let mut s = signed_in();
        assert_eq!(s.toggle_armed(), Some(true));
        assert!(!s.set_voice(false).screen_sight_disarmed);
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

        // The revoked flag is what makes session_changed() stop a live
        // recording - uid A -> uid B must report it exactly like a sign-out,
        // or A's capture keeps recording under B.
        let transition = s.set_session(true, Some("uid-2".to_string()));
        assert!(transition.revoked);
        assert!(transition.disarmed);
        assert!(!s.screen_sight_armed);
        assert!(!s.voice_active);
        assert_eq!(s.recheck(Operation::ReadSegment, &ticket).unwrap_err(), Denied::StaleAuth);
    }

    #[test]
    fn transition_flags_match_each_kind_of_report() {
        // Sign-out from a signed-in session: revoked.
        let mut s = signed_in();
        assert!(s.set_session(false, None).revoked);

        // Fresh sign-in from signed-out: nothing to revoke.
        let mut s = SecurityState::default();
        let transition = s.set_session(true, Some("uid-1".to_string()));
        assert!(!transition.revoked);
        assert!(!transition.disarmed);

        // Repeated sign-out while already signed out: idempotent.
        let mut s = SecurityState::default();
        assert!(!s.set_session(false, None).revoked);

        // A signed-in report with no uid is malformed and treated as
        // sign-out - it must still revoke a real prior session.
        let mut s = signed_in();
        assert!(s.set_session(true, None).revoked);
    }

    #[test]
    fn repeated_same_session_report_changes_nothing() {
        let mut s = armed_in_voice_session();
        let ticket = s.authorize(Operation::CaptureScreen).unwrap();
        assert_eq!(ticket.uid(), "uid-1");
        let transition = s.set_session(true, Some("uid-1".to_string()));
        assert!(!transition.revoked);
        assert!(!transition.disarmed);
        assert!(s.screen_sight_armed);
        assert!(s.recheck(Operation::CaptureScreen, &ticket).is_ok());
    }

    #[test]
    fn capture_start_recheck_catches_mid_start_sign_out() {
        // The start_meeting_capture race (PR #6 finding 2): authorization is
        // revoked after authorize() but before ActiveCapture is published,
        // so request_stop finds nothing to stop. The command's post-publish
        // recheck must catch the revocation deterministically - for a
        // sign-out and for a direct account switch alike.
        let mut s = signed_in();
        let ticket = s.authorize(Operation::StartMeetingCapture).unwrap();
        s.set_session(false, None);
        assert_eq!(
            s.recheck(Operation::StartMeetingCapture, &ticket).unwrap_err(),
            Denied::StaleAuth
        );

        let mut s = signed_in();
        let ticket = s.authorize(Operation::StartMeetingCapture).unwrap();
        s.set_session(true, Some("uid-2".to_string()));
        assert_eq!(
            s.recheck(Operation::StartMeetingCapture, &ticket).unwrap_err(),
            Denied::StaleAuth
        );
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

    #[test]
    fn guide_arm_is_atomic_with_screen_sight_exclusion() {
        let mut s = armed_in_voice_session();
        let (epoch, screen_sight_cleared) = s.arm_guide().unwrap();
        assert!(screen_sight_cleared);
        assert!(s.guide_armed);
        assert!(!s.screen_sight_armed);
        assert_eq!(s.guide_epoch, epoch);
        assert_eq!(
            s.authorize(Operation::CaptureScreen).unwrap_err(),
            Denied::ModeConflict
        );
        assert_eq!(
            s.authorize(Operation::CaptureTurnScreen).unwrap_err(),
            Denied::ModeConflict
        );
        assert!(s.authorize(Operation::CaptureGuide).is_ok());
        assert_eq!(s.toggle_armed(), None);
    }

    #[test]
    fn guide_epoch_invalidates_only_guide_tickets() {
        let mut s = in_voice_session();
        s.arm_guide().unwrap();
        let guide_ticket = s.authorize(Operation::CaptureGuide).unwrap();
        let meeting_ticket = s.authorize(Operation::ReadSegment).unwrap();
        s.disarm_guide();
        s.arm_guide().unwrap();
        assert_eq!(
            s.recheck(Operation::CaptureGuide, &guide_ticket).unwrap_err(),
            Denied::StaleGuide
        );
        assert!(s.recheck(Operation::ReadSegment, &meeting_ticket).is_ok());
    }

    #[test]
    fn voice_end_and_sign_out_clear_guide() {
        let mut s = in_voice_session();
        s.arm_guide().unwrap();
        assert!(s.set_voice(false).guide_disarmed);
        assert!(!s.guide_armed);

        s.set_voice(true);
        s.arm_guide().unwrap();
        let transition = s.set_session(false, None);
        assert!(transition.guide_disarmed);
        assert!(!s.guide_armed);
    }
}
