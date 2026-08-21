use super::*;

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "aura-meeting-evidence-test-{}",
            random_hex(8).unwrap()
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn store(&self) -> Store {
        Store::new(self.0.clone())
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        if self.0.starts_with(std::env::temp_dir()) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn begin() -> BeginCapture {
    BeginCapture {
        meeting_id: "meeting_1".to_string(),
        capture_run_id: "run_1".to_string(),
        capture_fence: 7,
        protocol_version: 2,
        owner_uid: "uid-1".to_string(),
        event_id: "event-1".to_string(),
        started_at_ms: 1_000,
        runtime_instance_id: "runtime_1".to_string(),
        installation_id: "install_1".to_string(),
    }
}

fn segment(seq: u32, plain: &[u8], encrypted: &[u8]) -> SegmentRecoveryMetadata {
    SegmentRecoveryMetadata {
        schema_version: 2,
        encryption_version: 2,
        owner_uid: "uid-1".to_string(),
        meeting_id: "meeting_1".to_string(),
        capture_run_id: "run_1".to_string(),
        capture_fence: 7,
        protocol_version: 2,
        event_id: "event-1".to_string(),
        started_at_ms: 1_000,
        runtime_instance_id: "runtime_1".to_string(),
        installation_id: "install_1".to_string(),
        seq,
        start_ms: seq as i64 * 1_000,
        duration_ms: 1_000,
        incomplete: false,
        content_sha256: sha256_hex(plain),
        encrypted_sha256: sha256_hex(encrypted),
        byte_length: plain.len() as u64,
        encrypted_byte_length: encrypted.len() as u64,
        channel_count: 2,
        sample_rate_hz: 16_000,
        metrics: SegmentAudioMetrics {
            mic_rms_dbfs: -18.0,
            system_rms_dbfs: -20.0,
            mic_clipping_ratio: 0.0,
            system_clipping_ratio: 0.0,
            mic_zero_ratio: 0.1,
            system_zero_ratio: 0.2,
            mic_vad_speech_ms: 800,
            system_vad_speech_ms: 700,
            mic_device_id_hash: "mic".to_string(),
            system_device_id_hash: "system".to_string(),
        },
    }
}

fn upload_receipt(metadata: &SegmentRecoveryMetadata) -> UploadReceipt {
    UploadReceipt {
        receipt_id: "receipt-upload-1".to_string(),
        object: "audio/v2/object.flac".to_string(),
        generation: "123".to_string(),
        content_sha256: metadata.content_sha256.clone(),
        byte_length: metadata.byte_length,
        accepted_at: "2026-07-29T20:00:00Z".to_string(),
    }
}

#[test]
fn receipts_and_manifest_are_bound_to_the_leased_evidence() {
    let directory = TestDirectory::new();
    let store = directory.store();
    let begin = begin();
    assert_eq!(store.begin_capture(&begin).unwrap(), (0, 0));
    let plain = b"plain flac";
    let encrypted = b"encrypted bytes";
    let metadata = segment(0, plain, encrypted);
    store.publish_segment(&metadata, encrypted).unwrap();

    let lease = store
        .claim_next_upload_job("uid-1", "runtime_1")
        .unwrap()
        .unwrap();
    let mut wrong = upload_receipt(&metadata);
    wrong.content_sha256 = sha256_hex(b"different");
    assert!(store
        .resolve_upload_success(
            "uid-1",
            "runtime_1",
            &lease.job_id,
            &lease.lease_token,
            &wrong,
        )
        .is_err());
    store
        .resolve_upload_success(
            "uid-1",
            "runtime_1",
            &lease.job_id,
            &lease.lease_token,
            &upload_receipt(&metadata),
        )
        .unwrap();

    let manifest = store
        .finalize_capture(
            "uid-1",
            "meeting_1",
            "run_1",
            7,
            "runtime_1",
            1_000,
            "stopped_by_user",
        )
        .unwrap();
    let completion = store
        .claim_next_completion_job("uid-1", "runtime_1")
        .unwrap()
        .unwrap();
    assert_eq!(
        completion.manifest_sha256.as_deref(),
        Some(manifest.as_str())
    );
    store
        .resolve_completion_success(
            "uid-1",
            "runtime_1",
            &completion.job_id,
            &completion.lease_token,
            &CompletionReceipt {
                receipt_id: "receipt-complete-1".to_string(),
                manifest_sha256: manifest,
                accepted_at: "2026-07-29T20:01:00Z".to_string(),
            },
        )
        .unwrap();
    let snapshot = store.snapshot_for_owner("uid-1").unwrap();
    assert_eq!(snapshot.captures.len(), 1);
    assert!(snapshot.captures[0].completion_acked);
    assert!(snapshot.captures[0].segments[0].uploaded);
}

#[test]
fn retry_schedule_and_attempt_count_survive_reopen() {
    let directory = TestDirectory::new();
    let store = directory.store();
    store.begin_capture(&begin()).unwrap();
    let metadata = segment(0, b"plain", b"cipher");
    store.publish_segment(&metadata, b"cipher").unwrap();
    let lease = store
        .claim_next_upload_job("uid-1", "runtime_1")
        .unwrap()
        .unwrap();
    let result = store
        .fail_job(
            "uid-1",
            "runtime_1",
            &lease.job_id,
            &lease.lease_token,
            "transient",
            "http_503",
        )
        .unwrap();
    assert_eq!(result.state, "retry");
    assert!(result.next_attempt_at_ms.is_some());

    let reopened = directory.store();
    let snapshot = reopened.snapshot_for_owner("uid-1").unwrap();
    assert!(snapshot.captures[0].retryable);
    assert_eq!(
        snapshot.captures[0].last_error_code.as_deref(),
        Some("http_503")
    );
    assert!(reopened
        .claim_next_upload_job("uid-1", "runtime_2")
        .unwrap()
        .is_none());
}

#[test]
fn second_digest_for_one_sequence_is_split_brain_and_never_overwrites() {
    let directory = TestDirectory::new();
    let store = directory.store();
    store.begin_capture(&begin()).unwrap();
    let first = segment(0, b"first", b"cipher-first");
    store.publish_segment(&first, b"cipher-first").unwrap();
    let second = segment(0, b"second", b"cipher-second");
    assert!(store.publish_segment(&second, b"cipher-second").is_err());
    let snapshot = store.snapshot_for_owner("uid-1").unwrap();
    assert_eq!(snapshot.captures[0].state, "split_brain");
    assert_eq!(
        snapshot.captures[0].segments[0].content_sha256,
        first.content_sha256
    );
    assert!(directory.0.join(final_relative_path(&first)).exists());
}

#[test]
fn valid_orphan_is_imported_and_row_without_file_is_marked_missing() {
    let directory = TestDirectory::new();
    let store = directory.store();
    store.begin_capture(&begin()).unwrap();
    let plain = b"orphan-plain";
    let encrypted = b"orphan-cipher";
    let metadata = segment(0, plain, encrypted);
    let relative = final_relative_path(&metadata);
    let sidecar_relative = metadata_relative_path(&metadata);
    let path = directory.0.join(&relative);
    let sidecar = directory.0.join(&sidecar_relative);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, encrypted).unwrap();
    std::fs::write(&sidecar, serde_json::to_vec(&metadata).unwrap()).unwrap();
    let report = store
        .reconcile(|candidate, bytes| {
            assert_eq!(candidate, &metadata);
            assert_eq!(bytes, encrypted);
            Ok(plain.to_vec())
        })
        .unwrap();
    assert_eq!(report.recovered_orphans, 1);
    assert_eq!(
        store.snapshot_for_owner("uid-1").unwrap().captures[0]
            .segments
            .len(),
        1
    );

    std::fs::remove_file(&path).unwrap();
    let report = store.reconcile(|_, _| Ok(plain.to_vec())).unwrap();
    assert_eq!(report.missing_files, 1);
    let snapshot = store.snapshot_for_owner("uid-1").unwrap();
    assert_eq!(snapshot.captures[0].state, "local_missing");
    assert!(!snapshot.captures[0].segments[0].local_present);
}

#[test]
fn explicit_delete_removes_exact_files_and_keeps_receipt_metadata() {
    let directory = TestDirectory::new();
    let store = directory.store();
    store.begin_capture(&begin()).unwrap();
    let metadata = segment(0, b"plain", b"cipher");
    store.publish_segment(&metadata, b"cipher").unwrap();
    store
        .finalize_capture(
            "uid-1",
            "meeting_1",
            "run_1",
            7,
            "runtime_1",
            1_000,
            "stopped_by_user",
        )
        .unwrap();
    store
        .request_local_deletion("uid-1", "meeting_1", "run_1", "runtime_1")
        .unwrap();
    assert_eq!(store.run_retention_jobs("runtime_1").unwrap(), 1);
    assert!(!directory.0.join(final_relative_path(&metadata)).exists());
    let recordings = store.local_recordings("uid-1").unwrap();
    assert_eq!(recordings[0].state, "local_deleted");
    assert!(!recordings[0].exportable);
    assert_eq!(recordings[0].deletion_state.as_deref(), Some("succeeded"));
    assert!(!store.audit_export("run_1").unwrap().is_empty());
}

