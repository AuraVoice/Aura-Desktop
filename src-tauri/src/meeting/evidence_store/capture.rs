use super::*;

impl Store {
    pub fn begin_capture(&self, request: &BeginCapture) -> Result<(u32, i64), String> {
        self.initialize()?;
        validate_identity(&request.meeting_id, "meeting id")?;
        validate_identity(&request.capture_run_id, "capture run id")?;
        validate_identity(&request.runtime_instance_id, "runtime instance id")?;
        validate_identity(&request.installation_id, "installation id")?;
        if request.owner_uid.is_empty() {
            return Err("missing capture owner".to_string());
        }
        if request.capture_fence < 0 {
            return Err("capture fence cannot be negative".to_string());
        }

        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now_ms();
        tx.execute(
            "INSERT INTO meetings(
                meeting_id, owner_uid, event_id, created_at_ms, updated_at_ms
             ) VALUES(?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(meeting_id) DO UPDATE SET
                event_id=excluded.event_id,
                updated_at_ms=excluded.updated_at_ms
             WHERE meetings.owner_uid=excluded.owner_uid",
            params![
                request.meeting_id,
                request.owner_uid,
                request.event_id,
                request.started_at_ms
            ],
        )
        .map_err(db_error)?;
        let meeting_owner: String = tx
            .query_row(
                "SELECT owner_uid FROM meetings WHERE meeting_id=?1",
                params![request.meeting_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        if meeting_owner != request.owner_uid {
            return Err("unknown meeting id".to_string());
        }

        let existing: Option<(String, i64, String, i64)> = tx
            .query_row(
                "SELECT owner_uid, capture_fence, state, completion_acked
                 FROM capture_runs WHERE capture_run_id=?1",
                params![request.capture_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(db_error)?;
        let previous_state = existing.as_ref().map(|row| row.2.as_str());
        if let Some((owner_uid, capture_fence, state, completion_acked)) = &existing {
            if owner_uid != &request.owner_uid {
                return Err("unknown capture run".to_string());
            }
            // A BACKWARD fence is a genuine fork: some other writer has moved on
            // and this evidence can never be reconciled. A FORWARD fence is just
            // the server telling us it re-issued the lease (an app restart mid
            // meeting), and refusing it stranded every segment already recorded
            // under the old fence with no way to restamp them. Adopt it: the
            // server compares segments on content identity, not on fence, so
            // already-uploaded segments stay valid alongside the new ones.
            if *capture_fence > request.capture_fence {
                return Err("capture fence conflicts with retained local evidence".to_string());
            }
            if *completion_acked != 0 || state == "local_deleted" {
                return Err("an acknowledged capture run cannot be reopened".to_string());
            }
            tx.execute(
                "UPDATE capture_runs SET
                    state='capturing',
                    runtime_instance_id=?2,
                    installation_id=?3,
                    protocol_version=?4,
                    server_capture_fence=?6,
                    finished_at_ms=NULL,
                    retain_local_until_ms=NULL,
                    complete_reason='',
                    manifest_sha256=NULL,
                    last_error_code=NULL,
                    updated_at_ms=?5
                 WHERE capture_run_id=?1",
                params![
                    request.capture_run_id,
                    request.runtime_instance_id,
                    request.installation_id,
                    request.protocol_version,
                    timestamp,
                    request.capture_fence,
                ],
            )
            .map_err(db_error)?;
            tx.execute(
                "UPDATE completion_jobs SET state='superseded', updated_at_ms=?2
                 WHERE capture_run_id=?1 AND state!='succeeded'",
                params![request.capture_run_id, timestamp],
            )
            .map_err(db_error)?;
        } else {
            tx.execute(
                "INSERT INTO capture_runs(
                    capture_run_id, meeting_id, owner_uid, event_id,
                    capture_fence, protocol_version, runtime_instance_id,
                    installation_id, state, started_at_ms, complete_reason,
                    created_at_ms, updated_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'capturing',
                          ?9, '', ?10, ?10)",
                params![
                    request.capture_run_id,
                    request.meeting_id,
                    request.owner_uid,
                    request.event_id,
                    request.capture_fence,
                    request.protocol_version,
                    request.runtime_instance_id,
                    request.installation_id,
                    request.started_at_ms,
                    timestamp,
                ],
            )
            .map_err(db_error)?;
        }
        audit(
            &tx,
            "capture_started",
            &request.owner_uid,
            Some(&request.runtime_instance_id),
            Some(&request.meeting_id),
            Some(&request.capture_run_id),
            Some(request.capture_fence),
            None,
            None,
            None,
            previous_state,
            Some("capturing"),
            None,
            &request.capture_run_id,
            &json!({
                "protocol_version": request.protocol_version,
                "installation_id": request.installation_id,
            }),
        )?;
        let offsets = tx
            .query_row(
                "SELECT
                    COALESCE(MAX(seq) + 1, 0),
                    COALESCE(MAX(start_ms + duration_ms), 0)
                 FROM segments WHERE capture_run_id=?1",
                params![request.capture_run_id],
                |row| Ok((row.get::<_, i64>(0)? as u32, row.get(1)?)),
            )
            .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(offsets)
    }

    pub fn publish_segment(
        &self,
        metadata: &SegmentRecoveryMetadata,
        encrypted: &[u8],
    ) -> Result<(), String> {
        self.initialize()?;
        validate_identity(&metadata.meeting_id, "meeting id")?;
        validate_identity(&metadata.capture_run_id, "capture run id")?;
        validate_sha256(&metadata.content_sha256, "plaintext digest")?;
        validate_sha256(&metadata.encrypted_sha256, "ciphertext digest")?;
        if metadata.encrypted_byte_length != encrypted.len() as u64 {
            return Err("encrypted segment length changed before publication".to_string());
        }
        if sha256_hex(encrypted) != metadata.encrypted_sha256 {
            return Err("encrypted segment digest changed before publication".to_string());
        }

        let conn = self.connect()?;
        let run: (String, String, i64, String) = conn
            .query_row(
                "SELECT owner_uid, meeting_id, capture_fence, state
                 FROM capture_runs WHERE capture_run_id=?1",
                params![metadata.capture_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(db_error)?;
        if run.0 != metadata.owner_uid
            || run.1 != metadata.meeting_id
            || run.2 != metadata.capture_fence
        {
            return Err("segment identity does not match its capture run".to_string());
        }
        if run.3 != "capturing" {
            return Err(format!("capture run is not writable ({})", run.3));
        }
        let existing: Option<(String, i64, String)> = conn
            .query_row(
                "SELECT content_sha256, local_present, local_path
                 FROM segments WHERE capture_run_id=?1 AND seq=?2",
                params![metadata.capture_run_id, metadata.seq],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(db_error)?;
        if let Some((digest, local_present, relative_path)) = existing {
            if digest == metadata.content_sha256
                && local_present != 0
                && self.root.join(relative_path).exists()
            {
                return Ok(());
            }
            self.record_split_brain(metadata, "segment_sequence_digest_conflict", Some(&digest))?;
            return Err(format!(
                "segment identity conflict for {}/{}: refusing overwrite",
                metadata.capture_run_id, metadata.seq
            ));
        }
        drop(conn);

        let relative_path = final_relative_path(metadata);
        let sidecar_relative = metadata_relative_path(metadata);
        let path = self.root.join(&relative_path);
        let sidecar = self.root.join(&sidecar_relative);
        let parent = path
            .parent()
            .ok_or_else(|| "segment path has no parent".to_string())?;
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

        let sidecar_bytes = serde_json::to_vec_pretty(metadata).map_err(|e| e.to_string())?;
        if !sidecar.exists() {
            let tmp = sidecar.with_extension(format!(
                "json.{}.{}.tmp",
                std::process::id(),
                random_hex(4)?
            ));
            write_new_synced(&tmp, &sidecar_bytes)?;
            durable_rename(&tmp, &sidecar)?;
        }
        if path.exists() {
            let existing_bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            if sha256_hex(existing_bytes) != metadata.encrypted_sha256 {
                self.record_split_brain(metadata, "untracked_segment_path_conflict", None)?;
                return Err(format!(
                    "untracked segment already exists for {}/{}",
                    metadata.capture_run_id, metadata.seq
                ));
            }
        } else {
            let tmp = path.with_extension(format!(
                "flac.enc.{}.{}.tmp",
                std::process::id(),
                random_hex(4)?
            ));
            write_new_synced(&tmp, encrypted)?;
            durable_rename(&tmp, &path)?;
        }
        sync_directory(parent)?;

        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now_ms();
        let inserted = tx
            .execute(
                "INSERT OR IGNORE INTO segments(
                    capture_run_id, meeting_id, seq, start_ms, duration_ms,
                    incomplete, content_sha256, encrypted_sha256, byte_length,
                    encrypted_byte_length, channel_count, sample_rate_hz,
                    local_path, metadata_path, encryption_version, state,
                    local_present, mic_rms_dbfs, system_rms_dbfs,
                    mic_clipping_ratio, system_clipping_ratio, mic_zero_ratio,
                    system_zero_ratio, mic_vad_speech_ms,
                    system_vad_speech_ms, mic_device_id_hash,
                    system_device_id_hash, created_at_ms, updated_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                          ?11, ?12, ?13, ?14, ?15, 'local_ready', 1, ?16,
                          ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25,
                          ?26, ?26)",
                params![
                    metadata.capture_run_id,
                    metadata.meeting_id,
                    metadata.seq,
                    metadata.start_ms,
                    metadata.duration_ms,
                    metadata.incomplete,
                    metadata.content_sha256,
                    metadata.encrypted_sha256,
                    metadata.byte_length,
                    metadata.encrypted_byte_length,
                    metadata.channel_count,
                    metadata.sample_rate_hz,
                    path_text(&relative_path),
                    path_text(&sidecar_relative),
                    metadata.encryption_version,
                    metadata.metrics.mic_rms_dbfs,
                    metadata.metrics.system_rms_dbfs,
                    metadata.metrics.mic_clipping_ratio,
                    metadata.metrics.system_clipping_ratio,
                    metadata.metrics.mic_zero_ratio,
                    metadata.metrics.system_zero_ratio,
                    metadata.metrics.mic_vad_speech_ms,
                    metadata.metrics.system_vad_speech_ms,
                    metadata.metrics.mic_device_id_hash,
                    metadata.metrics.system_device_id_hash,
                    timestamp,
                ],
            )
            .map_err(db_error)?;
        if inserted == 0 {
            tx.rollback().map_err(db_error)?;
            self.record_split_brain(metadata, "segment_insert_conflict", None)?;
            return Err("segment row conflicted during publication".to_string());
        }
        let job_id = upload_job_id(
            &metadata.meeting_id,
            &metadata.capture_run_id,
            metadata.seq,
            &metadata.content_sha256,
        );
        tx.execute(
            "INSERT INTO upload_jobs(
                job_id, meeting_id, capture_run_id, seq, content_sha256,
                state, next_attempt_at_ms, created_at_ms, updated_at_ms
             ) VALUES(?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?6, ?6)",
            params![
                job_id,
                metadata.meeting_id,
                metadata.capture_run_id,
                metadata.seq,
                metadata.content_sha256,
                timestamp,
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE capture_runs SET state='capturing', updated_at_ms=?2
             WHERE capture_run_id=?1",
            params![metadata.capture_run_id, timestamp],
        )
        .map_err(db_error)?;
        for (channel, device_id_hash) in [
            ("microphone", metadata.metrics.mic_device_id_hash.as_str()),
            ("system", metadata.metrics.system_device_id_hash.as_str()),
        ] {
            audit(
                &tx,
                "device_opened",
                &metadata.owner_uid,
                Some(&metadata.runtime_instance_id),
                Some(&metadata.meeting_id),
                Some(&metadata.capture_run_id),
                Some(metadata.capture_fence),
                None,
                None,
                None,
                None,
                Some("capturing"),
                None,
                &metadata.capture_run_id,
                &json!({
                    "seq": metadata.seq,
                    "channel": channel,
                    "device_id_hash": device_id_hash,
                    "sample_rate_hz": metadata.sample_rate_hz,
                }),
            )?;
        }
        audit(
            &tx,
            "segment_finalized",
            &metadata.owner_uid,
            Some(&metadata.runtime_instance_id),
            Some(&metadata.meeting_id),
            Some(&metadata.capture_run_id),
            Some(metadata.capture_fence),
            Some(&job_id),
            None,
            None,
            None,
            Some("local_ready"),
            None,
            &metadata.capture_run_id,
            &json!({
                "seq": metadata.seq,
                "content_sha256": metadata.content_sha256,
                "encrypted_sha256": metadata.encrypted_sha256,
                "byte_length": metadata.byte_length,
                "duration_ms": metadata.duration_ms,
                "metrics": metadata.metrics,
            }),
        )?;
        tx.commit().map_err(db_error)
    }

    pub(super) fn record_split_brain(
        &self,
        metadata: &SegmentRecoveryMetadata,
        reason: &str,
        existing_digest: Option<&str>,
    ) -> Result<(), String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let previous: Option<String> = tx
            .query_row(
                "SELECT state FROM capture_runs WHERE capture_run_id=?1",
                params![metadata.capture_run_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        tx.execute(
            "UPDATE capture_runs SET state='split_brain',
                last_error_code=?2, updated_at_ms=?3
             WHERE capture_run_id=?1",
            params![metadata.capture_run_id, reason, now_ms()],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE upload_jobs SET state='terminal', last_error_code=?2,
                last_error_at_ms=?3, updated_at_ms=?3
             WHERE capture_run_id=?1 AND state!='succeeded'",
            params![metadata.capture_run_id, reason, now_ms()],
        )
        .map_err(db_error)?;
        audit(
            &tx,
            "segment_split_brain",
            &metadata.owner_uid,
            Some(&metadata.runtime_instance_id),
            Some(&metadata.meeting_id),
            Some(&metadata.capture_run_id),
            Some(metadata.capture_fence),
            None,
            None,
            None,
            previous.as_deref(),
            Some("split_brain"),
            Some(reason),
            &metadata.capture_run_id,
            &json!({
                "seq": metadata.seq,
                "incoming_digest": metadata.content_sha256,
                "existing_digest": existing_digest,
            }),
        )?;
        tx.commit().map_err(db_error)
    }

    pub fn finalize_capture(
        &self,
        run: &CaptureRunRef,
        total_duration_ms: i64,
        reason: &str,
    ) -> Result<String, String> {
        let owner_uid: &str = &run.owner_uid;
        let meeting_id: &str = &run.meeting_id;
        let capture_run_id: &str = &run.capture_run_id;
        let capture_fence = run.capture_fence;
        let runtime_instance_id: &str = &run.runtime_instance_id;
        self.initialize()?;
        let mut conn = self.connect()?;
        let segments = query_segments(&conn, capture_run_id)?;
        let manifest_sha256 = manifest_digest(&segments, total_duration_ms, reason);
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let row: (String, String, i64, String, Option<i64>) = tx
            .query_row(
                "SELECT owner_uid, meeting_id, capture_fence, state,
                        retain_local_until_ms
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
            .map_err(db_error)?;
        if row.0 != owner_uid || row.1 != meeting_id || row.2 != capture_fence {
            return Err("capture finalization identity mismatch".to_string());
        }
        if matches!(
            row.3.as_str(),
            "split_brain" | "local_missing" | "local_deleted"
        ) {
            return Err(format!("capture cannot finalize from {}", row.3));
        }
        let finished_at_ms = now_ms();
        let retain_until = row
            .4
            .unwrap_or(0)
            .max(finished_at_ms.saturating_add(AUDIO_RETENTION_MS));
        let integrity_failed = reason == "capture_failed"
            || segments.iter().any(|segment| {
                !segment.local_present
                    || matches!(
                        segment.state.as_str(),
                        "local_missing" | "split_brain"
                    )
            });
        let next_state = if integrity_failed {
            "capture_failed_integrity"
        } else {
            "finalized_local"
        };
        tx.execute(
            "UPDATE capture_runs SET
                state=?2, finished_at_ms=?3, retain_local_until_ms=?4,
                complete_reason=?5,
                total_duration_ms=MAX(total_duration_ms, ?6),
                manifest_sha256=?7,
                updated_at_ms=?3
             WHERE capture_run_id=?1",
            params![
                capture_run_id,
                next_state,
                finished_at_ms,
                retain_until,
                reason,
                total_duration_ms,
                manifest_sha256,
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE completion_jobs SET state='superseded', updated_at_ms=?2
             WHERE capture_run_id=?1 AND manifest_sha256!=?3 AND state!='succeeded'",
            params![capture_run_id, finished_at_ms, manifest_sha256],
        )
        .map_err(db_error)?;
        if !integrity_failed {
            let job_id = completion_job_id(meeting_id, capture_run_id, &manifest_sha256);
            let next_attempt_at = if reason == "meeting_left" {
                finished_at_ms.saturating_add(REJOIN_HOLD_MS)
            } else {
                finished_at_ms
            };
            tx.execute(
                "INSERT INTO completion_jobs(
                    job_id, meeting_id, capture_run_id, manifest_sha256,
                    state, next_attempt_at_ms, created_at_ms, updated_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?6)
                 ON CONFLICT(capture_run_id, manifest_sha256) DO UPDATE SET
                    state=CASE WHEN completion_jobs.state='succeeded'
                               THEN 'succeeded' ELSE 'pending' END,
                    next_attempt_at_ms=MIN(completion_jobs.next_attempt_at_ms, excluded.next_attempt_at_ms),
                    updated_at_ms=excluded.updated_at_ms",
                params![
                    job_id,
                    meeting_id,
                    capture_run_id,
                    manifest_sha256,
                    next_attempt_at,
                    finished_at_ms,
                ],
            )
            .map_err(db_error)?;
        }
        let retention_job_id = format!("retention:{meeting_id}:{capture_run_id}:policy-v1");
        tx.execute(
            "INSERT INTO retention_jobs(
                job_id, meeting_id, capture_run_id, reason, policy_version,
                state, due_at_ms, created_at_ms, updated_at_ms
             ) VALUES(?1, ?2, ?3, 'retention_expired', 'local-audio-v1',
                      'pending', ?4, ?5, ?5)
             ON CONFLICT(job_id) DO UPDATE SET
                due_at_ms=MAX(retention_jobs.due_at_ms, excluded.due_at_ms),
                updated_at_ms=excluded.updated_at_ms",
            params![
                retention_job_id,
                meeting_id,
                capture_run_id,
                retain_until,
                finished_at_ms,
            ],
        )
        .map_err(db_error)?;
        audit(
            &tx,
            if integrity_failed {
                "capture_finalization_failed"
            } else {
                "capture_finalized"
            },
            owner_uid,
            Some(runtime_instance_id),
            Some(meeting_id),
            Some(capture_run_id),
            Some(capture_fence),
            None,
            None,
            None,
            Some(&row.3),
            Some(next_state),
            integrity_failed.then_some("local_integrity_failed"),
            capture_run_id,
            &json!({
                "manifest_sha256": manifest_sha256,
                "segment_count": segments.len(),
                "total_duration_ms": total_duration_ms,
                "retain_local_until_ms": retain_until,
                "reason": reason,
            }),
        )?;
        tx.commit().map_err(db_error)?;
        if integrity_failed {
            Err("capture finalization failed local integrity checks".to_string())
        } else {
            Ok(manifest_sha256)
        }
    }

    pub fn snapshot_for_owner(&self, owner_uid: &str) -> Result<QueueSnapshot, String> {
        self.initialize()?;
        let conn = self.connect()?;
        let mut statement = conn
            .prepare(
                "SELECT
                    capture_run_id, meeting_id, owner_uid, event_id,
                    capture_fence, protocol_version, state, started_at_ms,
                    finished_at_ms, retain_local_until_ms, complete_reason,
                    total_duration_ms, manifest_sha256, completion_acked,
                    acked_at_ms, local_audio_deleted_at_ms, last_error_code
                 FROM capture_runs
                 WHERE owner_uid=?1
                 ORDER BY updated_at_ms DESC",
            )
            .map_err(db_error)?;
        let run_rows = statement
            .query_map(params![owner_uid], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, u8>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, Option<String>>(12)?,
                    row.get::<_, i64>(13)? != 0,
                    row.get::<_, Option<i64>>(14)?,
                    row.get::<_, Option<i64>>(15)?,
                    row.get::<_, Option<String>>(16)?,
                ))
            })
            .map_err(db_error)?;
        let mut captures = Vec::new();
        for run in run_rows {
            let run = run.map_err(db_error)?;
            let segments = query_segments(&conn, &run.0)?;
            let retry_state: Option<(Option<i64>, Option<String>, String)> = conn
                .query_row(
                    "SELECT next_attempt_at_ms, last_error_code, state
                     FROM (
                        SELECT next_attempt_at_ms, last_error_code, state
                        FROM upload_jobs
                        WHERE capture_run_id=?1 AND state NOT IN ('succeeded','superseded')
                        UNION ALL
                        SELECT next_attempt_at_ms, last_error_code, state
                        FROM completion_jobs
                        WHERE capture_run_id=?1 AND state NOT IN ('succeeded','superseded')
                     )
                     ORDER BY next_attempt_at_ms
                     LIMIT 1",
                    params![run.0],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()
                .map_err(db_error)?;
            let retryable = retry_state.as_ref().is_some_and(|row| {
                matches!(row.2.as_str(), "pending" | "retry" | "leased" | "paused")
            });
            captures.push(CaptureEntry {
                owner_uid: run.2,
                meeting_id: run.1,
                capture_run_id: run.0,
                capture_fence: run.4,
                protocol_version: run.5,
                event_id: run.3,
                started_at_ms: run.7,
                state: run.6.clone(),
                completed: !matches!(run.6.as_str(), "capturing" | "capturing_interrupted"),
                complete_reason: run.10,
                total_duration_ms: run.11,
                finished_at_ms: run.8,
                retain_local_until_ms: run.9,
                completion_acked: run.13,
                acked_at_ms: run.14,
                local_audio_deleted_at_ms: run.15,
                manifest_sha256: run.12,
                next_retry_at_ms: retry_state.as_ref().and_then(|row| row.0),
                last_error_code: retry_state
                    .as_ref()
                    .and_then(|row| row.1.clone())
                    .or(run.16),
                retryable,
                segments,
            });
        }
        Ok(QueueSnapshot { captures })
    }
}
