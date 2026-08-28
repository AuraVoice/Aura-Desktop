//! Every event name Rust emits across the IPC boundary, in one place.
//!
//! The TS side mirrors these strings in `src/lib/ipcEvents.ts`; keep the two
//! files in lockstep. The names are wire contract: both sides compile happily
//! with a one-character drift, and the listener just silently never fires.
//! JS-originated events (emitted by the frontend for itself) also live in the
//! TS file only.

// overlay.rs
pub const OVERLAY_CHANGED: &str = "overlay-changed";
pub const CHAT_REQUESTED: &str = "chat-requested";
pub const CHAT_TOGGLE_REQUESTED: &str = "chat-toggle-requested";
pub const OUTPUT_MUTE_TOGGLE_REQUESTED: &str = "output-mute-toggle-requested";
pub const END_VOICE_SESSION: &str = "end-voice-session";
pub const SIGN_OUT_REQUESTED: &str = "sign-out-requested";
pub const POINTING_TARGET: &str = "pointing-target";

// guide/mod.rs, security.rs, screenshot.rs
pub const GUIDE_ARMED: &str = "guide-armed";
pub const SCREEN_SIGHT_ARMED: &str = "screen-sight-armed";
pub const CAPTURE_STAGES: &str = "capture-stages";

// hotkeys.rs, voice_toggle_key.rs
pub const HOTKEY_BINDINGS_CHANGED: &str = "hotkey-bindings-changed";
pub const HOTKEY_TEST_PRESSED: &str = "hotkey-test-pressed";
pub const VOICE_TOGGLE_KEY_CHANGED: &str = "voice-toggle-key-changed";
pub const AURA_TOGGLE: &str = "aura-toggle";

// dictation
pub const DICTATION_UPDATE: &str = "dictation-update";
pub const DICTATION_LEVEL: &str = "dictation-level";
pub const DICTATION_STATUS_CHANGED: &str = "dictation-status-changed";

// meeting
pub const MEETING_CAPTURE_STATE: &str = "meeting-capture-state";
pub const MEETING_JOIN_DETECTED: &str = "meeting-join-detected";
pub const MEETING_SEGMENT_READY: &str = "meeting-segment-ready";
pub const MEETING_LEFT: &str = "meeting-left";

// interview.rs
pub const INTERVIEW_HACKER_STATUS: &str = "interview-hacker-status";
pub const INTERVIEW_HACKER_TRANSCRIPT: &str = "interview-hacker-transcript";
pub const INTERVIEW_BRIEF_UPDATED: &str = "interview-brief-updated";
pub const INTERVIEW_RESUME_UPDATED: &str = "interview-resume-updated";

// tray.rs
pub const OPEN_NOTIFICATIONS_REQUESTED: &str = "open-notifications-requested";
pub const CAPTURE_NOW_REQUESTED: &str = "capture-now-requested";
pub const OPEN_INTERVIEW_HACKER_REQUESTED: &str = "open-interview-hacker-requested";

// updater.rs, toast.rs, connector_oauth.rs, dashboard.rs, status_pill.rs
pub const UPDATE_READY: &str = "update-ready";
pub const UPDATE_DISMISSED: &str = "update-dismissed";
pub const NOTIFICATION_TOAST_ACTIVATED: &str = "notification-toast-activated";
pub const CONNECTOR_OAUTH_COMPLETE: &str = "connector-oauth-complete";
pub const DASHBOARD_NAVIGATE: &str = "dashboard-navigate";
pub const STATUS_PILL_UPDATE: &str = "status-pill-update";
