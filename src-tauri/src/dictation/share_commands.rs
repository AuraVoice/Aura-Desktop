//! IPC surface for the dictation sharing queue.
//!
//! Split from `share.rs` for the same reason `polish_commands` is split from
//! `polish`: the queue itself compiles wherever the sealed store does, but the
//! commands must be registrable unconditionally so the frontend never invokes a
//! name that was not registered. That was the concrete failure behind
//! `usePolishCredential.ts` retrying an unregistered command forever, so the
//! stubs below return a typed refusal rather than not existing.
//!
//! Every command is `async` (see CLAUDE.md, "Main-thread blocking") and pushes
//! its SQLite and crypto work onto the blocking pool: a claim decrypts a
//! transcript and a whole FLAC clip, which is not something to do on the thread
//! pumping the window's messages.

use tauri::AppHandle;

#[cfg(any(windows, target_os = "macos"))]
use super::share;

#[cfg(any(windows, target_os = "macos"))]
mod real {
    use super::*;

    /// Whether sharing is authorized right now. Passed in from React rather than
    /// read here, because the consent record lives in the frontend settings
    /// store; `generalSettings.improvementSharingActive` is the single place
    /// that decides it, version check included.
    #[tauri::command]
    pub async fn dictation_share_pump_state(
        app: AppHandle,
        uid: String,
        sharing: bool,
    ) -> Result<share::SharePumpState, String> {
        tauri::async_runtime::spawn_blocking(move || {
            if sharing {
                // Cheap and idempotent: an already-queued row is not re-queued,
                // so this is what folds a newly-eligible backlog in without a
                // separate "sharing was just switched on" signal.
                let _ = share::enqueue_backlog(&app, &uid);
            }
            share::pump_state(&app, &uid, sharing)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn dictation_claim_trace_upload(
        app: AppHandle,
        uid: String,
    ) -> Result<Option<share::TraceUploadLease>, String> {
        tauri::async_runtime::spawn_blocking(move || share::claim(&app, &uid))
            .await
            .map_err(|e| e.to_string())?
    }

    /// The FLAC body, raw over IPC so there is no base64 round trip, matching
    /// `dictation_history_audio`.
    #[tauri::command]
    pub async fn dictation_trace_upload_audio(
        app: AppHandle,
        uid: String,
        trace_id: String,
    ) -> Result<tauri::ipc::Response, String> {
        tauri::async_runtime::spawn_blocking(move || {
            share::audio_body(&app, &uid, &trace_id).map(tauri::ipc::Response::new)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn dictation_resolve_trace_upload(
        app: AppHandle,
        uid: String,
        trace_id: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || share::resolve(&app, &uid, &trace_id))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn dictation_fail_trace_upload(
        app: AppHandle,
        uid: String,
        trace_id: String,
        retryable: bool,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            share::fail(&app, &uid, &trace_id, retryable)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn dictation_pause_trace_uploads(
        app: AppHandle,
        uid: String,
        blocked_until_ms: i64,
    ) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            share::pause_for_quota(&app, &uid, blocked_until_ms)
        })
        .await
        .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn dictation_claim_trace_deletion(
        app: AppHandle,
        uid: String,
    ) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(move || share::claim_deletion(&app, &uid))
            .await
            .map_err(|e| e.to_string())?
    }

    #[tauri::command]
    pub async fn dictation_resolve_trace_deletion(
        app: AppHandle,
        uid: String,
        trace_id: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || share::resolve_deletion(&app, &uid, &trace_id))
            .await
            .map_err(|e| e.to_string())?
    }

    /// Turning sharing off. Queues a server-side delete for everything already
    /// uploaded and empties the queue. Withdrawal has to remove what was sent,
    /// not merely stop sending more.
    #[tauri::command]
    pub async fn dictation_revoke_trace_sharing(
        app: AppHandle,
        uid: String,
    ) -> Result<usize, String> {
        tauri::async_runtime::spawn_blocking(move || share::revoke_all(&app, &uid))
            .await
            .map_err(|e| e.to_string())?
    }
}

#[cfg(any(windows, target_os = "macos"))]
pub use real::*;

#[cfg(not(any(windows, target_os = "macos")))]
mod stub {
    use super::*;
    use serde::Serialize;

    const UNAVAILABLE: &str = "dictation sharing is unavailable on this platform";

    #[derive(Serialize, Default)]
    #[serde(rename_all = "camelCase")]
    pub struct SharePumpState {
        pub sharing: bool,
        pub pending_uploads: i64,
        pub pending_deletions: i64,
    }

    #[tauri::command]
    pub async fn dictation_share_pump_state(
        _app: AppHandle,
        _uid: String,
        _sharing: bool,
    ) -> Result<SharePumpState, String> {
        // Not an error: the pump asks every window, and a platform with no
        // sealed store simply has nothing queued.
        Ok(SharePumpState::default())
    }

    #[tauri::command]
    pub async fn dictation_claim_trace_upload(
        _app: AppHandle,
        _uid: String,
    ) -> Result<Option<()>, String> {
        Ok(None)
    }

    #[tauri::command]
    pub async fn dictation_trace_upload_audio(
        _app: AppHandle,
        _uid: String,
        _trace_id: String,
    ) -> Result<Vec<u8>, String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub async fn dictation_resolve_trace_upload(
        _app: AppHandle,
        _uid: String,
        _trace_id: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub async fn dictation_fail_trace_upload(
        _app: AppHandle,
        _uid: String,
        _trace_id: String,
        _retryable: bool,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub async fn dictation_pause_trace_uploads(
        _app: AppHandle,
        _uid: String,
        _blocked_until_ms: i64,
    ) -> Result<bool, String> {
        Ok(false)
    }

    #[tauri::command]
    pub async fn dictation_claim_trace_deletion(
        _app: AppHandle,
        _uid: String,
    ) -> Result<Option<String>, String> {
        Ok(None)
    }

    #[tauri::command]
    pub async fn dictation_resolve_trace_deletion(
        _app: AppHandle,
        _uid: String,
        _trace_id: String,
    ) -> Result<(), String> {
        Err(UNAVAILABLE.to_string())
    }

    #[tauri::command]
    pub async fn dictation_revoke_trace_sharing(
        _app: AppHandle,
        _uid: String,
    ) -> Result<usize, String> {
        Ok(0)
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub use stub::*;
