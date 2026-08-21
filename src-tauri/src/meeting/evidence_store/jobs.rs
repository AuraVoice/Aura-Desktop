use super::*;

impl Store {
    pub fn claim_next_upload_job(
        &self,
        owner_uid: &str,
        runtime_instance_id: &str,
    ) -> Result<Option<QueueJobLease>, String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now_ms();
        let candidate: Option<(
            String,
            String,
            String,
            u32,
            String,
            u32,
            String,
            i64,
            u8,
            String,
            i64,
            i64,
            bool,
            u64,
            u8,
            u32,
            u32,
        )> = tx
            .query_row(
                "SELECT
                    j.job_id, j.meeting_id, j.capture_run_id, j.seq,
                    j.content_sha256, j.attempt_count, r.event_id,
                    COALESCE(r.server_capture_fence, r.capture_fence),
                    r.protocol_version, r.owner_uid,
                    s.start_ms, s.duration_ms, s.incomplete, s.byte_length,
                    s.channel_count, s.sample_rate_hz, s.local_present
                 FROM upload_jobs j
                 JOIN capture_runs r ON r.capture_run_id=j.capture_run_id
                 JOIN segments s ON s.capture_run_id=j.capture_run_id
                                AND s.seq=j.seq
                                AND s.content_sha256=j.content_sha256
                 WHERE r.owner_uid=?1
                   AND r.state NOT IN ('split_brain','local_missing','local_deleted',
                                       'capture_failed_integrity','delete_requested')
                   AND s.local_present=1
                   AND (
                        j.state IN ('pending','retry')
                        OR (j.state='leased' AND j.lease_expires_at_ms<=?2)
                   )
                   AND j.next_attempt_at_ms<=?2
                 ORDER BY j.next_attempt_at_ms, j.created_at_ms
                 LIMIT 1",
                params![owner_uid, timestamp],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get::<_, i64>(3)? as u32,
                        row.get(4)?,
                        row.get::<_, i64>(5)? as u32,
                        row.get(6)?,
                        row.get(7)?,
                        row.get::<_, i64>(8)? as u8,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get::<_, i64>(12)? != 0,
                        row.get::<_, i64>(13)? as u64,
                        row.get::<_, i64>(14)? as u8,
                        row.get::<_, i64>(15)? as u32,
                        row.get::<_, i64>(16)? as u32,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        let Some(candidate) = candidate else {
            tx.commit().map_err(db_error)?;
            return Ok(None);
        };
        if candidate.9 != owner_uid || candidate.16 == 0 {
            return Err("upload job ownership or local evidence check failed".to_string());
        }
        let lease_token = random_hex(16)?;
        let attempt_count = candidate.5.saturating_add(1);
        let changed = tx
            .execute(
                "UPDATE upload_jobs SET
                    state='leased', attempt_count=?2, lease_token=?3,
                    lease_expires_at_ms=?4, updated_at_ms=?5
                 WHERE job_id=?1
                   AND (
                        state IN ('pending','retry')
                        OR (state='leased' AND lease_expires_at_ms<=?5)
                   )",
                params![
                    candidate.0,
                    attempt_count,
                    lease_token,
                    timestamp.saturating_add(JOB_LEASE_MS),
                    timestamp,
                ],
            )
            .map_err(db_error)?;
        if changed != 1 {
            tx.rollback().map_err(db_error)?;
            return Ok(None);
        }
        audit(
            &tx,
            "upload_attempted",
            owner_uid,
            Some(runtime_instance_id),
            Some(&candidate.1),
            Some(&candidate.2),
            Some(candidate.7),
            Some(&candidate.0),
            Some(attempt_count),
            Some(&lease_token),
            None,
            Some("leased"),
            None,
            &candidate.2,
            &json!({
                "seq": candidate.3,
                "content_sha256": candidate.4,
            }),
        )?;
        tx.commit().map_err(db_error)?;
        Ok(Some(QueueJobLease {
            job_id: candidate.0,
            lease_token,
            kind: "upload".to_string(),
            meeting_id: candidate.1,
            capture_run_id: candidate.2,
            capture_fence: candidate.7,
            protocol_version: candidate.8,
            event_id: candidate.6,
            seq: Some(candidate.3),
            start_ms: Some(candidate.10),
            duration_ms: Some(candidate.11),
            incomplete: Some(candidate.12),
            content_sha256: Some(candidate.4),
            byte_length: Some(candidate.13),
            channel_count: Some(candidate.14),
            sample_rate_hz: Some(candidate.15),
            manifest_sha256: None,
            segment_count: None,
            total_duration_ms: None,
            reason: None,
            segment_digests: Vec::new(),
            manifest_segments: Vec::new(),
            attempt_count,
        }))
    }

    pub fn claim_next_completion_job(
        &self,
        owner_uid: &str,
        runtime_instance_id: &str,
    ) -> Result<Option<QueueJobLease>, String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now_ms();
        let candidate: Option<(
            String,
            String,
            String,
            String,
            u32,
            String,
            i64,
            u8,
            String,
            i64,
            String,
        )> = tx
            .query_row(
                "SELECT
                    j.job_id, j.meeting_id, j.capture_run_id,
                    j.manifest_sha256, j.attempt_count, r.event_id,
                    COALESCE(r.server_capture_fence, r.capture_fence),
                    r.protocol_version, r.owner_uid,
                    r.total_duration_ms, r.complete_reason
                 FROM completion_jobs j
                 JOIN capture_runs r ON r.capture_run_id=j.capture_run_id
                 WHERE r.owner_uid=?1
                   AND r.state='finalized_local'
                   AND (
                        j.state IN ('pending','retry')
                        OR (j.state='leased' AND j.lease_expires_at_ms<=?2)
                   )
                   AND j.next_attempt_at_ms<=?2
                   AND NOT EXISTS (
                        SELECT 1 FROM upload_jobs u
                        WHERE u.capture_run_id=j.capture_run_id
                          AND u.state!='succeeded'
                   )
                   AND NOT EXISTS (
                        SELECT 1 FROM segments s
                        WHERE s.capture_run_id=j.capture_run_id
                          AND (s.local_present=0 OR s.state IN (
                              'local_missing','split_brain'
                          ))
                   )
                   AND (
                        (SELECT COUNT(*) FROM segments s
                         WHERE s.capture_run_id=j.capture_run_id)=0
                        OR (
                            (SELECT MIN(seq) FROM segments s
                             WHERE s.capture_run_id=j.capture_run_id)=0
                            AND
                            (SELECT MAX(seq) + 1 FROM segments s
                             WHERE s.capture_run_id=j.capture_run_id)=
                            (SELECT COUNT(*) FROM segments s
                             WHERE s.capture_run_id=j.capture_run_id)
                        )
                   )
                 ORDER BY j.next_attempt_at_ms, j.created_at_ms
                 LIMIT 1",
                params![owner_uid, timestamp],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get::<_, i64>(4)? as u32,
                        row.get(5)?,
                        row.get(6)?,
                        row.get::<_, i64>(7)? as u8,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        let Some(candidate) = candidate else {
            tx.commit().map_err(db_error)?;
            return Ok(None);
        };
        if candidate.8 != owner_uid {
            return Err("completion job ownership check failed".to_string());
        }
        let segments = query_segments_tx(&tx, &candidate.2)?;
        let computed_manifest = manifest_digest(&segments, candidate.9, &candidate.10);
        if computed_manifest != candidate.3 {
            tx.execute(
                "UPDATE completion_jobs SET state='terminal',
                    last_error_code='manifest_digest_changed',
                    last_error_at_ms=?2, updated_at_ms=?2
                 WHERE job_id=?1",
                params![candidate.0, timestamp],
            )
            .map_err(db_error)?;
            tx.execute(
                "UPDATE capture_runs SET state='split_brain',
                    last_error_code='manifest_digest_changed',
                    updated_at_ms=?2 WHERE capture_run_id=?1",
                params![candidate.2, timestamp],
            )
            .map_err(db_error)?;
            audit(
                &tx,
                "completion_rejected",
                owner_uid,
                Some(runtime_instance_id),
                Some(&candidate.1),
                Some(&candidate.2),
                Some(candidate.6),
                Some(&candidate.0),
                Some(candidate.4),
                None,
                Some("pending"),
                Some("terminal"),
                Some("manifest_digest_changed"),
                &candidate.2,
                &json!({
                    "expected": candidate.3,
                    "computed": computed_manifest,
                }),
            )?;
            tx.commit().map_err(db_error)?;
            return Ok(None);
        }
        let lease_token = random_hex(16)?;
        let attempt_count = candidate.4.saturating_add(1);
        let changed = tx
            .execute(
                "UPDATE completion_jobs SET
                    state='leased', attempt_count=?2, lease_token=?3,
                    lease_expires_at_ms=?4, updated_at_ms=?5
                 WHERE job_id=?1
                   AND (
                        state IN ('pending','retry')
                        OR (state='leased' AND lease_expires_at_ms<=?5)
                   )",
                params![
                    candidate.0,
                    attempt_count,
                    lease_token,
                    timestamp.saturating_add(JOB_LEASE_MS),
                    timestamp,
                ],
            )
            .map_err(db_error)?;
        if changed != 1 {
            tx.rollback().map_err(db_error)?;
            return Ok(None);
        }
        audit(
            &tx,
            "completion_attempted",
            owner_uid,
            Some(runtime_instance_id),
            Some(&candidate.1),
            Some(&candidate.2),
            Some(candidate.6),
            Some(&candidate.0),
            Some(attempt_count),
            Some(&lease_token),
            None,
            Some("leased"),
            None,
            &candidate.2,
            &json!({
                "manifest_sha256": candidate.3,
                "segment_count": segments.len(),
            }),
        )?;
        tx.commit().map_err(db_error)?;
        Ok(Some(QueueJobLease {
            job_id: candidate.0,
            lease_token,
            kind: "completion".to_string(),
            meeting_id: candidate.1,
            capture_run_id: candidate.2,
            capture_fence: candidate.6,
            protocol_version: candidate.7,
            event_id: candidate.5,
            seq: None,
            start_ms: None,
            duration_ms: None,
            incomplete: None,
            content_sha256: None,
            byte_length: None,
            channel_count: None,
            sample_rate_hz: None,
            manifest_sha256: Some(candidate.3),
            segment_count: Some(segments.len() as u32),
            total_duration_ms: Some(candidate.9),
            reason: Some(candidate.10),
            segment_digests: segments
                .iter()
                .map(|segment| segment.content_sha256.clone())
                .collect(),
            manifest_segments: segments
                .iter()
                .map(|segment| CompletionSegment {
                    seq: segment.seq,
                    start_ms: segment.start_ms,
                    duration_ms: segment.duration_ms,
                    incomplete: segment.incomplete,
                    content_sha256: segment.content_sha256.clone(),
                    byte_length: segment.byte_length,
                    channel_count: segment.channel_count,
                    sample_rate_hz: segment.sample_rate_hz,
                    metrics: segment.metrics.clone(),
                })
                .collect(),
            attempt_count,
        }))
    }

    pub fn resolve_upload_success(
        &self,
        owner_uid: &str,
        runtime_instance_id: &str,
        job_id: &str,
        lease_token: &str,
        receipt: &UploadReceipt,
    ) -> Result<(), String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let job: (String, String, u32, String, u64, i64, u32, String, i64) = tx
            .query_row(
                "SELECT j.meeting_id, j.capture_run_id, j.seq,
                        j.content_sha256, s.byte_length,
                        COALESCE(r.server_capture_fence, r.capture_fence),
                        j.attempt_count, r.owner_uid, r.protocol_version
                 FROM upload_jobs j
                 JOIN segments s ON s.capture_run_id=j.capture_run_id
                                AND s.seq=j.seq
                 JOIN capture_runs r ON r.capture_run_id=j.capture_run_id
                 WHERE j.job_id=?1 AND j.state='leased' AND j.lease_token=?2",
                params![job_id, lease_token],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get::<_, i64>(2)? as u32,
                        row.get(3)?,
                        row.get::<_, i64>(4)? as u64,
                        row.get(5)?,
                        row.get::<_, i64>(6)? as u32,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .map_err(|_| "upload job lease is stale or unknown".to_string())?;
        if job.7 != owner_uid {
            return Err("unknown upload job".to_string());
        }
        if receipt.content_sha256 != job.3 || receipt.byte_length != job.4 {
            return Err("upload receipt does not match the leased segment".to_string());
        }
        if receipt.receipt_id.is_empty()
            || receipt.object.is_empty()
            || receipt.generation.is_empty()
            || receipt.accepted_at.is_empty()
        {
            return Err("upload receipt is incomplete".to_string());
        }
        let receipt_json = serde_json::to_string(receipt).map_err(|e| e.to_string())?;
        let timestamp = now_ms();
        tx.execute(
            "UPDATE upload_jobs SET state='succeeded', receipt_json=?2,
                lease_token=NULL, lease_expires_at_ms=NULL,
                last_error_code=NULL, updated_at_ms=?3
             WHERE job_id=?1 AND state='leased' AND lease_token=?4",
            params![job_id, receipt_json, timestamp, lease_token],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE segments SET state='uploaded_verified', updated_at_ms=?4
             WHERE capture_run_id=?1 AND seq=?2 AND content_sha256=?3",
            params![job.1, job.2, job.3, timestamp],
        )
        .map_err(db_error)?;
        // A success is more recent than whatever error preceded it. Nothing used
        // to clear this, so one transient blip labelled a fully uploaded
        // recording "Needs attention" forever.
        tx.execute(
            "UPDATE capture_runs SET last_error_code=NULL, updated_at_ms=?2
             WHERE capture_run_id=?1 AND last_error_code IS NOT NULL",
            params![job.1, timestamp],
        )
        .map_err(db_error)?;
        audit(
            &tx,
            "upload_accepted",
            owner_uid,
            Some(runtime_instance_id),
            Some(&job.0),
            Some(&job.1),
            Some(job.5),
            Some(job_id),
            Some(job.6),
            Some(lease_token),
            Some("leased"),
            Some("succeeded"),
            None,
            &job.1,
            &json!({
                "seq": job.2,
                "receipt_id": receipt.receipt_id,
                "object": receipt.object,
                "generation": receipt.generation,
                "content_sha256": receipt.content_sha256,
                "byte_length": receipt.byte_length,
            }),
        )?;
        tx.commit().map_err(db_error)
    }

    pub fn resolve_completion_success(
        &self,
        owner_uid: &str,
        runtime_instance_id: &str,
        job_id: &str,
        lease_token: &str,
        receipt: &CompletionReceipt,
    ) -> Result<(), String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let job: (String, String, String, i64, u32, String) = tx
            .query_row(
                "SELECT j.meeting_id, j.capture_run_id, j.manifest_sha256,
                        COALESCE(r.server_capture_fence, r.capture_fence),
                        j.attempt_count, r.owner_uid
                 FROM completion_jobs j
                 JOIN capture_runs r ON r.capture_run_id=j.capture_run_id
                 WHERE j.job_id=?1 AND j.state='leased' AND j.lease_token=?2",
                params![job_id, lease_token],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get::<_, i64>(4)? as u32,
                        row.get(5)?,
                    ))
                },
            )
            .map_err(|_| "completion job lease is stale or unknown".to_string())?;
        if job.5 != owner_uid {
            return Err("unknown completion job".to_string());
        }
        if receipt.manifest_sha256 != job.2
            || receipt.receipt_id.is_empty()
            || receipt.accepted_at.is_empty()
        {
            return Err("completion receipt does not match the leased manifest".to_string());
        }
        let timestamp = now_ms();
        tx.execute(
            "UPDATE completion_jobs SET state='succeeded', receipt_json=?2,
                lease_token=NULL, lease_expires_at_ms=NULL,
                last_error_code=NULL, updated_at_ms=?3
             WHERE job_id=?1 AND state='leased' AND lease_token=?4",
            params![
                job_id,
                serde_json::to_string(receipt).map_err(|e| e.to_string())?,
                timestamp,
                lease_token,
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE capture_runs SET state='uploaded_verified',
                completion_acked=1,
                acked_at_ms=COALESCE(acked_at_ms, ?2),
                last_error_code=NULL,
                updated_at_ms=?2
             WHERE capture_run_id=?1 AND manifest_sha256=?3",
            params![job.1, timestamp, job.2],
        )
        .map_err(db_error)?;
        audit(
            &tx,
            "completion_verified",
            owner_uid,
            Some(runtime_instance_id),
            Some(&job.0),
            Some(&job.1),
            Some(job.3),
            Some(job_id),
            Some(job.4),
            Some(lease_token),
            Some("leased"),
            Some("succeeded"),
            None,
            &job.1,
            &json!({
                "receipt_id": receipt.receipt_id,
                "manifest_sha256": receipt.manifest_sha256,
            }),
        )?;
        tx.commit().map_err(db_error)
    }

    pub fn fail_job(
        &self,
        owner_uid: &str,
        runtime_instance_id: &str,
        job_id: &str,
        lease_token: &str,
        classification: &str,
        error_code: &str,
    ) -> Result<JobFailureResult, String> {
        self.initialize()?;
        if error_code.is_empty() || error_code.len() > 128 {
            return Err("invalid queue error code".to_string());
        }
        let table = if job_id.starts_with("upload:") {
            "upload_jobs"
        } else if job_id.starts_with("complete:") {
            "completion_jobs"
        } else {
            return Err("unknown queue job type".to_string());
        };
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let query = format!(
            "SELECT j.meeting_id, j.capture_run_id, j.attempt_count,
                    r.capture_fence, r.owner_uid
             FROM {table} j
             JOIN capture_runs r ON r.capture_run_id=j.capture_run_id
             WHERE j.job_id=?1 AND j.state='leased' AND j.lease_token=?2"
        );
        let job: (String, String, u32, i64, String) = tx
            .query_row(&query, params![job_id, lease_token], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get::<_, i64>(2)? as u32,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })
            .map_err(|_| "queue job lease is stale or unknown".to_string())?;
        if job.4 != owner_uid {
            return Err("unknown queue job".to_string());
        }
        let timestamp = now_ms();
        let (state, next_attempt_at_ms, retryable) = match classification {
            "transient" => {
                let delay = full_jitter_delay(job.2)?;
                ("retry", Some(timestamp.saturating_add(delay)), true)
            }
            "auth" => ("retry", Some(timestamp), true),
            "paused" => ("paused", None, true),
            "terminal" => ("terminal", None, false),
            _ => return Err("invalid queue failure classification".to_string()),
        };
        let update = format!(
            "UPDATE {table} SET
                state=?2, next_attempt_at_ms=COALESCE(?3, next_attempt_at_ms),
                last_error_code=?4, last_error_at_ms=?5,
                lease_token=NULL, lease_expires_at_ms=NULL, updated_at_ms=?5
             WHERE job_id=?1 AND state='leased' AND lease_token=?6"
        );
        let changed = tx
            .execute(
                &update,
                params![
                    job_id,
                    state,
                    next_attempt_at_ms,
                    error_code,
                    timestamp,
                    lease_token,
                ],
            )
            .map_err(db_error)?;
        if changed != 1 {
            return Err("queue job lease expired before failure commit".to_string());
        }
        if !retryable {
            tx.execute(
                "UPDATE capture_runs SET state='needs_attention',
                    last_error_code=?2, updated_at_ms=?3
                 WHERE capture_run_id=?1 AND state!='local_deleted'",
                params![job.1, error_code, timestamp],
            )
            .map_err(db_error)?;
        } else {
            tx.execute(
                "UPDATE capture_runs SET last_error_code=?2, updated_at_ms=?3
                 WHERE capture_run_id=?1",
                params![job.1, error_code, timestamp],
            )
            .map_err(db_error)?;
        }
        audit(
            &tx,
            if table == "upload_jobs" {
                "upload_failed"
            } else {
                "completion_failed"
            },
            owner_uid,
            Some(runtime_instance_id),
            Some(&job.0),
            Some(&job.1),
            Some(job.3),
            Some(job_id),
            Some(job.2),
            Some(lease_token),
            Some("leased"),
            Some(state),
            Some(error_code),
            &job.1,
            &json!({
                "classification": classification,
                "next_attempt_at_ms": next_attempt_at_ms,
            }),
        )?;
        tx.commit().map_err(db_error)?;
        Ok(JobFailureResult {
            state: state.to_string(),
            next_attempt_at_ms,
            retryable,
        })
    }

    pub fn retry_capture_jobs(
        &self,
        owner_uid: &str,
        capture_run_id: &str,
        runtime_instance_id: &str,
    ) -> Result<bool, String> {
        self.initialize()?;
        let repaired = self.prepare_capture_for_retry(
            owner_uid,
            capture_run_id,
            runtime_instance_id,
        )?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let run: Option<(String, String, i64, String, i64)> = tx
            .query_row(
                "SELECT owner_uid, meeting_id, capture_fence, state, completion_acked
                 FROM capture_runs WHERE capture_run_id=?1",
                params![capture_run_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()
            .map_err(db_error)?;
        let Some(run) = run else {
            return Ok(false);
        };
        if run.0 != owner_uid {
            return Ok(false);
        }
        // A run whose local evidence is gone or forked cannot be retried into
        // anything useful, and one the server already acknowledged needs nothing.
        if run.4 != 0
            || matches!(
                run.3.as_str(),
                "split_brain"
                    | "local_missing"
                    | "local_deleted"
                    | "capture_failed_integrity"
                    | "delete_requested"
            )
        {
            return Ok(false);
        }
        let timestamp = now_ms();
        // 'terminal' is included deliberately. A terminal job had no revival path
        // at all: nothing moved it back to pending, no notification fired, and no
        // UI offered a retry, so one unlucky 409 destroyed the whole recording.
        // Reviving is safe because every server mutation is idempotent on exact
        // evidence identity - a replay returns the original receipt.
        let uploads = tx
            .execute(
                "UPDATE upload_jobs SET state='pending', next_attempt_at_ms=?2,
                    attempt_count=0, lease_token=NULL, lease_expires_at_ms=NULL,
                    last_error_code=NULL, updated_at_ms=?2
                 WHERE capture_run_id=?1 AND state IN ('retry','paused','terminal')",
                params![capture_run_id, timestamp],
            )
            .map_err(db_error)?;
        let completions = tx
            .execute(
                "UPDATE completion_jobs SET state='pending', next_attempt_at_ms=?2,
                    attempt_count=0, lease_token=NULL, lease_expires_at_ms=NULL,
                    last_error_code=NULL, updated_at_ms=?2
                 WHERE capture_run_id=?1 AND state IN ('retry','paused','terminal')",
                params![capture_run_id, timestamp],
            )
            .map_err(db_error)?;
        // fail_job parks a non-retryable run in 'needs_attention', but
        // claim_next_completion_job only ever looks at 'finalized_local'. Without
        // restoring the state the revived completion job could never be claimed
        // and the retry would silently do nothing.
        let restored = if run.3 == "needs_attention" {
            tx.execute(
                "UPDATE capture_runs SET state='finalized_local', updated_at_ms=?2
                 WHERE capture_run_id=?1 AND finished_at_ms IS NOT NULL",
                params![capture_run_id, timestamp],
            )
            .map_err(db_error)?
        } else {
            0
        };
        tx.execute(
            "UPDATE capture_runs SET last_error_code=NULL, updated_at_ms=?2
             WHERE capture_run_id=?1",
            params![capture_run_id, timestamp],
        )
        .map_err(db_error)?;
        let changed = repaired || uploads + completions + restored > 0;
        if changed {
            audit(
                &tx,
                "queue_retry_requested",
                owner_uid,
                Some(runtime_instance_id),
                Some(&run.1),
                Some(capture_run_id),
                Some(run.2),
                None,
                None,
                None,
                None,
                Some("pending"),
                Some("user_retry"),
                capture_run_id,
                &json!({
                    "upload_jobs": uploads,
                    "completion_jobs": completions,
                }),
            )?;
        }
        tx.commit().map_err(db_error)?;
        Ok(changed)
    }

    fn prepare_capture_for_retry(
        &self,
        owner_uid: &str,
        capture_run_id: &str,
        runtime_instance_id: &str,
    ) -> Result<bool, String> {
        let conn = self.connect()?;
        let run: Option<(String, String, i64, String)> = conn
            .query_row(
                "SELECT owner_uid, meeting_id, capture_fence, state
                 FROM capture_runs WHERE capture_run_id=?1",
                params![capture_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(db_error)?;
        let Some((run_owner_uid, meeting_id, capture_fence, state)) = run else {
            return Ok(false);
        };
        if run_owner_uid != owner_uid {
            return Ok(false);
        }
        if state == "capturing_interrupted" {
            let total_duration_ms = conn
                .query_row(
                    "SELECT COALESCE(MAX(start_ms + duration_ms), 0)
                     FROM segments WHERE capture_run_id=?1",
                    params![capture_run_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(db_error)?;
            drop(conn);
            self.finalize_capture(
                owner_uid,
                &meeting_id,
                capture_run_id,
                capture_fence,
                runtime_instance_id,
                total_duration_ms.min(MAX_CAPTURE_DURATION_MS),
                "capture_interrupted",
            )?;
            return Ok(true);
        }
        Ok(false)
    }

}

