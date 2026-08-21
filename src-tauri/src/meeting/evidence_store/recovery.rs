use super::*;

impl Store {
    pub fn stored_segment(
        &self,
        owner_uid: &str,
        meeting_id: &str,
        capture_run_id: &str,
        seq: u32,
    ) -> Result<StoredSegment, String> {
        self.initialize()?;
        let conn = self.connect()?;
        let row = conn
            .query_row(
                "SELECT
                    r.owner_uid, r.meeting_id, r.capture_run_id,
                    r.capture_fence, r.protocol_version, r.event_id,
                    r.started_at_ms, r.runtime_instance_id, r.installation_id,
                    s.seq, s.start_ms, s.duration_ms, s.incomplete,
                    s.content_sha256, s.encrypted_sha256, s.byte_length,
                    s.encrypted_byte_length, s.channel_count, s.sample_rate_hz,
                    s.encryption_version, s.local_path, s.metadata_path,
                    s.local_present, s.state, s.mic_rms_dbfs,
                    s.system_rms_dbfs, s.mic_clipping_ratio,
                    s.system_clipping_ratio, s.mic_zero_ratio,
                    s.system_zero_ratio, s.mic_vad_speech_ms,
                    s.system_vad_speech_ms, s.mic_device_id_hash,
                    s.system_device_id_hash
                 FROM segments s
                 JOIN capture_runs r ON r.capture_run_id=s.capture_run_id
                 WHERE r.owner_uid=?1 AND r.meeting_id=?2
                   AND r.capture_run_id=?3 AND s.seq=?4",
                params![owner_uid, meeting_id, capture_run_id, seq],
                map_stored_segment,
            )
            .optional()
            .map_err(db_error)?
            .ok_or_else(|| "unknown segment".to_string())?;
        Ok(row)
    }

    pub fn all_stored_segments(&self) -> Result<Vec<StoredSegment>, String> {
        self.initialize()?;
        let conn = self.connect()?;
        let mut statement = conn
            .prepare(
                "SELECT
                    r.owner_uid, r.meeting_id, r.capture_run_id,
                    r.capture_fence, r.protocol_version, r.event_id,
                    r.started_at_ms, r.runtime_instance_id, r.installation_id,
                    s.seq, s.start_ms, s.duration_ms, s.incomplete,
                    s.content_sha256, s.encrypted_sha256, s.byte_length,
                    s.encrypted_byte_length, s.channel_count, s.sample_rate_hz,
                    s.encryption_version, s.local_path, s.metadata_path,
                    s.local_present, s.state, s.mic_rms_dbfs,
                    s.system_rms_dbfs, s.mic_clipping_ratio,
                    s.system_clipping_ratio, s.mic_zero_ratio,
                    s.system_zero_ratio, s.mic_vad_speech_ms,
                    s.system_vad_speech_ms, s.mic_device_id_hash,
                    s.system_device_id_hash
                 FROM segments s
                 JOIN capture_runs r ON r.capture_run_id=s.capture_run_id",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map([], map_stored_segment)
            .map_err(db_error)?;
        rows.map(|row| row.map_err(db_error)).collect()
    }

    pub fn mark_segment_unreadable(
        &self,
        segment: &StoredSegment,
        state: &str,
        reason: &str,
    ) -> Result<(), String> {
        if !matches!(state, "local_missing" | "integrity_failed") {
            return Err("invalid unreadable segment state".to_string());
        }
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now_ms();
        tx.execute(
            "UPDATE segments SET state=?3, local_present=?4, updated_at_ms=?5
             WHERE capture_run_id=?1 AND seq=?2",
            params![
                segment.metadata.capture_run_id,
                segment.metadata.seq,
                state,
                state != "local_missing",
                timestamp,
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE upload_jobs SET state='terminal', last_error_code=?3,
                last_error_at_ms=?4, updated_at_ms=?4
             WHERE capture_run_id=?1 AND seq=?2 AND state!='succeeded'",
            params![
                segment.metadata.capture_run_id,
                segment.metadata.seq,
                reason,
                timestamp,
            ],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE capture_runs SET state=?2, last_error_code=?3,
                updated_at_ms=?4 WHERE capture_run_id=?1",
            params![segment.metadata.capture_run_id, state, reason, timestamp,],
        )
        .map_err(db_error)?;
        audit(
            &tx,
            if state == "local_missing" {
                "segment_missing"
            } else {
                "segment_integrity_failed"
            },
            &segment.metadata.owner_uid,
            Some(&segment.metadata.runtime_instance_id),
            Some(&segment.metadata.meeting_id),
            Some(&segment.metadata.capture_run_id),
            Some(segment.metadata.capture_fence),
            None,
            None,
            None,
            Some(&segment.state),
            Some(state),
            Some(reason),
            &segment.metadata.capture_run_id,
            &json!({
                "seq": segment.metadata.seq,
                "content_sha256": segment.metadata.content_sha256,
                "local_path": path_text(&segment.local_path),
            }),
        )?;
        tx.commit().map_err(db_error)
    }

    pub fn import_recovered_orphan(
        &self,
        metadata: &SegmentRecoveryMetadata,
        local_path: &Path,
        metadata_path: &Path,
    ) -> Result<(), String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let run: Option<(String, String, i64, String)> = tx
            .query_row(
                "SELECT owner_uid, meeting_id, capture_fence, state
                 FROM capture_runs WHERE capture_run_id=?1",
                params![metadata.capture_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(db_error)?;
        let Some(run) = run else {
            return Err("orphan belongs to an unknown capture run".to_string());
        };
        if run.0 != metadata.owner_uid
            || run.1 != metadata.meeting_id
            || run.2 != metadata.capture_fence
        {
            return Err("orphan sidecar identity does not match the capture run".to_string());
        }
        let existing_digest: Option<String> = tx
            .query_row(
                "SELECT content_sha256 FROM segments
                 WHERE capture_run_id=?1 AND seq=?2",
                params![metadata.capture_run_id, metadata.seq],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(existing_digest) = existing_digest {
            if existing_digest == metadata.content_sha256 {
                tx.commit().map_err(db_error)?;
                return Ok(());
            }
            tx.rollback().map_err(db_error)?;
            self.record_split_brain(
                metadata,
                "recovered_orphan_digest_conflict",
                Some(&existing_digest),
            )?;
            return Err("orphan conflicts with an existing segment identity".to_string());
        }
        let timestamp = now_ms();
        tx.execute(
            "INSERT INTO segments(
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
                      ?11, ?12, ?13, ?14, ?15, 'recovered_orphan', 1,
                      ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24,
                      ?25, ?26, ?26)",
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
                path_text(local_path),
                path_text(metadata_path),
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
        audit(
            &tx,
            "orphan_recovered",
            &metadata.owner_uid,
            Some(&metadata.runtime_instance_id),
            Some(&metadata.meeting_id),
            Some(&metadata.capture_run_id),
            Some(metadata.capture_fence),
            Some(&job_id),
            None,
            None,
            None,
            Some("recovered_orphan"),
            Some("startup_reconciliation"),
            &metadata.capture_run_id,
            &json!({
                "seq": metadata.seq,
                "content_sha256": metadata.content_sha256,
                "local_path": path_text(local_path),
            }),
        )?;
        tx.commit().map_err(db_error)
    }

    /// Moves a run forward onto the fence the server reported, so uploads that
    /// were rejected as stale can proceed.
    ///
    /// Forward only. A backward fence means another writer owns the meeting and
    /// this evidence has forked; adopting it would corrupt the run. Segments are
    /// compared server-side on content identity rather than fence, so segments
    /// already accepted under the old fence stay valid beside the new ones.
    ///
    /// Without this, a fence the client could not match was permanent: every
    /// upload 409'd, the job retried on a timer forever, and the recording sat
    /// on disk until retention removed it.
    pub fn adopt_capture_fence(
        &self,
        owner_uid: &str,
        capture_run_id: &str,
        capture_fence: i64,
    ) -> Result<bool, String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        // Only the WIRE fence moves. capture_fence is baked into the AEAD
        // associated data of every segment already on disk, so advancing it
        // makes this run's own audio undecryptable (aead::Error) - the exact
        // failure that made the recording unreadable rather than merely unsent.
        let changed = tx
            .execute(
                "UPDATE capture_runs SET server_capture_fence=?3, last_error_code=NULL,
                    updated_at_ms=?4
                 WHERE capture_run_id=?1 AND owner_uid=?2
                   AND COALESCE(server_capture_fence, capture_fence)<?3
                   AND completion_acked=0
                   AND state NOT IN ('split_brain','local_missing','local_deleted',
                                     'capture_failed_integrity','delete_requested')",
                params![capture_run_id, owner_uid, capture_fence, now_ms()],
            )
            .map_err(db_error)?;
        if changed == 0 {
            tx.commit().map_err(db_error)?;
            return Ok(false);
        }
        // Let the blocked jobs run immediately rather than serving out a backoff
        // that was scheduled against a disagreement we just resolved.
        let timestamp = now_ms();
        for table in ["upload_jobs", "completion_jobs"] {
            tx.execute(
                &format!(
                    "UPDATE {table} SET state='pending', next_attempt_at_ms=?2,
                        lease_token=NULL, lease_expires_at_ms=NULL,
                        last_error_code=NULL, updated_at_ms=?2
                     WHERE capture_run_id=?1 AND state IN ('retry','paused','terminal')"
                ),
                params![capture_run_id, timestamp],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(true)
    }

    /// Revives every run this device recorded but could not hand off: a run
    /// parked in `needs_attention`, or one holding jobs that a prior failure
    /// classified terminal. Runs once when a session comes up, so ordinary
    /// backoff still governs the retries that follow.
    ///
    /// This exists because a stranded run had no route back on its own. Nothing
    /// rescheduled a terminal job, no notification fired for one, and the audio
    /// simply aged out of local retention still unsent.
    pub fn revive_stranded_runs(
        &self,
        owner_uid: &str,
        runtime_instance_id: &str,
    ) -> Result<usize, String> {
        self.initialize()?;
        let candidates: Vec<String> = {
            let conn = self.connect()?;
            let mut statement = conn
                .prepare(
                    "SELECT r.capture_run_id
                     FROM capture_runs r
                     WHERE r.owner_uid=?1
                       AND r.completion_acked=0
                       AND r.state NOT IN ('capturing','split_brain','local_missing',
                                           'local_deleted','capture_failed_integrity',
                                           'delete_requested')
                       AND (
                            r.state IN ('needs_attention','capturing_interrupted')
                            OR EXISTS(
                                SELECT 1 FROM upload_jobs u
                                WHERE u.capture_run_id=r.capture_run_id
                                  AND u.state='terminal'
                            )
                            OR EXISTS(
                                SELECT 1 FROM completion_jobs c
                                WHERE c.capture_run_id=r.capture_run_id
                                  AND c.state='terminal'
                            )
                       )",
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(params![owner_uid], |row| row.get::<_, String>(0))
                .map_err(db_error)?;
            let mut collected = Vec::new();
            for row in rows {
                collected.push(row.map_err(db_error)?);
            }
            collected
        };
        let mut revived = 0usize;
        for capture_run_id in candidates {
            if self.retry_capture_jobs(owner_uid, &capture_run_id, runtime_instance_id)? {
                revived += 1;
            }
        }
        Ok(revived)
    }

    pub fn local_recordings(&self, owner_uid: &str) -> Result<Vec<LocalRecording>, String> {
        self.initialize()?;
        let conn = self.connect()?;
        let mut statement = conn
            .prepare(
                "SELECT
                    r.meeting_id, r.capture_run_id, r.event_id, r.state,
                    r.started_at_ms, r.finished_at_ms, r.retain_local_until_ms,
                    COUNT(s.seq), COALESCE(SUM(s.byte_length), 0),
                    SUM(CASE WHEN s.local_present=1 THEN 1 ELSE 0 END),
                    (
                        SELECT state FROM retention_jobs j
                        WHERE j.capture_run_id=r.capture_run_id
                        ORDER BY j.created_at_ms DESC LIMIT 1
                    ),
                    r.last_error_code
                 FROM capture_runs r
                 LEFT JOIN segments s ON s.capture_run_id=r.capture_run_id
                 WHERE r.owner_uid=?1
                 GROUP BY r.capture_run_id
                 ORDER BY r.updated_at_ms DESC",
            )
            .map_err(db_error)?;
        let rows = statement
            .query_map(params![owner_uid], |row| {
                let local_count = row.get::<_, i64>(9)?;
                Ok(LocalRecording {
                    meeting_id: row.get(0)?,
                    capture_run_id: row.get(1)?,
                    event_id: row.get(2)?,
                    state: row.get(3)?,
                    started_at_ms: row.get(4)?,
                    finished_at_ms: row.get(5)?,
                    retain_local_until_ms: row.get(6)?,
                    segment_count: row.get::<_, i64>(7)? as u32,
                    byte_length: row.get::<_, i64>(8)? as u64,
                    exportable: local_count > 0,
                    deletion_state: row.get(10)?,
                    last_error_code: row.get(11)?,
                })
            })
            .map_err(db_error)?;
        rows.map(|row| row.map_err(db_error)).collect()
    }

    pub fn request_local_deletion(
        &self,
        owner_uid: &str,
        meeting_id: &str,
        capture_run_id: &str,
        runtime_instance_id: &str,
    ) -> Result<(), String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let run: (String, String, String, i64) = tx
            .query_row(
                "SELECT owner_uid, meeting_id, state, capture_fence
                 FROM capture_runs WHERE capture_run_id=?1",
                params![capture_run_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .map_err(|_| "unknown local recording".to_string())?;
        if run.0 != owner_uid || run.1 != meeting_id {
            return Err("unknown local recording".to_string());
        }
        if run.2 == "capturing" {
            return Err("an active recording cannot be deleted".to_string());
        }
        let timestamp = now_ms();
        let job_id = format!("delete:{meeting_id}:{capture_run_id}:{}", random_hex(8)?);
        tx.execute(
            "UPDATE upload_jobs SET state='canceled',
                last_error_code='user_delete_requested', updated_at_ms=?2
             WHERE capture_run_id=?1 AND state!='succeeded'",
            params![capture_run_id, timestamp],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE completion_jobs SET state='canceled',
                last_error_code='user_delete_requested', updated_at_ms=?2
             WHERE capture_run_id=?1 AND state!='succeeded'",
            params![capture_run_id, timestamp],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE capture_runs SET state='delete_requested',
                updated_at_ms=?2 WHERE capture_run_id=?1",
            params![capture_run_id, timestamp],
        )
        .map_err(db_error)?;
        tx.execute(
            "INSERT INTO retention_jobs(
                job_id, meeting_id, capture_run_id, reason, policy_version,
                state, due_at_ms, created_at_ms, updated_at_ms
             ) VALUES(?1, ?2, ?3, 'explicit_user_delete', 'local-audio-v1',
                      'pending', ?4, ?4, ?4)",
            params![job_id, meeting_id, capture_run_id, timestamp],
        )
        .map_err(db_error)?;
        audit(
            &tx,
            "delete_requested",
            owner_uid,
            Some(runtime_instance_id),
            Some(meeting_id),
            Some(capture_run_id),
            Some(run.3),
            Some(&job_id),
            None,
            None,
            Some(&run.2),
            Some("delete_requested"),
            Some("explicit_user_delete"),
            capture_run_id,
            &json!({ "scope": "local_audio" }),
        )?;
        tx.commit().map_err(db_error)
    }
}

