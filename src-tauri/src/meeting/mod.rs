//! Meeting-notes capture - the Rust half of MEETING_NOTES_PLAN.md.
//!
//! Rust owns detection (detect.rs), WASAPI capture + FLAC encode (audio.rs),
//! encryption at rest (crypto.rs), and the durable segment queue (queue.rs).
//! JS owns every HTTP call (claim, segment upload, complete, polling) because
//! auth tokens never cross into Rust - see useMeetingCapture.ts for the
//! orchestrating state machine. Segment bytes cross to JS over the same
//! binary IPC pattern screenshot.rs established.
//!
//! Everything platform-specific is `#[cfg(windows)]`; on other platforms the
//! commands answer with an error string so a macOS build still compiles.

pub mod queue;

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod crypto;
#[cfg(windows)]
pub mod detect;
#[cfg(windows)]
mod session;

use std::sync::Mutex;

use log::{error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// One live capture. `stop` hands the engine thread its shutdown reason; the
/// engine owns finalizing (flush, manifest complete, state event) so every
/// stop path - user click, meeting left, 4h cap, capture failure - converges
/// on the same code.
pub struct ActiveCapture {
    pub meeting_id: String,
    pub event_id: String,
    pub started_at_ms: i64,
    pub paused: bool,
    #[cfg(windows)]
    stop: std::sync::mpsc::Sender<String>,
}

#[derive(Default)]
pub struct MeetingCaptureHandle(pub Mutex<Option<ActiveCapture>>);

/// event_id -> cancel flag for each live join-detection thread (detect.rs).
/// Defined here (not in the cfg(windows) detect module) so lib.rs can manage
/// it unconditionally.
#[derive(Default)]
pub struct JoinWatchHandle(
    pub Mutex<std::collections::HashMap<String, std::sync::Arc<std::sync::atomic::AtomicBool>>>,
);

/// The `is_voice_active` analog for meeting capture - updater.rs consults
/// this before installing so a restart can never eat a recording.
pub fn is_capture_active(app: &AppHandle) -> bool {
    app.try_state::<MeetingCaptureHandle>()
        .map(|handle| handle.0.lock().unwrap_or_else(|e| e.into_inner()).is_some())
        .unwrap_or(false)
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatePayload {
    pub active: bool,
    pub meeting_id: Option<String>,
    pub event_id: Option<String>,
    pub started_at_ms: Option<i64>,
    pub paused: bool,
    pub reason: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentReadyPayload {
    pub meeting_id: String,
    pub seq: u32,
    pub start_ms: i64,
    pub duration_ms: i64,
}

pub(crate) fn emit_capture_state(app: &AppHandle, payload: CaptureStatePayload) {
    if let Err(e) = app.emit("meeting-capture-state", payload) {
        error!("meeting: failed to emit capture state: {e}");
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Runs once at setup: drop queue entries (and their segment files) older
/// than the retention window - an unsent capture is not worth keeping forever
/// (MEETING_NOTES_PLAN.md section 6, "upload interrupted for days").
pub fn startup_maintenance(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let dropped = queue::prune_expired(&app);
        if dropped > 0 {
            warn!("meeting: pruned {dropped} expired capture(s) from the upload queue");
        }
    });
}

// ── Commands ────────────────────────────────────────────────────────────────

/// Starts capture for an already-claimed meeting. Errors when a capture is
/// already live (one meeting at a time - the claim dedups server-side, this
/// guards the same device racing itself locally).
#[tauri::command]
pub async fn start_meeting_capture(
    app: AppHandle,
    meeting_id: String,
    event_id: String,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let handle = app.state::<MeetingCaptureHandle>();
        {
            let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return Err("a meeting capture is already active".to_string());
            }
        }

        let started_at_ms = now_ms();
        let stop_tx = audio::spawn_engine(app.clone(), meeting_id.clone(), event_id.clone())
            .map_err(|e| {
                // Init failures stay silent to the user (ambient-surface
                // rule) but always reach the log + Sentry.
                error!("meeting: capture engine failed to start: {e}");
                if !cfg!(debug_assertions) {
                    sentry::capture_message(
                        &format!("meeting capture start failed: {e}"),
                        sentry::Level::Error,
                    );
                }
                e
            })?;

        {
            let mut guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            *guard = Some(ActiveCapture {
                meeting_id: meeting_id.clone(),
                event_id: event_id.clone(),
                started_at_ms,
                paused: false,
                stop: stop_tx,
            });
        }
        crate::tray::set_recording(&app, true);
        info!("meeting: capture started for {meeting_id} (event {event_id})");
        emit_capture_state(&app, CaptureStatePayload {
            active: true,
            meeting_id: Some(meeting_id),
            event_id: Some(event_id),
            started_at_ms: Some(started_at_ms),
            paused: false,
            reason: "started".to_string(),
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, meeting_id, event_id);
        Err("meeting capture is Windows-only".to_string())
    }
}

/// Asks the engine to stop; the engine flushes, completes the manifest entry,
/// clears the managed state, and emits the final capture-state event itself.
#[tauri::command]
pub async fn stop_meeting_capture(app: AppHandle, reason: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        let handle = app.state::<MeetingCaptureHandle>();
        let stop = {
            let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().map(|active| active.stop.clone())
        };
        match stop {
            Some(stop) => {
                let _ = stop.send(reason);
                Ok(())
            }
            None => Ok(()), // already stopped - a double click is not an error
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, reason);
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub active: bool,
    pub meeting_id: Option<String>,
    pub event_id: Option<String>,
    pub started_at_ms: Option<i64>,
    pub paused: bool,
}

/// Cheap sync mutex read, same idiom as `current_overlay_state` - covers the
/// race where capture state changed before the frontend mounted listeners.
#[tauri::command]
pub fn capture_status(app: AppHandle) -> CaptureStatus {
    let handle = app.state::<MeetingCaptureHandle>();
    let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(active) => CaptureStatus {
            active: true,
            meeting_id: Some(active.meeting_id.clone()),
            event_id: Some(active.event_id.clone()),
            started_at_ms: Some(active.started_at_ms),
            paused: active.paused,
        },
        None => CaptureStatus {
            active: false,
            meeting_id: None,
            event_id: None,
            started_at_ms: None,
            paused: false,
        },
    }
}

/// The upload pump's view of the durable queue: every meeting with its
/// segments and upload/completion flags. File IO (manifest read), so async.
#[tauri::command]
pub async fn queue_snapshot(app: AppHandle) -> Result<queue::Manifest, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(queue::load(&app)))
        .await
        .map_err(|e| e.to_string())?
}

/// Decrypts one segment and returns its raw FLAC bytes over binary IPC
/// (screenshot.rs precedent - no base64 round trip). The upload leg lives in
/// JS because that's where the auth token is.
#[tauri::command]
pub async fn read_segment(
    app: AppHandle,
    meeting_id: String,
    seq: u32,
) -> Result<tauri::ipc::Response, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let path = queue::segment_path(&app, &meeting_id, seq)?;
            let encrypted = std::fs::read(&path).map_err(|e| e.to_string())?;
            let key = crypto::load_or_create_key(&app)?;
            let plain = crypto::decrypt(&key, &encrypted)?;
            Ok(tauri::ipc::Response::new(plain))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (app, meeting_id, seq);
        Err("meeting capture is Windows-only".to_string())
    }
}

/// Marks one segment uploaded in the manifest (JS calls this after the
/// backend 200s the upload). The segment file itself stays until the whole
/// meeting is acked, so a failed /complete can still re-verify bytes.
#[tauri::command]
pub async fn mark_segment_uploaded(
    app: AppHandle,
    meeting_id: String,
    seq: u32,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        queue::mark_uploaded(&app, &meeting_id, seq)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The backend accepted /complete: this capture's local life is over. Deletes
/// segment files and the manifest entry. Refused while the same meeting is
/// actively capturing again (a rejoin raced the pump's completion pass) so
/// the ack can never delete the directory underneath a live engine - the
/// pump's backoff retries once the rejoined capture ends.
#[tauri::command]
pub async fn mark_meeting_acked(app: AppHandle, meeting_id: String) -> Result<(), String> {
    {
        let handle = app.state::<MeetingCaptureHandle>();
        let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if guard.as_ref().is_some_and(|active| active.meeting_id == meeting_id) {
            return Err("meeting is actively capturing; ack refused".to_string());
        }
    }
    tauri::async_runtime::spawn_blocking(move || queue::remove_meeting(&app, &meeting_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Arms Zoom/Teams join detection for one meeting's time window. Windows-only
/// under the hood; a no-op elsewhere so the command surface stays uniform.
#[tauri::command]
pub fn start_join_watch(
    app: AppHandle,
    event_id: String,
    window_start_ms: i64,
    window_end_ms: i64,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        detect::start_join_watch(app, event_id, window_start_ms, window_end_ms)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, event_id, window_start_ms, window_end_ms);
        Ok(())
    }
}

#[tauri::command]
pub fn stop_join_watch(app: AppHandle, event_id: String) {
    #[cfg(windows)]
    detect::stop_join_watch(app, event_id);
    #[cfg(not(windows))]
    let _ = (app, event_id);
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinDetectedPayload {
    event_id: String,
    app: String,
    window_title: String,
}

/// Dev-only lever: emits the same `meeting-join-detected` event the real
/// detector produces, so the whole claim -> capture -> upload -> synthesize
/// loop is drivable with no Zoom/Teams installed (see meetingDebug.ts).
#[tauri::command]
pub fn debug_force_join(app: AppHandle, event_id: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_force_join is dev-only".to_string());
    }
    app.emit("meeting-join-detected", JoinDetectedPayload {
        event_id,
        app: "debug".to_string(),
        window_title: "debug".to_string(),
    })
    .map_err(|e| e.to_string())
}

// ── Engine callbacks (windows only) ─────────────────────────────────────────

/// Called by the engine thread for every closed segment: encrypt, write,
/// record in the manifest, tell JS there's something to upload.
#[cfg(windows)]
pub(crate) fn record_segment(
    app: &AppHandle,
    meeting_id: &str,
    event_id: &str,
    started_at_ms: i64,
    seq: u32,
    start_ms: i64,
    duration_ms: i64,
    flac_bytes: &[u8],
    incomplete: bool,
) -> Result<(), String> {
    let key = crypto::load_or_create_key(app)?;
    let encrypted = crypto::encrypt(&key, flac_bytes)?;
    queue::write_segment(
        app, meeting_id, event_id, started_at_ms, seq, start_ms, duration_ms,
        &encrypted, incomplete,
    )?;
    if let Err(e) = app.emit("meeting-segment-ready", SegmentReadyPayload {
        meeting_id: meeting_id.to_string(),
        seq,
        start_ms,
        duration_ms,
    }) {
        error!("meeting: failed to emit segment-ready: {e}");
    }
    Ok(())
}

/// Engine's pause/resume notifications (session lock). Keeps the managed
/// state's `paused` mirror fresh for `capture_status`.
#[cfg(windows)]
pub(crate) fn notify_paused(app: &AppHandle, paused: bool) {
    let handle = app.state::<MeetingCaptureHandle>();
    let payload = {
        let mut guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        match guard.as_mut() {
            Some(active) => {
                active.paused = paused;
                Some(CaptureStatePayload {
                    active: true,
                    meeting_id: Some(active.meeting_id.clone()),
                    event_id: Some(active.event_id.clone()),
                    started_at_ms: Some(active.started_at_ms),
                    paused,
                    reason: if paused { "paused_lock" } else { "resumed" }.to_string(),
                })
            }
            None => None,
        }
    };
    if let Some(payload) = payload {
        emit_capture_state(app, payload);
    }
}

/// Engine finished (any reason): complete the manifest entry, clear state,
/// announce. The one funnel every stop path exits through.
#[cfg(windows)]
pub(crate) fn finalize_capture(
    app: &AppHandle,
    meeting_id: &str,
    event_id: &str,
    started_at_ms: i64,
    total_duration_ms: i64,
    reason: &str,
) {
    if let Err(e) = queue::mark_completed(
        app, meeting_id, event_id, started_at_ms, total_duration_ms, reason,
    ) {
        error!("meeting: failed to mark capture completed in manifest: {e}");
    }
    {
        let handle = app.state::<MeetingCaptureHandle>();
        let mut guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
    crate::tray::set_recording(app, false);
    info!("meeting: capture finished for {meeting_id} ({reason})");
    if reason == "capture_failed" && !cfg!(debug_assertions) {
        sentry::capture_message(
            &format!("meeting capture failed mid-session for {meeting_id}"),
            sentry::Level::Error,
        );
    }
    emit_capture_state(app, CaptureStatePayload {
        active: false,
        meeting_id: Some(meeting_id.to_string()),
        event_id: Some(event_id.to_string()),
        started_at_ms: None,
        paused: false,
        reason: reason.to_string(),
    });
}
