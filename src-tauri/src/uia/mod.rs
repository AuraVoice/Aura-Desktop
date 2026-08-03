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
//! Privacy posture: capture is gated by the same `CaptureTurnScreen`
//! authorization as a screenshot, so nothing is read unless screen sight is
//! armed; password and protected values are never fetched in the first place;
//! Aura's own windows are excluded; and no extracted text is ever logged.
//!
//! Read-only. This module never invokes a UI Automation pattern that acts on
//! the user's applications.

#[cfg(windows)]
mod anchor;
pub mod contract;
#[cfg(windows)]
mod focus;
#[cfg(windows)]
mod span;
#[cfg(windows)]
mod tree;
#[cfg(windows)]
mod worker;

use log::info;
use tauri::AppHandle;

#[cfg(windows)]
pub use anchor::{AnchorId, AnchorOutcome, FieldIdentity, SpanObservation, SpanOutcome};
pub use contract::StructuredContext;
#[cfg(windows)]
pub use focus::{FocusProbe, FocusVerdict};
#[cfg(windows)]
pub use worker::UiaWorker;

/// UI Automation is a Windows API. Everywhere else the structured path reports
/// itself unavailable and the caller uses pixels - the same fallback a Windows
/// machine without working UI Automation takes.
#[cfg(not(windows))]
pub struct UiaWorker;

#[cfg(not(windows))]
impl UiaWorker {
    pub fn start() -> Self {
        Self
    }
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
///
/// `capture_anchor` asks the same round trip to also park a training-trace
/// baseline of the field about to be typed into. It is only ever true when the
/// user has switched trace capture on AND this probe precedes a real insert;
/// see `anchor.rs` for why it rides here instead of getting its own call.
#[cfg(windows)]
pub fn probe_focus(app: &AppHandle, capture_anchor: bool) -> FocusProbe {
    use tauri::Manager;

    match app.try_state::<UiaWorker>() {
        Some(worker) => worker.probe_focus(capture_anchor),
        None => FocusProbe::unknown(),
    }
}

/// Confirms where dictation's keystrokes landed, for training-trace capture.
/// Blocking and bounded; runs after the text is on screen, never before it.
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

/// Re-reads watched fields and retires finished anchors in one round trip.
/// Blocking; call it from the trace worker thread, never from the thread that
/// pumps window messages.
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
