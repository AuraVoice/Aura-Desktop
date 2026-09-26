// Every event name that crosses the Rust/TS boundary, in one place.
//
// The Rust side mirrors these strings in src-tauri/src/events.rs; keep the
// two files in lockstep. The names are wire contract: both sides compile
// happily with a one-character drift, and the listener just silently never
// fires. The JS-originated block at the end has no Rust twin.

// overlay.rs
export const OVERLAY_CHANGED = "overlay-changed";
export const CHAT_REQUESTED = "chat-requested";
export const CHAT_TOGGLE_REQUESTED = "chat-toggle-requested";
export const OUTPUT_MUTE_TOGGLE_REQUESTED = "output-mute-toggle-requested";
export const END_VOICE_SESSION = "end-voice-session";
export const SIGN_OUT_REQUESTED = "sign-out-requested";
/** Settings > System asked for the welcome tour again: the seen flag for this
 * uid is already cleared, every window re-enters the tail. */
export const DESKTOP_ONBOARDING_REPLAY = "desktop-onboarding-replay";
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
// Final transcript for a hold aimed at the chat composer. Payload is the text.
export const DICTATION_COMPOSER_INSERT = "dictation-composer-insert";
export const DICTATION_HOLD_COMPLETED = "dictation-hold-completed";
// The chord found no usable transcription credential; mint one now.
export const DICTATION_CREDENTIAL_NEEDED = "dictation-credential-needed";

// meeting
export const MEETING_CAPTURE_STATE = "meeting-capture-state";
export const MEETING_JOIN_DETECTED = "meeting-join-detected";
export const MEETING_SEGMENT_READY = "meeting-segment-ready";
export const MEETING_LEFT = "meeting-left";
// The ambient scanner saw a call window appear / disappear (detect.rs).
export const MEETING_CALL_SEEN = "meeting-call-seen";
export const MEETING_CALL_GONE = "meeting-call-gone";
/** The tracked call changed identity without ending (detect.rs `same_call`). */
export const MEETING_CALL_REKEYED = "meeting-call-rekeyed";

// interview.rs
export const INTERVIEW_HACKER_STATUS = "interview-hacker-status";
export const INTERVIEW_HACKER_TRANSCRIPT = "interview-hacker-transcript";
/** Ctrl+Alt+S while an interview is live. See events.rs. */
export const INTERVIEW_SCREEN_SIGHT_REQUESTED = "interview-screen-sight-requested";
export const INTERVIEW_BRIEF_UPDATED = "interview-brief-updated";
export const INTERVIEW_RESUME_UPDATED = "interview-resume-updated";

// tray.rs
export const OPEN_NOTIFICATIONS_REQUESTED = "open-notifications-requested";
export const CAPTURE_NOW_REQUESTED = "capture-now-requested";
export const OPEN_INTERVIEW_HACKER_REQUESTED = "open-interview-hacker-requested";

// updater.rs, toast.rs, connector_oauth.rs, dashboard.rs, status_pill.rs
export const UPDATE_READY = "update-ready";
export const UPDATE_DISMISSED = "update-dismissed";
export const UPDATE_CHECK_RESULT = "update-check-result";
export const NOTIFICATION_TOAST_ACTIVATED = "notification-toast-activated";
export const CONNECTOR_OAUTH_COMPLETE = "connector-oauth-complete";
export const DASHBOARD_NAVIGATE = "dashboard-navigate";
export const STATUS_PILL_UPDATE = "status-pill-update";

// region/mod.rs
export const REGION_SELECTION_STARTED = "region-selection-started";
export const REGION_SELECTION_POINTS = "region-selection-points";
export const REGION_FREEZE_READY = "region-freeze-ready";
export const REGION_SELECTION_LOCKED = "region-selection-locked";
export const REGION_CAPTURE_READY = "region-capture-ready";
export const REGION_CANCELLED = "region-cancelled";

// agent_browser/mod.rs
export const BROWSER_TASK_STATUS = "browser-task-status";
export const BROWSER_TASK_APPROVAL = "browser-task-approval";

// JS-originated (no Rust twin)
export const START_VOICE_REQUESTED = "start-voice-requested";
export const DESKTOP_ONBOARDING_COMPLETED = "desktop-onboarding-completed";
export const DESKTOP_NOTIFICATION_LOCAL = "desktop-notification-local";
export const TELEMETRY_CONSENT_CHANGED = "telemetry-consent-changed";

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

// Mirrors meeting/mod.rs AmbientCallPayload. Consumed by useMeetingPrompt (the
// card) and useMeetingCapture (stopping a capture when its call goes away).
// callKey is app + a hash of the normalized title, never the title itself, so
// it is safe to remember; windowTitle is for the card only.
export interface AmbientCallPayload {
  callKey: string;
  app: string;
  windowTitle: string;
  source: string;
  /** PNG data URL of a native call app's real icon; null for browser calls. */
  appIcon: string | null;
}

// Mirrors meeting/mod.rs AmbientGonePayload.
export interface AmbientGonePayload {
  callKey: string;
  app: string;
}

// Mirrors meeting/mod.rs AmbientRekeyPayload. The call React knows as
// previousKey is the same conversation as `call`; a capture started for it
// keeps running and a decision made for it carries over.
export interface AmbientRekeyPayload {
  previousKey: string;
  call: AmbientCallPayload;
}

// Mirrors dictation/hud.rs HudUpdate (rename_all = "camelCase"). Consumed by
// the dictation HUD window and, when ownTarget is true, by the chat composer's
// listening chip: the emit broadcasts to every window.
export interface DictationUpdatePayload {
  phase:
    | "idle"
    | "listening"
    | "transcribing"
    | "inserted"
    | "error"
    | "recovery"
    | "pending"
    | "consent";
  text: string;
  message?: string;
  chordLabel: string;
  edge: "top" | "bottom" | "left" | "right";
  ownTarget: boolean;
}

// Mirrors region/mod.rs SelectionStarted (rename_all = "camelCase"). The rect
// is in the platform's own space: physical pixels on Windows, points on macOS.
// The overlay uses it verbatim as its SVG viewBox, which is what keeps stroke
// plotting free of any devicePixelRatio maths on either platform.
export interface RegionSelectionStartedPayload {
  generation: number;
  displayX: number;
  displayY: number;
  displayWidth: number;
  displayHeight: number;
}

// Mirrors region/mod.rs SelectionPoints (rename_all = "camelCase"). Flat
// [x, y, x, y, ...] in the same space as the rect above, batched at ~20 Hz.
export interface RegionSelectionPointsPayload {
  generation: number;
  points: number[];
}

// Mirrors region/mod.rs FreezeReady (rename_all = "camelCase"). The still is
// collected with take_region_freeze, for the same reason the crop below is.
export interface RegionFreezeReadyPayload {
  generation: number;
  widthPx: number;
  heightPx: number;
}

// Mirrors region/mod.rs SelectionLocked (rename_all = "camelCase"). The crop
// is in the same space as RegionSelectionStartedPayload's display rect.
export interface RegionSelectionLockedPayload {
  generation: number;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  wholeDisplay: boolean;
}

// Mirrors region/mod.rs CaptureReady (rename_all = "camelCase"). The JPEG is
// deliberately absent: it is collected with the take_region_capture command,
// because a 200 KB frame on an event becomes roughly 700 KB of JSON.
export interface RegionCaptureReadyPayload {
  generation: number;
  widthPx: number;
  heightPx: number;
  wholeDisplay: boolean;
}

// Mirrors region/mod.rs Cancelled (rename_all = "camelCase").
export interface RegionCancelledPayload {
  generation: number;
  reason: string;
}

// Mirrors agent_browser/mod.rs BrowserTaskStatusPayload (rename_all =
// "camelCase"). Emitted on every phase change and step; the terminal emit
// (done / partial / failed / stopped) also carries the answer and sources.
export type BrowserTaskPhase =
  | "idle"
  | "starting"
  | "launching"
  | "running"
  | "awaiting_approval"
  | "done"
  | "partial"
  | "failed"
  | "stopped";

export interface BrowserTaskStatusPayload {
  phase: BrowserTaskPhase;
  taskId: string | null;
  epoch: number | null;
  origin: string | null;
  brief: string | null;
  steps: number;
  url: string | null;
  reason: string | null;
  answer: string | null;
  sources: string[];
  partial: boolean;
}

// Mirrors agent_browser/mod.rs ApprovalPayload.
export interface BrowserTaskApprovalPayload {
  taskId: string;
  epoch: number;
  description: string;
  url: string;
}
