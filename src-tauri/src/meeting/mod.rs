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
    pub owner_uid: String,
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
    pub owner_uid: String,
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
    pub owner_uid: String,
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

/// Best-effort native stop, used by security.rs when the account signs out:
/// recording consent belongs to the person, so the webview's own
/// stop_meeting_capture call must not be the only line of defense. Clones the
/// engine's stop sender under the lock, drops the lock, then sends - same
/// discipline as stop_meeting_capture.
pub fn request_stop(app: &AppHandle, reason: &str) {
    #[cfg(windows)]
    {
        let Some(handle) = app.try_state::<MeetingCaptureHandle>() else {
            return;
        };
        let stop = {
            let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().map(|active| active.stop.clone())
        };
        if let Some(stop) = stop {
            info!("meeting: native stop requested ({reason})");
            let _ = stop.send(reason.to_string());
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, reason);
    }
}

/// Cancels every native Zoom/Teams watcher. Authorization revocation calls
/// this directly so a hung webview cannot leave background window scans
/// running under the next account.
pub fn stop_all_join_watches(app: &AppHandle) {
    let Some(handle) = app.try_state::<JoinWatchHandle>() else {
        return;
    };
    cancel_all_join_watches(&handle);
}

fn cancel_all_join_watches(handle: &JoinWatchHandle) -> usize {
    let watches = {
        let mut guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        std::mem::take(&mut *guard)
    };
    let count = watches.len();
    for cancel in watches.into_values() {
        cancel.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    count
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
    let ticket = crate::security::authorize(&app, crate::security::Operation::StartMeetingCapture)?;
    let owner_uid = ticket.uid().to_string();
    queue::validate_meeting_id(&meeting_id)?;
    #[cfg(windows)]
    {
        let handle = app.state::<MeetingCaptureHandle>();
        {
            let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return Err("a meeting capture is already active".to_string());
            }
        }

        let offsets_app = app.clone();
        let offsets_meeting_id = meeting_id.clone();
        let offsets_owner_uid = owner_uid.clone();
        let (next_seq, timeline_base_ms) = tauri::async_runtime::spawn_blocking(move || {
            queue::capture_offsets(&offsets_app, &offsets_meeting_id, &offsets_owner_uid)
        })
        .await
        .map_err(|e| e.to_string())??;
        crate::security::recheck(
            &app,
            crate::security::Operation::StartMeetingCapture,
            &ticket,
        )?;
        let started_at_ms = now_ms();
        // `capture_offsets` runs off-thread. Hold the capture-state lock from
        // the post-await check through publishing ActiveCapture so two start
        // commands cannot both create engines. A very fast engine finalize
        // waits on this same lock and therefore cannot clear state before it
        // has been published.
        {
            let mut guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            if guard.is_some() {
                return Err("a meeting capture is already active".to_string());
            }
            let stop_tx = audio::spawn_engine(
                app.clone(),
                meeting_id.clone(),
                owner_uid.clone(),
                event_id.clone(),
                next_seq,
                timeline_base_ms,
            )
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
            *guard = Some(ActiveCapture {
                owner_uid: owner_uid.clone(),
                meeting_id: meeting_id.clone(),
                event_id: event_id.clone(),
                started_at_ms,
                paused: false,
                stop: stop_tx,
            });
        }
        crate::tray::set_recording(&app, true);
        info!("meeting: capture started for {meeting_id} (event {event_id})");
        emit_capture_state(
            &app,
            CaptureStatePayload {
                owner_uid,
                active: true,
                meeting_id: Some(meeting_id),
                event_id: Some(event_id),
                started_at_ms: Some(started_at_ms),
                paused: false,
                reason: "started".to_string(),
            },
        );

        // Closes the authorize -> publish race: a sign-out (or account
        // switch) landing before ActiveCapture was stored above finds
        // nothing for security::session_changed -> request_stop to stop, so
        // the fresh engine would keep recording with authorization already
        // revoked. Re-checking the ticket AFTER the handle is published
        // guarantees one of the two paths always fires - a revocation
        // before this line trips the epoch here, a revocation after it
        // finds the handle - and both funnel into the same engine stop
        // (idempotent; finalize_capture cleans up state/tray/event).
        if let Err(denied) = crate::security::recheck(
            &app,
            crate::security::Operation::StartMeetingCapture,
            &ticket,
        ) {
            request_stop(&app, "signed_out");
            return Err(denied);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, meeting_id, event_id, ticket);
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
    let current_uid = crate::security::current_uid(&app);
    let handle = app.state::<MeetingCaptureHandle>();
    let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(active) if current_uid.as_deref() == Some(active.owner_uid.as_str()) => {
            CaptureStatus {
                active: true,
                meeting_id: Some(active.meeting_id.clone()),
                event_id: Some(active.event_id.clone()),
                started_at_ms: Some(active.started_at_ms),
                paused: active.paused,
            }
        }
        _ => CaptureStatus {
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
    let ticket = crate::security::authorize(&app, crate::security::Operation::QueueSnapshot)?;
    let owner_uid = ticket.uid().to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        Ok(queue::load_for_owner(&blocking_app, &owner_uid))
    })
    .await
    .map_err(|e| e.to_string())?;
    crate::security::recheck(&app, crate::security::Operation::QueueSnapshot, &ticket)?;
    result
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
        let ticket = crate::security::authorize(&app, crate::security::Operation::ReadSegment)?;
        let owner_uid = ticket.uid().to_string();
        let blocking_app = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            // Only meetings this install itself captured (i.e. that Rust
            // wrote into its own manifest) are readable - an arbitrary id
            // can't probe the filesystem, even one that passes the charset
            // check.
            let manifest = queue::load_for_owner(&blocking_app, &owner_uid);
            let Some(entry) = manifest.meetings.get(&meeting_id) else {
                return Err("unknown meeting id".to_string());
            };
            if !entry.segments.iter().any(|segment| segment.seq == seq) {
                return Err("unknown segment".to_string());
            }
            let path = queue::segment_path(&blocking_app, &meeting_id, seq)?;
            let encrypted = std::fs::read(&path).map_err(|e| e.to_string())?;
            let key = crypto::load_or_create_key(&blocking_app)?;
            let plain = crypto::decrypt(&key, &encrypted)?;
            Ok(tauri::ipc::Response::new(plain))
        })
        .await
        .map_err(|e| e.to_string())?;
        // The account must still be the one that authorized the read - a
        // sign-out (or account switch) mid-decrypt drops the plaintext.
        crate::security::recheck(&app, crate::security::Operation::ReadSegment, &ticket)?;
        result
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
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkSegmentUploaded)?;
    let owner_uid = ticket.uid().to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::mark_uploaded(&blocking_app, &meeting_id, &owner_uid, seq)
    })
    .await
    .map_err(|e| e.to_string())?;
    crate::security::recheck(
        &app,
        crate::security::Operation::MarkSegmentUploaded,
        &ticket,
    )?;
    result
}

/// The backend accepted /complete: this capture's local life is over. Deletes
/// segment files and the manifest entry. Refused while the same meeting is
/// actively capturing again (a rejoin raced the pump's completion pass) so
/// the ack can never delete the directory underneath a live engine - the
/// pump's backoff retries once the rejoined capture ends.
#[tauri::command]
pub async fn mark_meeting_acked(app: AppHandle, meeting_id: String) -> Result<(), String> {
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkMeetingAcked)?;
    let owner_uid = ticket.uid().to_string();
    {
        let handle = app.state::<MeetingCaptureHandle>();
        let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if guard
            .as_ref()
            .is_some_and(|active| active.owner_uid == owner_uid && active.meeting_id == meeting_id)
        {
            return Err("meeting is actively capturing; ack refused".to_string());
        }
    }
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::remove_meeting(&blocking_app, &meeting_id, &owner_uid)
    })
    .await
    .map_err(|e| e.to_string())?;
    crate::security::recheck(&app, crate::security::Operation::MarkMeetingAcked, &ticket)?;
    result
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
    let ticket = crate::security::authorize(&app, crate::security::Operation::StartJoinWatch)?;
    #[cfg(windows)]
    {
        detect::start_join_watch(
            app.clone(),
            event_id.clone(),
            window_start_ms,
            window_end_ms,
        )?;
        // Close authorize -> insert against native revocation. If revocation
        // drained the map just before this watch was inserted, the stale
        // ticket catches it and cancels the newly inserted watch directly.
        if let Err(denied) =
            crate::security::recheck(&app, crate::security::Operation::StartJoinWatch, &ticket)
        {
            detect::stop_join_watch(app, event_id);
            return Err(denied);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = (app, event_id, window_start_ms, window_end_ms, ticket);
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
    owner_uid: &str,
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
        app,
        meeting_id,
        owner_uid,
        event_id,
        started_at_ms,
        seq,
        start_ms,
        duration_ms,
        &encrypted,
        incomplete,
    )?;
    if let Err(e) = app.emit(
        "meeting-segment-ready",
        SegmentReadyPayload {
            owner_uid: owner_uid.to_string(),
            meeting_id: meeting_id.to_string(),
            seq,
            start_ms,
            duration_ms,
        },
    ) {
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
                    owner_uid: active.owner_uid.clone(),
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
    owner_uid: &str,
    event_id: &str,
    started_at_ms: i64,
    total_duration_ms: i64,
    reason: &str,
) {
    if let Err(e) = queue::mark_completed(
        app,
        meeting_id,
        owner_uid,
        event_id,
        started_at_ms,
        total_duration_ms,
        reason,
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
    emit_capture_state(
        app,
        CaptureStatePayload {
            owner_uid: owner_uid.to_string(),
            active: false,
            meeting_id: Some(meeting_id.to_string()),
            event_id: Some(event_id.to_string()),
            started_at_ms: None,
            paused: false,
            reason: reason.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    use super::{cancel_all_join_watches, JoinWatchHandle};

    #[test]
    fn cancelling_all_join_watches_drains_and_signals_every_entry() {
        let first = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        let handle = JoinWatchHandle::default();
        {
            let mut watches = handle.0.lock().unwrap();
            watches.insert("event-a".to_string(), first.clone());
            watches.insert("event-b".to_string(), second.clone());
        }

        assert_eq!(cancel_all_join_watches(&handle), 2);
        assert!(first.load(Ordering::Relaxed));
        assert!(second.load(Ordering::Relaxed));
        assert!(handle.0.lock().unwrap().is_empty());
        assert_eq!(cancel_all_join_watches(&handle), 0);
    }
}
