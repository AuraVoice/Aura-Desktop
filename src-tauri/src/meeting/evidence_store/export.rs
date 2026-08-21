use super::*;

impl Store {
    pub fn export_bundle<F>(
        &self,
        owner_uid: &str,
        meeting_id: &str,
        capture_run_id: &str,
        destination_root: &Path,
        include_audio: bool,
        sanitized_log_lines: &[String],
        decrypt: F,
    ) -> Result<ExportResult, String>
    where
        F: Fn(&SegmentRecoveryMetadata, &[u8]) -> Result<Vec<u8>, String>,
    {
        self.initialize()?;
        let snapshot = self.snapshot_for_owner(owner_uid)?;
        let capture = snapshot
            .captures
            .into_iter()
            .find(|capture| {
                capture.meeting_id == meeting_id && capture.capture_run_id == capture_run_id
            })
            .ok_or_else(|| "unknown local recording".to_string())?;
        let stored_segments = self
            .all_stored_segments()?
            .into_iter()
            .filter(|segment| {
                segment.metadata.owner_uid == owner_uid
                    && segment.metadata.meeting_id == meeting_id
                    && segment.metadata.capture_run_id == capture_run_id
            })
            .collect::<Vec<_>>();
        if include_audio && !stored_segments.iter().any(|segment| segment.local_present) {
            return Err("this recording no longer has retained local audio".to_string());
        }

        std::fs::create_dir_all(destination_root).map_err(|e| e.to_string())?;
        let run_prefix = capture_run_id.chars().take(12).collect::<String>();
        let folder_name = format!(
            "Aura-Meeting-{}-{}-{}",
            capture.started_at_ms,
            run_prefix,
            random_hex(4)?
        );
        let export_dir = destination_root.join(folder_name);
        std::fs::create_dir(&export_dir).map_err(|e| e.to_string())?;

        let audit_events = self.audit_export(capture_run_id)?;
        let jobs = self.jobs_export(capture_run_id)?;
        let evidence = json!({
            "schema_version": 2,
            "exported_at_ms": now_ms(),
            "audio_included": include_audio,
            "capture": capture,
            "segment_recovery_metadata": stored_segments
                .iter()
                .map(|segment| &segment.metadata)
                .collect::<Vec<_>>(),
            "jobs": jobs,
            "audit_events": audit_events,
            "sanitized_log_tail": sanitized_log_lines,
        });
        write_export_artifact(
            &export_dir.join("evidence.json"),
            &serde_json::to_vec_pretty(&evidence).map_err(|e| e.to_string())?,
        )?;

        let mut exported_segments = 0u32;
        if include_audio {
            let audio_dir = export_dir.join("audio");
            std::fs::create_dir(&audio_dir).map_err(|e| e.to_string())?;
            for segment in &stored_segments {
                if !segment.local_present {
                    continue;
                }
                let encrypted = std::fs::read(self.root.join(&segment.local_path))
                    .map_err(|e| e.to_string())?;
                if encrypted.len() as u64 != segment.metadata.encrypted_byte_length
                    || sha256_hex(&encrypted) != segment.metadata.encrypted_sha256
                {
                    return Err(format!(
                        "segment {} failed ciphertext verification during export",
                        segment.metadata.seq
                    ));
                }
                let plain = decrypt(&segment.metadata, &encrypted)?;
                if plain.len() as u64 != segment.metadata.byte_length
                    || sha256_hex(&plain) != segment.metadata.content_sha256
                {
                    return Err(format!(
                        "segment {} failed plaintext verification during export",
                        segment.metadata.seq
                    ));
                }
                let name = format!(
                    "{:06}-{}.flac",
                    segment.metadata.seq, segment.metadata.content_sha256
                );
                write_export_artifact(&audio_dir.join(name), &plain)?;
                exported_segments += 1;
            }
            sync_directory(&audio_dir)?;
        }
        sync_directory(&export_dir)?;
        sync_directory(destination_root)?;
        Ok(ExportResult {
            path: export_dir.to_string_lossy().to_string(),
            segment_count: exported_segments,
            included_audio: include_audio,
        })
    }

    pub(super) fn audit_export(&self, capture_run_id: &str) -> Result<Vec<Value>, String> {
        let conn = self.connect()?;
        let mut statement = conn
            .prepare(
                "SELECT
                    local_sequence, event_id, event_type, occurred_at_ms,
                    recorded_at_ms, actor_type, actor_identity_hash,
                    runtime_instance_id, meeting_id, capture_run_id,
                    capture_fence, job_id, attempt, lease_token_hash,
                    previous_state, next_state, reason_code, correlation_id,
                    causation_id, software_version, schema_version, details_json
                 FROM audit_events
                 WHERE capture_run_id=?1
                 ORDER BY local_sequence",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![capture_run_id], |row| {
                let details: String = row.get(21)?;
                Ok(json!({
                    "local_sequence": row.get::<_, i64>(0)?,
                    "event_id": row.get::<_, String>(1)?,
                    "event_type": row.get::<_, String>(2)?,
                    "occurred_at_ms": row.get::<_, i64>(3)?,
                    "recorded_at_ms": row.get::<_, i64>(4)?,
                    "actor_type": row.get::<_, String>(5)?,
                    "actor_identity_hash": row.get::<_, String>(6)?,
                    "runtime_instance_id": row.get::<_, Option<String>>(7)?,
                    "meeting_id": row.get::<_, Option<String>>(8)?,
                    "capture_run_id": row.get::<_, Option<String>>(9)?,
                    "capture_fence": row.get::<_, Option<i64>>(10)?,
                    "job_id": row.get::<_, Option<String>>(11)?,
                    "attempt": row.get::<_, Option<i64>>(12)?,
                    "lease_token_hash": row.get::<_, Option<String>>(13)?,
                    "previous_state": row.get::<_, Option<String>>(14)?,
                    "next_state": row.get::<_, Option<String>>(15)?,
                    "reason_code": row.get::<_, Option<String>>(16)?,
                    "correlation_id": row.get::<_, String>(17)?,
                    "causation_id": row.get::<_, Option<String>>(18)?,
                    "software_version": row.get::<_, String>(19)?,
                    "schema_version": row.get::<_, i64>(20)?,
                    "details": serde_json::from_str::<Value>(&details)
                        .unwrap_or_else(|_| json!({"parse_error": true})),
                }))
            })
            .map_err(db_error)?;
        rows.map(|row| row.map_err(db_error)).collect()
    }

    fn jobs_export(&self, capture_run_id: &str) -> Result<Value, String> {
        let conn = self.connect()?;
        let uploads = export_job_rows(
            &conn,
            "SELECT job_id, state, attempt_count, next_attempt_at_ms,
                    last_error_code, last_error_at_ms, receipt_json,
                    seq, content_sha256
             FROM upload_jobs WHERE capture_run_id=?1 ORDER BY seq",
            capture_run_id,
            true,
        )?;
        let completions = export_job_rows(
            &conn,
            "SELECT job_id, state, attempt_count, next_attempt_at_ms,
                    last_error_code, last_error_at_ms, receipt_json,
                    NULL, manifest_sha256
             FROM completion_jobs WHERE capture_run_id=?1 ORDER BY created_at_ms",
            capture_run_id,
            false,
        )?;
        let retention = export_job_rows(
            &conn,
            "SELECT job_id, state, attempt_count, due_at_ms,
                    last_error_code, NULL, receipt_json, NULL, reason
             FROM retention_jobs WHERE capture_run_id=?1 ORDER BY created_at_ms",
            capture_run_id,
            false,
        )?;
        Ok(json!({
            "upload_jobs": uploads,
            "completion_jobs": completions,
            "retention_jobs": retention,
        }))
    }
}

fn export_job_rows(
    conn: &Connection,
    query: &str,
    capture_run_id: &str,
    has_seq: bool,
) -> Result<Vec<Value>, String> {
    let mut statement = conn.prepare(query).map_err(db_error)?;
    let rows = statement
        .query_map(params![capture_run_id], |row| {
            let receipt: Option<String> = row.get(6)?;
            Ok(json!({
                "job_id": row.get::<_, String>(0)?,
                "state": row.get::<_, String>(1)?,
                "attempt_count": row.get::<_, i64>(2)?,
                "next_attempt_at_ms": row.get::<_, i64>(3)?,
                "last_error_code": row.get::<_, Option<String>>(4)?,
                "last_error_at_ms": row.get::<_, Option<i64>>(5)?,
                "receipt": receipt
                    .as_deref()
                    .and_then(|value| serde_json::from_str::<Value>(value).ok()),
                "seq": if has_seq {
                    row.get::<_, Option<i64>>(7)?
                } else {
                    None
                },
                "identity": row.get::<_, String>(8)?,
            }))
        })
        .map_err(db_error)?;
    rows.map(|row| row.map_err(db_error)).collect()
}

fn write_export_artifact(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "export path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let tmp = path.with_extension(format!(
        "{}.{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact"),
        random_hex(4)?
    ));
    write_new_synced(&tmp, bytes)?;
    durable_rename(&tmp, path)?;
    sync_directory(parent)
}
