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

mod evidence_store;
pub mod queue;
mod runtime_lease;

pub use runtime_lease::MeetingRuntimeLease;

#[cfg(windows)]
mod audio;
#[cfg(windows)]
pub(crate) mod crypto;
#[cfg(windows)]
pub mod detect;
#[cfg(windows)]
mod session;

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use log::{error, info, warn};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

const RETENTION_MAINTENANCE_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// One live capture. `stop` hands the engine thread its shutdown reason; the
/// engine owns finalizing (flush, manifest complete, state event) so every
/// stop path - user click, meeting left, 4h cap, capture failure - converges
/// on the same code.
pub struct ActiveCapture {
    pub owner_uid: String,
    pub meeting_id: String,
    pub capture_run_id: String,
    pub capture_fence: i64,
    pub event_id: String,
    pub started_at_ms: i64,
    pub paused: bool,
    #[cfg(windows)]
    stop: std::sync::mpsc::Sender<String>,
    #[cfg(windows)]
    finalization: FinalizationSignal,
}

#[cfg(windows)]
#[derive(Default)]
struct FinalizationState {
    result: Mutex<Option<Result<(), String>>>,
    condition: Condvar,
}

#[cfg(windows)]
#[derive(Clone, Default)]
pub(crate) struct FinalizationSignal(Arc<FinalizationState>);

#[cfg(windows)]
impl FinalizationSignal {
    fn finish(&self, result: Result<(), String>) {
        let mut state = self.0.result.lock().unwrap_or_else(|error| error.into_inner());
        if state.is_none() {
            *state = Some(result);
        }
        self.0.condition.notify_all();
    }

    fn wait(&self, timeout: Duration) -> Result<(), String> {
        let state = self.0.result.lock().unwrap_or_else(|error| error.into_inner());
        let (state, timeout_result) = self
            .0
            .condition
            .wait_timeout_while(state, timeout, |value| value.is_none())
            .map_err(|_| "meeting finalization wait failed".to_string())?;
        if timeout_result.timed_out() && state.is_none() {
            return Err("meeting finalization timed out".to_string());
        }
        state
            .clone()
            .unwrap_or_else(|| Err("meeting finalization did not report a result".to_string()))
    }
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
    pub capture_run_id: Option<String>,
    pub capture_fence: Option<i64>,
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
    pub capture_run_id: String,
    pub capture_fence: i64,
    pub seq: u32,
    pub start_ms: i64,
    pub duration_ms: i64,
}

pub(crate) fn emit_capture_state(app: &AppHandle, payload: CaptureStatePayload) {
    if let Err(e) = app.emit(crate::events::MEETING_CAPTURE_STATE, payload) {
        error!("meeting: failed to emit capture state: {e}");
    }
}

pub use crate::util::now_ms;

fn require_runtime_owner(app: &AppHandle) -> Result<(), String> {
    if app.state::<MeetingRuntimeLease>().owns_runtime() {
        Ok(())
    } else {
        Err("meeting runtime is owned by another Aura process".to_string())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingRuntimeStatus {
    pub owns_runtime: bool,
    pub process_id: u32,
    pub runtime_instance_id: String,
    pub installation_id: String,
}

#[tauri::command]
pub async fn meeting_runtime_status(app: AppHandle) -> Result<MeetingRuntimeStatus, String> {
    let lease = app.state::<MeetingRuntimeLease>();
    let owns_runtime = lease.owns_runtime();
    let runtime_instance_id = lease.runtime_instance_id().to_string();
    let blocking_app = app.clone();
    let installation_id =
        tauri::async_runtime::spawn_blocking(move || queue::installation_id(&blocking_app))
            .await
            .map_err(|error| error.to_string())??;
    Ok(MeetingRuntimeStatus {
        owns_runtime,
        process_id: std::process::id(),
        runtime_instance_id,
        installation_id,
    })
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
    if require_runtime_owner(app).is_err() {
        info!(
            "meeting.runtime: process {} is passive; capture maintenance disabled",
            std::process::id()
        );
        return;
    }
    let app = app.clone();
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    tauri::async_runtime::spawn(async move {
        let mut first_run = true;
        loop {
            let maintenance_app = app.clone();
            let maintenance_runtime = runtime_instance_id.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                queue::initialize(&maintenance_app)?;
                let reconciliation = if first_run {
                    queue::record_runtime_lease(&maintenance_app, &maintenance_runtime, true)?;
                    // Before rebuilding orphaned files, release runs a dead
                    // process left marked as still capturing - otherwise they
                    // stay undeletable and keep reporting a live recording.
                    let interrupted = queue::interrupt_orphaned_captures(
                        &maintenance_app,
                        &maintenance_runtime,
                    )?;
                    if interrupted > 0 {
                        warn!(
                            "meeting.store: released {interrupted} capture(s) stranded by a previous run"
                        );
                    }
                    Some(queue::reconcile(&maintenance_app)?)
                } else {
                    None
                };
                let removed = queue::prune_expired(&maintenance_app, &maintenance_runtime)?;
                Ok::<_, String>((reconciliation, removed))
            })
            .await;
            match result {
                Ok(Ok((reconciliation, removed))) => {
                    if let Some(report) = reconciliation {
                        info!(
                            "meeting.store: reconciliation recovered={} missing={} integrity_failed={} quarantined={} split_brain={}",
                            report.recovered_orphans,
                            report.missing_files,
                            report.integrity_failures,
                            report.quarantined_files,
                            report.split_brain_conflicts,
                        );
                    }
                    if removed > 0 {
                        warn!("meeting: pruned {removed} expired capture(s) from local retention");
                    }
                }
                Ok(Err(error)) => {
                    error!("meeting.store: maintenance failed: {error}");
                    sentry::capture_message(
                        &format!("meeting evidence maintenance failed: {error}"),
                        sentry::Level::Error,
                    );
                }
                Err(error) => {
                    error!("meeting.store: maintenance worker failed: {error}");
                }
            }
            first_run = false;
            tokio::time::sleep(RETENTION_MAINTENANCE_INTERVAL).await;
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
    capture_run_id: String,
    capture_fence: i64,
    event_id: String,
) -> Result<(), String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::StartMeetingCapture)?;
    let owner_uid = ticket.uid().to_string();
    queue::validate_meeting_id(&meeting_id)?;
    queue::validate_capture_run_id(&capture_run_id)?;
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
        let runtime_instance_id = app
            .state::<MeetingRuntimeLease>()
            .runtime_instance_id()
            .to_string();
        let installation_id = queue::installation_id(&app)?;
        let offsets_app = app.clone();
        let begin = queue::BeginCapture {
            meeting_id: meeting_id.clone(),
            capture_run_id: capture_run_id.clone(),
            capture_fence,
            protocol_version: evidence_store::PROTOCOL_VERSION,
            owner_uid: owner_uid.clone(),
            event_id: event_id.clone(),
            started_at_ms,
            runtime_instance_id: runtime_instance_id.clone(),
            installation_id: installation_id.clone(),
        };
        let (next_seq, timeline_base_ms) = tauri::async_runtime::spawn_blocking(move || {
            queue::begin_capture(&offsets_app, &begin)
        })
        .await
        .map_err(|e| e.to_string())??;
        crate::security::recheck(
            &app,
            crate::security::Operation::StartMeetingCapture,
            &ticket,
        )?;
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
            let finalization = FinalizationSignal::default();
            let stop_tx = audio::spawn_engine(
                app.clone(),
                queue::CaptureRunRef {
                    owner_uid: owner_uid.clone(),
                    meeting_id: meeting_id.clone(),
                    capture_run_id: capture_run_id.clone(),
                    capture_fence,
                    event_id: event_id.clone(),
                    runtime_instance_id: runtime_instance_id.clone(),
                    installation_id,
                },
                next_seq,
                timeline_base_ms,
                finalization.clone(),
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
                capture_run_id: capture_run_id.clone(),
                capture_fence,
                event_id: event_id.clone(),
                started_at_ms,
                paused: false,
                stop: stop_tx,
                finalization,
            });
        }
        crate::tray::set_recording(&app, true);
        info!(
            "meeting: capture started meeting={meeting_id} run={capture_run_id} fence={capture_fence} event={event_id} runtime={runtime_instance_id}"
        );
        emit_capture_state(
            &app,
            CaptureStatePayload {
                owner_uid,
                active: true,
                meeting_id: Some(meeting_id),
                capture_run_id: Some(capture_run_id),
                capture_fence: Some(capture_fence),
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
        let _ = (
            app,
            meeting_id,
            capture_run_id,
            capture_fence,
            event_id,
            ticket,
        );
        Err("meeting capture is Windows-only".to_string())
    }
}

/// Asks the engine to stop; the engine flushes, completes the manifest entry,
/// clears the managed state, and emits the final capture-state event itself.
#[tauri::command]
pub async fn stop_meeting_capture(app: AppHandle, reason: String) -> Result<(), String> {
    require_runtime_owner(&app)?;
    #[cfg(windows)]
    {
        let handle = app.state::<MeetingCaptureHandle>();
        let active = {
            let guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
            guard
                .as_ref()
                .map(|active| (active.stop.clone(), active.finalization.clone()))
        };
        match active {
            Some((stop, finalization)) => {
                let _ = stop.send(reason);
                tauri::async_runtime::spawn_blocking(move || {
                    finalization.wait(Duration::from_secs(45))
                })
                .await
                .map_err(|error| error.to_string())?
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
    pub capture_run_id: Option<String>,
    pub capture_fence: Option<i64>,
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
                capture_run_id: Some(active.capture_run_id.clone()),
                capture_fence: Some(active.capture_fence),
                event_id: Some(active.event_id.clone()),
                started_at_ms: Some(active.started_at_ms),
                paused: active.paused,
            }
        }
        _ => CaptureStatus {
            active: false,
            meeting_id: None,
            capture_run_id: None,
            capture_fence: None,
            event_id: None,
            started_at_ms: None,
            paused: false,
        },
    }
}

/// The upload pump's view of the durable queue: every meeting with its
/// segments and upload/completion flags. File IO (manifest read), so async.
#[tauri::command]
pub async fn queue_snapshot(app: AppHandle) -> Result<queue::QueueSnapshot, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::QueueSnapshot)?;
    let owner_uid = ticket.uid().to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::snapshot_for_owner(&blocking_app, &owner_uid)
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
    capture_run_id: String,
    seq: u32,
) -> Result<tauri::ipc::Response, String> {
    require_runtime_owner(&app)?;
    #[cfg(windows)]
    {
        let ticket = crate::security::authorize(&app, crate::security::Operation::ReadSegment)?;
        let owner_uid = ticket.uid().to_string();
        let blocking_app = app.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            queue::read_segment(&blocking_app, &owner_uid, &meeting_id, &capture_run_id, seq)
                .map(tauri::ipc::Response::new)
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
        let _ = (app, meeting_id, capture_run_id, seq);
        Err("meeting capture is Windows-only".to_string())
    }
}

#[tauri::command]
pub async fn claim_next_upload_job(app: AppHandle) -> Result<Option<queue::QueueJobLease>, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::QueueSnapshot)?;
    let owner_uid = ticket.uid().to_string();
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::claim_next_upload_job(&blocking_app, &owner_uid, &runtime_instance_id)
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(&app, crate::security::Operation::QueueSnapshot, &ticket)?;
    result
}

#[tauri::command]
pub async fn claim_next_completion_job(
    app: AppHandle,
) -> Result<Option<queue::QueueJobLease>, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::QueueSnapshot)?;
    let owner_uid = ticket.uid().to_string();
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::claim_next_completion_job(&blocking_app, &owner_uid, &runtime_instance_id)
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(&app, crate::security::Operation::QueueSnapshot, &ticket)?;
    result
}

#[tauri::command]
pub async fn resolve_upload_job(
    app: AppHandle,
    job_id: String,
    lease_token: String,
    receipt: queue::UploadReceipt,
) -> Result<(), String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkSegmentUploaded)?;
    let owner_uid = ticket.uid().to_string();
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::resolve_upload_success(
            &blocking_app,
            &owner_uid,
            &runtime_instance_id,
            &job_id,
            &lease_token,
            &receipt,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(
        &app,
        crate::security::Operation::MarkSegmentUploaded,
        &ticket,
    )?;
    result
}

#[tauri::command]
pub async fn resolve_completion_job(
    app: AppHandle,
    job_id: String,
    lease_token: String,
    receipt: queue::CompletionReceipt,
) -> Result<(), String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkMeetingAcked)?;
    let owner_uid = ticket.uid().to_string();
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::resolve_completion_success(
            &blocking_app,
            &owner_uid,
            &runtime_instance_id,
            &job_id,
            &lease_token,
            &receipt,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(&app, crate::security::Operation::MarkMeetingAcked, &ticket)?;
    result
}

#[tauri::command]
pub async fn fail_queue_job(
    app: AppHandle,
    job_id: String,
    lease_token: String,
    classification: String,
    error_code: String,
) -> Result<queue::JobFailureResult, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkSegmentUploaded)?;
    let owner_uid = ticket.uid().to_string();
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::fail_job(
            &blocking_app,
            &owner_uid,
            &runtime_instance_id,
            &job_id,
            &lease_token,
            &classification,
            &error_code,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(
        &app,
        crate::security::Operation::MarkSegmentUploaded,
        &ticket,
    )?;
    result
}

#[tauri::command]
pub async fn retry_capture_jobs(app: AppHandle, capture_run_id: String) -> Result<bool, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkSegmentUploaded)?;
    let owner_uid = ticket.uid().to_string();
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::retry_capture_jobs(
            &blocking_app,
            &owner_uid,
            &capture_run_id,
            &runtime_instance_id,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(
        &app,
        crate::security::Operation::MarkSegmentUploaded,
        &ticket,
    )?;
    result
}

/// Adopts the server's capture fence for a run whose uploads are being rejected
/// as stale, then re-arms its blocked jobs. Forward only; the store refuses a
/// backward move, which would mean the evidence had forked.
#[tauri::command]
pub async fn adopt_capture_fence(
    app: AppHandle,
    capture_run_id: String,
    capture_fence: i64,
) -> Result<bool, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkSegmentUploaded)?;
    let owner_uid = ticket.uid().to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::adopt_capture_fence(&blocking_app, &owner_uid, &capture_run_id, capture_fence)
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(
        &app,
        crate::security::Operation::MarkSegmentUploaded,
        &ticket,
    )?;
    result
}

/// Re-queues every capture this device recorded but never handed off. Called
/// once when a signed-in session comes up, and by the recordings list's
/// "Retry all", so a stranded recording never waits on a user noticing it.
#[tauri::command]
pub async fn revive_stranded_captures(app: AppHandle) -> Result<usize, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkSegmentUploaded)?;
    let owner_uid = ticket.uid().to_string();
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::revive_stranded_runs(&blocking_app, &owner_uid, &runtime_instance_id)
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(
        &app,
        crate::security::Operation::MarkSegmentUploaded,
        &ticket,
    )?;
    result
}

#[tauri::command]
pub async fn local_recordings(app: AppHandle) -> Result<Vec<queue::LocalRecording>, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::QueueSnapshot)?;
    let owner_uid = ticket.uid().to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::local_recordings(&blocking_app, &owner_uid)
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(&app, crate::security::Operation::QueueSnapshot, &ticket)?;
    result
}

#[tauri::command]
pub async fn export_local_recording(
    app: AppHandle,
    meeting_id: String,
    capture_run_id: String,
    include_audio: bool,
) -> Result<queue::ExportResult, String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::ReadSegment)?;
    let owner_uid = ticket.uid().to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let logs = crate::logging::read_redacted_log_tail(&blocking_app, 200)
            .unwrap_or_else(|error| vec![format!("log tail unavailable: {error}")]);
        queue::export_bundle(
            &blocking_app,
            &owner_uid,
            &meeting_id,
            &capture_run_id,
            include_audio,
            &logs,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
    crate::security::recheck(&app, crate::security::Operation::ReadSegment, &ticket)?;
    result
}

#[tauri::command]
pub async fn delete_local_recording(
    app: AppHandle,
    meeting_id: String,
    capture_run_id: String,
) -> Result<(), String> {
    require_runtime_owner(&app)?;
    let ticket = crate::security::authorize(&app, crate::security::Operation::MarkMeetingAcked)?;
    let owner_uid = ticket.uid().to_string();
    {
        let handle = app.state::<MeetingCaptureHandle>();
        let guard = handle.0.lock().unwrap_or_else(|error| error.into_inner());
        if guard
            .as_ref()
            .is_some_and(|active| active.capture_run_id == capture_run_id)
        {
            return Err("an active recording cannot be deleted".to_string());
        }
    }
    let runtime_instance_id = app
        .state::<MeetingRuntimeLease>()
        .runtime_instance_id()
        .to_string();
    let blocking_app = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        queue::request_local_deletion(
            &blocking_app,
            &owner_uid,
            &meeting_id,
            &capture_run_id,
            &runtime_instance_id,
        )
    })
    .await
    .map_err(|error| error.to_string())?;
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
    require_runtime_owner(&app)?;
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
pub fn stop_join_watch(app: AppHandle, event_id: String) -> Result<(), String> {
    require_runtime_owner(&app)?;
    #[cfg(windows)]
    detect::stop_join_watch(app, event_id);
    #[cfg(not(windows))]
    let _ = (app, event_id);
    Ok(())
}

/// One struct for `meeting-join-detected`, shared by the real detector
/// (detect.rs) and the dev lever below, so the debug path can never drift to
/// a different wire shape than production.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct JoinDetectedPayload {
    pub(super) event_id: String,
    pub(super) app: String,
    pub(super) window_title: String,
}

/// Dev-only lever: emits the same `meeting-join-detected` event the real
/// detector produces, so the whole claim -> capture -> upload -> synthesize
/// loop is drivable with no Zoom/Teams installed (see meetingDebug.ts).
#[tauri::command]
pub fn debug_force_join(app: AppHandle, event_id: String) -> Result<(), String> {
    if !cfg!(debug_assertions) {
        return Err("debug_force_join is dev-only".to_string());
    }
    require_runtime_owner(&app)?;
    app.emit(
        crate::events::MEETING_JOIN_DETECTED,
        JoinDetectedPayload {
            event_id,
            app: "debug".to_string(),
            window_title: "debug".to_string(),
        },
    )
    .map_err(|e| e.to_string())
}

// ── Engine callbacks (windows only) ─────────────────────────────────────────

/// One closed segment's place on the capture timeline, grouped so
/// `record_segment` and `close_segment` pass it as a unit.
#[cfg(windows)]
pub(crate) struct SegmentSpan {
    pub(crate) seq: u32,
    pub(crate) start_ms: i64,
    pub(crate) duration_ms: i64,
    pub(crate) incomplete: bool,
}

/// Called by the engine thread for every closed segment: encrypt, write,
/// record in the manifest, tell JS there's something to upload.
#[cfg(windows)]
pub(crate) fn record_segment(
    app: &AppHandle,
    run: &queue::CaptureRunRef,
    started_at_ms: i64,
    span: SegmentSpan,
    flac_bytes: &[u8],
    metrics: queue::SegmentAudioMetrics,
) -> Result<(), String> {
    use sha2::{Digest, Sha256};

    let owner_uid: &str = &run.owner_uid;
    let meeting_id: &str = &run.meeting_id;
    let capture_run_id: &str = &run.capture_run_id;
    let capture_fence = run.capture_fence;
    let event_id: &str = &run.event_id;
    let runtime_instance_id: &str = &run.runtime_instance_id;
    let installation_id: &str = &run.installation_id;
    let SegmentSpan { seq, start_ms, duration_ms, incomplete } = span;
    let key = crypto::load_or_create_key(app)?;
    let content_sha256 = format!("{:x}", Sha256::digest(flac_bytes));
    let mut metadata = queue::SegmentRecoveryMetadata {
        schema_version: 2,
        encryption_version: 2,
        owner_uid: owner_uid.to_string(),
        meeting_id: meeting_id.to_string(),
        capture_run_id: capture_run_id.to_string(),
        capture_fence,
        protocol_version: evidence_store::PROTOCOL_VERSION,
        event_id: event_id.to_string(),
        started_at_ms,
        runtime_instance_id: runtime_instance_id.to_string(),
        installation_id: installation_id.to_string(),
        seq,
        start_ms,
        duration_ms,
        incomplete,
        content_sha256,
        encrypted_sha256: String::new(),
        byte_length: flac_bytes.len() as u64,
        encrypted_byte_length: 0,
        channel_count: 2,
        sample_rate_hz: 16_000,
        metrics,
    };
    let encrypted = crypto::encrypt_with_aad(&key, flac_bytes, &metadata.aad())?;
    let encrypted_sha256 = format!("{:x}", Sha256::digest(&encrypted));
    metadata.encrypted_sha256 = encrypted_sha256;
    metadata.encrypted_byte_length = encrypted.len() as u64;
    queue::publish_segment(app, &metadata, &encrypted)?;
    if let Err(e) = app.emit(
        crate::events::MEETING_SEGMENT_READY,
        SegmentReadyPayload {
            owner_uid: owner_uid.to_string(),
            meeting_id: meeting_id.to_string(),
            capture_run_id: capture_run_id.to_string(),
            capture_fence,
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
                    capture_run_id: Some(active.capture_run_id.clone()),
                    capture_fence: Some(active.capture_fence),
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
    run: &queue::CaptureRunRef,
    started_at_ms: i64,
    total_duration_ms: i64,
    reason: &str,
) -> Result<(), String> {
    let owner_uid: &str = &run.owner_uid;
    let meeting_id: &str = &run.meeting_id;
    let capture_run_id: &str = &run.capture_run_id;
    let capture_fence = run.capture_fence;
    let event_id: &str = &run.event_id;
    let persistence = queue::finalize_capture(app, run, total_duration_ms, reason);
    let final_reason = persistence
        .as_ref()
        .map(|_| reason)
        .unwrap_or("manifest_persist_failed");
    if let Err(error) = &persistence {
        error!(
            "meeting: durable finalization failed meeting={meeting_id} run={capture_run_id} fence={capture_fence}: {error}"
        );
    }
    {
        let handle = app.state::<MeetingCaptureHandle>();
        let mut guard = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        *guard = None;
    }
    crate::tray::set_recording(app, false);
    info!(
        "meeting: capture finished meeting={meeting_id} run={capture_run_id} fence={capture_fence} reason={final_reason}"
    );
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
            capture_run_id: Some(capture_run_id.to_string()),
            capture_fence: Some(capture_fence),
            event_id: Some(event_id.to_string()),
            started_at_ms: Some(started_at_ms),
            paused: false,
            reason: final_reason.to_string(),
        },
    );
    persistence.map(|_| ())
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
