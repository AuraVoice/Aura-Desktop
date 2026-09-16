//! Structured screen context from Windows UI Automation.
//!
//! For an accessible surface - a mail compose window, a settings pane, a form -
//! the accessibility tree already says what the user is looking at, in text,
//! precisely. Sending that instead of a screenshot is cheaper on every axis at
//! once: no capture, no resize, no JPEG encode, no megabyte upload, no vision
//! tokens, and a payload the model can read without inference cost.
//!
//! It is not a replacement for pixels. A canvas, a video, a game or a remote
//! desktop has no accessible content at all, and some applications simply
//! implement accessibility badly. So `contract::StructuredContext::finish_quality`
//! makes a deterministic judgement - no model call, no transcript keywords -
//! and when it is anything other than confident, the caller falls back to the
//! resized screenshot. The failure direction is deliberate: unsure means
//! pixels, so screen awareness degrades to exactly the previous behaviour
//! rather than quietly getting worse.
//!
//! Privacy posture. Three things read field CONTENT here, and each has its own
//! gate:
//!
//! * The context walk (`tree.rs`) is gated by the same `CaptureTurnScreen`
//!   authorization as a screenshot, so nothing is read unless screen sight is
//!   armed.
//! * The dictation hold-context read (`anchor.rs::hold_context`) reads the
//!   focused field's role, owning app and up to 200 characters before the
//!   caret when the chord goes down, so the formatter can match the
//!   destination. That text reaches `/dictation/polish` (no-store) and, only
//!   under sharing consent v3, the local sealed history row.
//! * The dictation read-back (`anchor.rs`) re-reads a field Aura typed into,
//!   only while sharing consent is on, and only what the user turned Aura's
//!   words into crosses back out of this thread.
//!
//! Password and protected values are never fetched in the first place; Aura's
//! own windows are excluded; and no extracted text is ever logged.
//!
//! Read-only. This module never invokes a UI Automation pattern that acts on
//! the user's applications.

#[cfg(windows)]
mod anchor;
pub mod contract;
#[cfg(windows)]
mod focus;
#[cfg(target_os = "macos")]
mod focus_ax;
/// The probe's answer type, shared: dictation's insert path takes a verdict
/// whichever platform produced it.
mod focus_verdict;
#[cfg(windows)]
mod span;
#[cfg(windows)]
mod tree;
#[cfg(windows)]
mod worker;

use log::info;
use tauri::AppHandle;

#[cfg(windows)]
pub use anchor::{AnchorId, AnchorOutcome, FieldIdentity, HoldContext, SpanObservation, SpanOutcome};
pub use contract::StructuredContext;
pub use focus_verdict::{FocusProbe, FocusVerdict};
#[cfg(windows)]
pub use worker::UiaWorker;

/// UI Automation is a Windows API. Everywhere else the structured path reports
/// itself unavailable and the caller uses pixels - the same fallback a Windows
/// machine without working UI Automation takes. Note this is only about the
/// CONTEXT walk: the focus probe below has a real macOS implementation, because
/// dictation cannot type safely without one.
#[cfg(not(windows))]
pub struct UiaWorker;

#[cfg(not(windows))]
impl UiaWorker {
    pub fn start() -> Self {
        Self
    }
}

// The read-back vocabulary off Windows. The types exist so the observer and
// the dictation worker compile everywhere; every call answers "nothing was
// observed", which the labels record honestly as `inserted_only`. The macOS
// AX implementation is a later phase of architectures/dictation-model-plan.md.
#[cfg(not(windows))]
pub type AnchorId = u64;

#[cfg(not(windows))]
#[derive(Clone, Debug, Default)]
pub struct HoldContext {
    pub role: Option<String>,
    pub app: Option<String>,
    pub prefix: Option<String>,
    pub baseline_parked: bool,
}

#[cfg(not(windows))]
#[derive(Clone, Debug, Default)]
pub struct FieldIdentity {
    pub field_id: String,
    pub app: String,
    pub role: String,
}

#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub struct AnchorOutcome {
    pub anchor_id: Option<AnchorId>,
    pub identity: FieldIdentity,
    pub refusal: Option<&'static str>,
}

#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub enum SpanOutcome {
    Located { text: String, exact: bool },
    Removed,
    Lost,
}

#[cfg(not(windows))]
#[derive(Clone, Debug)]
pub struct SpanObservation {
    pub trace_id: String,
    pub outcome: SpanOutcome,
}

/// Asks whether the focused control can accept typed text, for dictation's
/// insert path. Blocking and bounded; call it from a worker thread, never from
/// the thread that pumps window messages.
///
/// Deliberately NOT behind `security::authorize`. `capture_structured_context`
/// below requires a signed-in session because it reads screen CONTENT;
/// dictation has to work signed out, offline, on first launch, and this reads
/// no content at all - a control type for a window the user is already looking
/// at. Gating it would break exactly the case dictation exists for.
#[cfg(windows)]
pub fn probe_focus(app: &AppHandle) -> FocusProbe {
    use tauri::Manager;

    match app.try_state::<UiaWorker>() {
        Some(worker) => worker.probe_focus(),
        None => FocusProbe::unknown(),
    }
}

/// macOS reads the same question off the Accessibility tree. No worker thread
/// and no app state: AX calls are not apartment-bound the way `IUIAutomation`
/// is, and `macos_ax` bounds each read with a messaging timeout instead, which
/// is the failure mode that actually exists here (a hung target application,
/// not a busy apartment).
#[cfg(target_os = "macos")]
pub fn probe_focus(_app: &AppHandle) -> FocusProbe {
    focus_ax::probe()
}

/// The focused field's role, app and caret prefix when a dictation hold
/// starts, plus a parked baseline when `park` is set. Blocking and bounded;
/// call it from the dictation worker thread.
#[cfg(windows)]
pub fn hold_context(app: &AppHandle, park: bool, prefix_chars: usize) -> HoldContext {
    use tauri::Manager;

    match app.try_state::<UiaWorker>() {
        Some(worker) => worker.hold_context(park, prefix_chars),
        None => HoldContext::default(),
    }
}

#[cfg(not(windows))]
pub fn hold_context(_app: &AppHandle, _park: bool, _prefix_chars: usize) -> HoldContext {
    HoldContext::default()
}

/// Confirms where a freshly typed string landed and starts watching the field.
/// Blocking; call it from the observer thread, never from the thread that
/// pumps window messages.
#[cfg(windows)]
pub fn anchor_insert(app: &AppHandle, trace_id: &str, inserted: &str) -> AnchorOutcome {
    use tauri::Manager;

    match app.try_state::<UiaWorker>() {
        Some(worker) => worker.anchor_insert(trace_id, inserted),
        None => AnchorOutcome {
            anchor_id: None,
            identity: FieldIdentity::default(),
            refusal: Some("uia_unavailable"),
        },
    }
}

#[cfg(not(windows))]
pub fn anchor_insert(_app: &AppHandle, _trace_id: &str, _inserted: &str) -> AnchorOutcome {
    AnchorOutcome {
        anchor_id: None,
        identity: FieldIdentity::default(),
        refusal: Some("uia_unavailable"),
    }
}

/// Re-reads watched fields and retires finished anchors in one round trip.
/// Blocking; call it from the observer thread.
#[cfg(windows)]
pub fn anchor_observe(
    app: &AppHandle,
    read: Vec<AnchorId>,
    retire: Vec<AnchorId>,
) -> Vec<SpanObservation> {
    use tauri::Manager;

    match app.try_state::<UiaWorker>() {
        Some(worker) => worker.anchor_observe(read, retire),
        None => Vec::new(),
    }
}

#[cfg(not(windows))]
pub fn anchor_observe(
    _app: &AppHandle,
    _read: Vec<AnchorId>,
    _retire: Vec<AnchorId>,
) -> Vec<SpanObservation> {
    Vec::new()
}

/// Reads the focused element (pointer element as fallback) and its bounded
/// neighbourhood for one voice turn.
#[tauri::command]
pub async fn capture_structured_context(
    app: AppHandle,
    turn_context_id: String,
) -> Result<StructuredContext, String> {
    // Same gate as the pixel path: a signed-in session, a live call, and screen
    // sight armed. Structured context IS screen content.
    let ticket = crate::security::authorize(&app, crate::security::Operation::CaptureTurnScreen)?;

    let context = gather(&app, turn_context_id).await?;

    // A disarm that landed mid-walk drops the snapshot, exactly as it drops a
    // screenshot captured across the same boundary.
    crate::security::recheck(&app, crate::security::Operation::CaptureTurnScreen, &ticket)?;

    // Shape and timing only. Never a name, a value or a window title.
    info!(
        "[Context] {{ui_automation_ms:{}, sufficient:{}, reason:{:?}, text_nodes:{}, \
         ancestors:{}, siblings:{}, descendants:{}, bounds_hit:{:?}}}",
        context.capture_ms,
        context.quality.sufficient,
        context.quality.reason,
        context.quality.text_nodes,
        context.ancestors.len(),
        context.siblings.len(),
        context.descendants.len(),
        context.bounds_hit,
    );
    Ok(context)
}

/// Dispatched onto a blocking thread because the worker handshake waits on a
/// channel: doing that inline would park the thread that pumps the overlay's
/// window messages, which is what "(Not Responding)" looks like.
#[cfg(windows)]
async fn gather(app: &AppHandle, turn_context_id: String) -> Result<StructuredContext, String> {
    use tauri::Manager;

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let cursor = window.cursor_position().map_err(|e| e.to_string())?;
    let cursor_x = cursor.x as i32;
    let cursor_y = cursor.y as i32;
    let guide_armed = crate::guide::is_armed(app);

    let worker_app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(worker) = worker_app.try_state::<UiaWorker>() else {
            return StructuredContext::unavailable(
                turn_context_id,
                contract::QualityReason::UiaUnavailable,
                0,
            );
        };
        worker.capture(turn_context_id, cursor_x, cursor_y, guide_armed)
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
async fn gather(_app: &AppHandle, turn_context_id: String) -> Result<StructuredContext, String> {
    Ok(StructuredContext::unavailable(
        turn_context_id,
        contract::QualityReason::UiaUnavailable,
        0,
    ))
}
