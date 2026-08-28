// Every event name that crosses the Rust/TS boundary, in one place.
//
// The Rust side mirrors these strings in src-tauri/src/events.rs; keep the
// two files in lockstep. The names are wire contract: both sides compile
// happily with a one-character drift, and the listener just silently never
// fires. The last three names are JS-originated (no Rust twin).

// overlay.rs
export const OVERLAY_CHANGED = "overlay-changed";
export const CHAT_REQUESTED = "chat-requested";
export const CHAT_TOGGLE_REQUESTED = "chat-toggle-requested";
export const OUTPUT_MUTE_TOGGLE_REQUESTED = "output-mute-toggle-requested";
export const END_VOICE_SESSION = "end-voice-session";
export const SIGN_OUT_REQUESTED = "sign-out-requested";
export const POINTING_TARGET = "pointing-target";

// guide/mod.rs, security.rs, screenshot.rs
export const GUIDE_ARMED = "guide-armed";
export const SCREEN_SIGHT_ARMED = "screen-sight-armed";
export const CAPTURE_STAGES = "capture-stages";

// hotkeys.rs, voice_toggle_key.rs
export const HOTKEY_BINDINGS_CHANGED = "hotkey-bindings-changed";
export const HOTKEY_TEST_PRESSED = "hotkey-test-pressed";
export const VOICE_TOGGLE_KEY_CHANGED = "voice-toggle-key-changed";
export const AURA_TOGGLE = "aura-toggle";

// dictation
export const DICTATION_UPDATE = "dictation-update";
export const DICTATION_LEVEL = "dictation-level";
export const DICTATION_STATUS_CHANGED = "dictation-status-changed";

// meeting
export const MEETING_CAPTURE_STATE = "meeting-capture-state";
export const MEETING_JOIN_DETECTED = "meeting-join-detected";
export const MEETING_SEGMENT_READY = "meeting-segment-ready";
export const MEETING_LEFT = "meeting-left";

// interview.rs
export const INTERVIEW_HACKER_STATUS = "interview-hacker-status";
export const INTERVIEW_HACKER_TRANSCRIPT = "interview-hacker-transcript";
export const INTERVIEW_BRIEF_UPDATED = "interview-brief-updated";
export const INTERVIEW_RESUME_UPDATED = "interview-resume-updated";

// tray.rs
export const OPEN_NOTIFICATIONS_REQUESTED = "open-notifications-requested";
export const CAPTURE_NOW_REQUESTED = "capture-now-requested";
export const OPEN_INTERVIEW_HACKER_REQUESTED = "open-interview-hacker-requested";

// updater.rs, toast.rs, connector_oauth.rs, dashboard.rs, status_pill.rs
export const UPDATE_READY = "update-ready";
export const UPDATE_DISMISSED = "update-dismissed";
export const NOTIFICATION_TOAST_ACTIVATED = "notification-toast-activated";
export const CONNECTOR_OAUTH_COMPLETE = "connector-oauth-complete";
export const DASHBOARD_NAVIGATE = "dashboard-navigate";
export const STATUS_PILL_UPDATE = "status-pill-update";

// JS-originated (no Rust twin)
export const START_VOICE_REQUESTED = "start-voice-requested";
export const DESKTOP_ONBOARDING_COMPLETED = "desktop-onboarding-completed";
export const DESKTOP_NOTIFICATION_LOCAL = "desktop-notification-local";

// Shared payload types for events consumed in more than one place, so every
// listener agrees with the Rust struct rather than re-typing the shape.

// Mirrors guide/mod.rs GuideArmedPayload (rename_all = "camelCase", so the
// wire never carries snake_case field names).
export interface GuideArmedPayload {
  armed: boolean;
  epoch: number;
  sessionId: string | null;
}

// Mirrors security.rs ArmedPayload.
export interface ScreenSightArmedPayload {
  armed: boolean;
}
