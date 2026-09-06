//! Tauri-facing facade over the SQLite meeting evidence store.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub use super::evidence_store::{
    BeginCapture, CaptureRunRef, CompletionReceipt, ExportResult, JobFailureResult, LocalRecording,
    QueueJobLease, QueueSnapshot, ReconciliationReport, SegmentAudioMetrics,
    SegmentRecoveryMetadata, UploadReceipt, CAPTURES_DIR,
};
use super::evidence_store::{ExportRequest, Store, StoredSegment};

/// Sits beside the captures it tags. Plaintext on purpose: see `installation_id`.
const INSTALLATION_ID_FILE: &str = "installation-id";

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

// Off Windows the `plain` binding below is initialised by a diverging block, so
// it is never read and everything after it is unreachable. Both go away once
// the segment cipher is cross-platform; keep the scope to this one function.
#[cfg_attr(not(windows), allow(unused_variables, unreachable_code))]
fn read_and_verify(app: &AppHandle, stored: &StoredSegment) -> Result<Vec<u8>, String> {
    if !stored.local_present {
        return Err("segment retention window has expired".to_string());
    }
    let path = store(app)?.root().join(&stored.local_path);
    let encrypted = std::fs::read(&path).map_err(|error| error.to_string())?;
    if encrypted.len() as u64 != stored.metadata.encrypted_byte_length {
        return Err("encrypted segment length check failed".to_string());
    }
    if crate::util::sha256_hex(&encrypted) != stored.metadata.encrypted_sha256 {
        return Err("encrypted segment integrity check failed".to_string());
    }
    let plain = {
        let key = super::crypto::load_or_create_key(app)?;
        if stored.metadata.encryption_version >= 2 {
            super::crypto::decrypt_with_aad(&key, &encrypted, &stored.metadata.aad())?
        } else {
            super::crypto::decrypt(&key, &encrypted)?
        }
    };
    if plain.len() as u64 != stored.metadata.byte_length {
        return Err("plaintext segment length check failed".to_string());
    }
    if crate::util::sha256_hex(&plain) != stored.metadata.content_sha256 {
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
    {
        // Resolved on the first segment that actually needs decrypting, never
        // up front. This runs at every launch (meeting::startup_maintenance),
        // so loading the key eagerly made an install with zero recordings pay
        // for the key store anyway - on macOS that used to be a keychain hit
        // before the user had done anything at all.
        // A Cell because `reconcile` takes `Fn`, not `FnMut`.
        let key = std::cell::Cell::new(None::<[u8; 32]>);
        store.reconcile(|metadata, encrypted| {
            let key = match key.get() {
                Some(key) => key,
                None => {
                    let loaded = super::crypto::load_or_create_key(app)?;
                    key.set(Some(loaded));
                    loaded
                }
            };
            if metadata.encryption_version >= 2 {
                super::crypto::decrypt_with_aad(&key, encrypted, &metadata.aad())
            } else {
                super::crypto::decrypt(&key, encrypted)
            }
        })
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
}

/// Names this installation on capture rows so a stranded capture can be matched
/// back to the machine that made it. A device tag, not a secret.
///
/// It used to be a SHA-256 of the segment encryption key, which meant the
/// overlay asking for runtime status at mount pulled a live key out of the key
/// store purely to hash it - on macOS, a keychain round trip before the user
/// had touched anything. The id is now its own random value, so nothing on this
/// path touches crypto at all.
pub fn installation_id(app: &AppHandle) -> Result<String, String> {
    let path = base_dir(app)?.join(INSTALLATION_ID_FILE);
    loop {
        match std::fs::read_to_string(&path) {
            Ok(stored) => {
                let stored = stored.trim();
                if is_installation_id(stored) {
                    return Ok(stored.to_string());
                }
                // A truncated or hand-edited file would otherwise poison every
                // capture row it named. Replace it: unlike a key, a device tag
                // that has to change costs only the recovery match for captures
                // still in flight.
                std::fs::remove_file(&path)
                    .map_err(|error| format!("could not replace the installation id: {error}"))?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("could not read the installation id: {error}")),
        }

        let minted = format!("install_{}", crate::util::random_hex(16)?);

        // create_new on the final path so two processes racing at launch settle
        // on one id instead of overwriting each other. Losing is not an error.
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                use std::io::Write;
                file.write_all(minted.as_bytes())
                    .map_err(|error| format!("could not write the installation id: {error}"))?;
                file.sync_all()
                    .map_err(|error| format!("could not write the installation id: {error}"))?;
                return Ok(minted);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("could not write the installation id: {error}")),
        }
    }
}

fn is_installation_id(value: &str) -> bool {
    match value.strip_prefix("install_") {
        Some(hex) => hex.len() == 32 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()),
        None => false,
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
