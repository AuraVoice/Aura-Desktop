//! Tauri-facing facade over the SQLite meeting evidence store.

use std::path::PathBuf;

use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

pub use super::evidence_store::{
    BeginCapture, CaptureRunRef, CompletionReceipt, ExportResult, JobFailureResult, LocalRecording,
    QueueJobLease, QueueSnapshot, ReconciliationReport, SegmentAudioMetrics,
    SegmentRecoveryMetadata, UploadReceipt, CAPTURES_DIR,
};
use super::evidence_store::{ExportRequest, Store, StoredSegment};

fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_local_data_dir()
        .map_err(|error| error.to_string())?
        .join(CAPTURES_DIR);
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn store(app: &AppHandle) -> Result<Store, String> {
    let store = Store::new(base_dir(app)?);
    store.initialize()?;
    Ok(store)
}

pub fn validate_meeting_id(meeting_id: &str) -> Result<(), String> {
    super::evidence_store::validate_identity(meeting_id, "meeting id")
}

pub fn validate_capture_run_id(capture_run_id: &str) -> Result<(), String> {
    super::evidence_store::validate_identity(capture_run_id, "capture run id")
}

pub fn initialize(app: &AppHandle) -> Result<(), String> {
    store(app).map(|_| ())
}

pub fn record_runtime_lease(
    app: &AppHandle,
    runtime_instance_id: &str,
    owns_runtime: bool,
) -> Result<(), String> {
    store(app)?.record_runtime_lease(runtime_instance_id, owns_runtime)
}

pub fn begin_capture(app: &AppHandle, request: &BeginCapture) -> Result<(u32, i64), String> {
    store(app)?.begin_capture(request)
}

pub fn publish_segment(
    app: &AppHandle,
    metadata: &SegmentRecoveryMetadata,
    encrypted: &[u8],
) -> Result<(), String> {
    store(app)?.publish_segment(metadata, encrypted)
}

pub fn finalize_capture(
    app: &AppHandle,
    run: &CaptureRunRef,
    total_duration_ms: i64,
    reason: &str,
) -> Result<String, String> {
    store(app)?.finalize_capture(run, total_duration_ms, reason)
}

pub fn snapshot_for_owner(app: &AppHandle, owner_uid: &str) -> Result<QueueSnapshot, String> {
    store(app)?.snapshot_for_owner(owner_uid)
}

pub fn claim_next_upload_job(
    app: &AppHandle,
    owner_uid: &str,
    runtime_instance_id: &str,
) -> Result<Option<QueueJobLease>, String> {
    store(app)?.claim_next_upload_job(owner_uid, runtime_instance_id)
}

pub fn claim_next_completion_job(
    app: &AppHandle,
    owner_uid: &str,
    runtime_instance_id: &str,
) -> Result<Option<QueueJobLease>, String> {
    store(app)?.claim_next_completion_job(owner_uid, runtime_instance_id)
}

pub fn resolve_upload_success(
    app: &AppHandle,
    owner_uid: &str,
    runtime_instance_id: &str,
    job_id: &str,
    lease_token: &str,
    receipt: &UploadReceipt,
) -> Result<(), String> {
    store(app)?.resolve_upload_success(owner_uid, runtime_instance_id, job_id, lease_token, receipt)
}

pub fn resolve_completion_success(
    app: &AppHandle,
    owner_uid: &str,
    runtime_instance_id: &str,
    job_id: &str,
    lease_token: &str,
    receipt: &CompletionReceipt,
) -> Result<(), String> {
    store(app)?.resolve_completion_success(
        owner_uid,
        runtime_instance_id,
        job_id,
        lease_token,
        receipt,
    )
}

pub fn fail_job(
    app: &AppHandle,
    owner_uid: &str,
    runtime_instance_id: &str,
    job_id: &str,
    lease_token: &str,
    classification: &str,
    error_code: &str,
) -> Result<JobFailureResult, String> {
    store(app)?.fail_job(
        owner_uid,
        runtime_instance_id,
        job_id,
        lease_token,
        classification,
        error_code,
    )
}

pub fn retry_capture_jobs(
    app: &AppHandle,
    owner_uid: &str,
    capture_run_id: &str,
    runtime_instance_id: &str,
) -> Result<bool, String> {
    store(app)?.retry_capture_jobs(owner_uid, capture_run_id, runtime_instance_id)
}

pub fn revive_stranded_runs(
    app: &AppHandle,
    owner_uid: &str,
    runtime_instance_id: &str,
) -> Result<usize, String> {
    store(app)?.revive_stranded_runs(owner_uid, runtime_instance_id)
}

pub fn adopt_capture_fence(
    app: &AppHandle,
    owner_uid: &str,
    capture_run_id: &str,
    capture_fence: i64,
) -> Result<bool, String> {
    store(app)?.adopt_capture_fence(owner_uid, capture_run_id, capture_fence)
}

pub fn read_segment(
    app: &AppHandle,
    owner_uid: &str,
    meeting_id: &str,
    capture_run_id: &str,
    seq: u32,
) -> Result<Vec<u8>, String> {
    let stored = store(app)?.stored_segment(owner_uid, meeting_id, capture_run_id, seq)?;
    read_and_verify(app, &stored)
}

fn read_and_verify(app: &AppHandle, stored: &StoredSegment) -> Result<Vec<u8>, String> {
    if !stored.local_present {
        return Err("segment retention window has expired".to_string());
    }
    let path = store(app)?.root().join(&stored.local_path);
    let encrypted = std::fs::read(&path).map_err(|error| error.to_string())?;
    if encrypted.len() as u64 != stored.metadata.encrypted_byte_length {
        return Err("encrypted segment length check failed".to_string());
    }
    if format!("{:x}", Sha256::digest(&encrypted)) != stored.metadata.encrypted_sha256 {
        return Err("encrypted segment integrity check failed".to_string());
    }
    #[cfg(windows)]
    let plain = {
        let key = super::crypto::load_or_create_key(app)?;
        if stored.metadata.encryption_version >= 2 {
            super::crypto::decrypt_with_aad(&key, &encrypted, &stored.metadata.aad())?
        } else {
            super::crypto::decrypt(&key, &encrypted)?
        }
    };
    #[cfg(not(windows))]
    let plain: Vec<u8> = {
        let _ = app;
        return Err("meeting capture is Windows-only".to_string());
    };
    if plain.len() as u64 != stored.metadata.byte_length {
        return Err("plaintext segment length check failed".to_string());
    }
    if format!("{:x}", Sha256::digest(&plain)) != stored.metadata.content_sha256 {
        return Err("plaintext segment integrity check failed".to_string());
    }
    Ok(plain)
}

pub fn interrupt_orphaned_captures(
    app: &AppHandle,
    runtime_instance_id: &str,
) -> Result<u32, String> {
    store(app)?.interrupt_orphaned_captures(runtime_instance_id)
}

pub fn reconcile(app: &AppHandle) -> Result<ReconciliationReport, String> {
    let store = store(app)?;
    #[cfg(windows)]
    {
        let key = super::crypto::load_or_create_key(app)?;
        store.reconcile(|metadata, encrypted| {
            if metadata.encryption_version >= 2 {
                super::crypto::decrypt_with_aad(&key, encrypted, &metadata.aad())
            } else {
                super::crypto::decrypt(&key, encrypted)
            }
        })
    }
    #[cfg(not(windows))]
    {
        let _ = store;
        Ok(ReconciliationReport::default())
    }
}

pub fn prune_expired(app: &AppHandle, runtime_instance_id: &str) -> Result<usize, String> {
    store(app)?.run_retention_jobs(runtime_instance_id)
}

pub fn local_recordings(app: &AppHandle, owner_uid: &str) -> Result<Vec<LocalRecording>, String> {
    store(app)?.local_recordings(owner_uid)
}

pub fn request_local_deletion(
    app: &AppHandle,
    owner_uid: &str,
    meeting_id: &str,
    capture_run_id: &str,
    runtime_instance_id: &str,
) -> Result<(), String> {
    store(app)?.request_local_deletion(
        owner_uid,
        meeting_id,
        capture_run_id,
        runtime_instance_id,
    )?;
    let _ = store(app)?.run_retention_jobs(runtime_instance_id)?;
    Ok(())
}

pub fn export_bundle(
    app: &AppHandle,
    owner_uid: &str,
    meeting_id: &str,
    capture_run_id: &str,
    include_audio: bool,
    sanitized_log_lines: &[String],
) -> Result<ExportResult, String> {
    let destination_root = app
        .path()
        .download_dir()
        .map_err(|error| error.to_string())?
        .join("Aura Recordings");
    let store = store(app)?;
    #[cfg(windows)]
    {
        let key = super::crypto::load_or_create_key(app)?;
        store.export_bundle(
            owner_uid,
            meeting_id,
            capture_run_id,
            &ExportRequest {
                destination_root: &destination_root,
                include_audio,
                sanitized_log_lines,
            },
            |metadata, encrypted| {
                if metadata.encryption_version >= 2 {
                    super::crypto::decrypt_with_aad(&key, encrypted, &metadata.aad())
                } else {
                    super::crypto::decrypt(&key, encrypted)
                }
            },
        )
    }
    #[cfg(not(windows))]
    {
        let _ = (
            owner_uid,
            meeting_id,
            capture_run_id,
            include_audio,
            sanitized_log_lines,
            destination_root,
            store,
        );
        Err("meeting export is Windows-only".to_string())
    }
}

pub fn installation_id(app: &AppHandle) -> Result<String, String> {
    #[cfg(windows)]
    {
        let key = super::crypto::load_or_create_key(app)?;
        let digest = format!("{:x}", Sha256::digest(key));
        Ok(format!("install_{}", &digest[..32]))
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(format!(
            "install_{}",
            super::evidence_store::random_hex(16)?
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_capture_run_id, validate_meeting_id};

    #[test]
    fn accepts_backend_shaped_identities() {
        assert!(validate_meeting_id("3f2a9c1b7d4e4f209a1b2c3d4e5f6a7b").is_ok());
        assert!(validate_capture_run_id("run_2026-07-29_abcd").is_ok());
    }

    #[test]
    fn rejects_path_shaped_identities() {
        for bad in ["", "../x", "a/b", r"a\b", "a.b", "id with space", ".."] {
            assert!(validate_meeting_id(bad).is_err(), "{bad:?}");
            assert!(validate_capture_run_id(bad).is_err(), "{bad:?}");
        }
    }
}
