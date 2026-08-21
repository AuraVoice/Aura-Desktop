use super::*;

impl Store {
    /// Moves capture runs that a DEAD process left in `capturing` over to
    /// `capturing_interrupted`. Reconciliation rebuilds orphaned segment files,
    /// never the run rows. A run stranded in
    /// `capturing` is permanently stuck - it reports itself as a live
    /// recording, and `request_local_deletion` refuses to remove it - so a
    /// single crash mid-capture leaves an undeletable ghost forever.
    ///
    /// Only runs owned by a DIFFERENT runtime instance are touched. This
    /// method runs at startup under the runtime lease, so a row still carrying
    /// our own instance id belongs to a capture this process is running.
    pub fn interrupt_orphaned_captures(
        &self,
        runtime_instance_id: &str,
    ) -> Result<u32, String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let orphans: Vec<(String, String, String, i64)> = {
            let mut statement = tx
                .prepare(
                    "SELECT capture_run_id, meeting_id, owner_uid, capture_fence
                     FROM capture_runs
                     WHERE state='capturing' AND runtime_instance_id!=?1",
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(params![runtime_instance_id], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .map_err(db_error)?;
            rows.map(|row| row.map_err(db_error))
                .collect::<Result<Vec<_>, String>>()?
        };
        let timestamp = now_ms();
        for (capture_run_id, meeting_id, owner_uid, capture_fence) in &orphans {
            tx.execute(
                "UPDATE capture_runs
                 SET state='capturing_interrupted', updated_at_ms=?2
                 WHERE capture_run_id=?1",
                params![capture_run_id, timestamp],
            )
            .map_err(db_error)?;
            audit(
                &tx,
                "capture_run.interrupted",
                owner_uid,
                Some(runtime_instance_id),
                Some(meeting_id),
                Some(capture_run_id),
                Some(*capture_fence),
                None,
                None,
                None,
                Some("capturing"),
                Some("capturing_interrupted"),
                Some("startup_orphaned_capture"),
                "",
                &json!({}),
            )?;
        }
        tx.commit().map_err(db_error)?;
        Ok(orphans.len() as u32)
    }

    pub fn reconcile<F>(&self, decrypt: F) -> Result<ReconciliationReport, String>
    where
        F: Fn(&SegmentRecoveryMetadata, &[u8]) -> Result<Vec<u8>, String>,
    {
        self.initialize()?;
        let mut report = ReconciliationReport::default();
        let stored = self.all_stored_segments()?;
        let mut known_paths = std::collections::HashSet::new();
        for segment in &stored {
            known_paths.insert(path_text(&segment.local_path));
            if let Some(metadata_path) = &segment.metadata_path {
                known_paths.insert(path_text(metadata_path));
            }
            if !segment.local_present {
                continue;
            }
            let path = self.root.join(&segment.local_path);
            if !path.exists() {
                self.mark_segment_unreadable(segment, "local_missing", "startup_row_without_file")?;
                report.missing_files += 1;
                continue;
            }
            let encrypted = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    self.mark_segment_unreadable(
                        segment,
                        "local_missing",
                        "startup_segment_read_failed",
                    )?;
                    report.missing_files += 1;
                    continue;
                }
            };
            if !segment.metadata.encrypted_sha256.is_empty()
                && (encrypted.len() as u64 != segment.metadata.encrypted_byte_length
                    || sha256_hex(&encrypted) != segment.metadata.encrypted_sha256)
            {
                self.mark_segment_unreadable(
                    segment,
                    "integrity_failed",
                    "startup_ciphertext_integrity_failed",
                )?;
                report.integrity_failures += 1;
                continue;
            }
            match decrypt(&segment.metadata, &encrypted) {
                Ok(plain)
                    if plain.len() as u64 == segment.metadata.byte_length
                        && sha256_hex(&plain) == segment.metadata.content_sha256 => {}
                _ => {
                    self.mark_segment_unreadable(
                        segment,
                        "integrity_failed",
                        "startup_plaintext_integrity_failed",
                    )?;
                    report.integrity_failures += 1;
                }
            }
        }

        let files = walk_files(&self.root)?;
        for path in files {
            let relative = path
                .strip_prefix(&self.root)
                .map_err(|e| e.to_string())?
                .to_path_buf();
            let relative_text = path_text(&relative);
            if should_ignore_reconciliation_path(&relative) || known_paths.contains(&relative_text)
            {
                continue;
            }
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or_default();
            if name.ends_with(".tmp") {
                quarantine_file(&self.root, &path)?;
                self.record_reconciliation_event(
                    "temporary_file_quarantined",
                    "startup_incomplete_publication",
                    &relative,
                )?;
                report.quarantined_files += 1;
                continue;
            }
            if !name.ends_with(".flac.enc") {
                continue;
            }

            let sidecar_name = name.trim_end_matches(".flac.enc").to_string() + ".meta.json";
            let sidecar = path
                .parent()
                .ok_or_else(|| "orphan path has no parent".to_string())?
                .join(sidecar_name);
            if !sidecar.exists() {
                quarantine_file(&self.root, &path)?;
                self.record_reconciliation_event(
                    "orphan_quarantined",
                    "missing_recovery_sidecar",
                    &relative,
                )?;
                report.quarantined_files += 1;
                continue;
            }
            let metadata: SegmentRecoveryMetadata = match std::fs::read_to_string(&sidecar)
                .map_err(|e| e.to_string())
                .and_then(|raw| serde_json::from_str(&raw).map_err(|e| e.to_string()))
            {
                Ok(metadata) => metadata,
                Err(_) => {
                    quarantine_file(&self.root, &path)?;
                    quarantine_file(&self.root, &sidecar)?;
                    self.record_reconciliation_event(
                        "orphan_quarantined",
                        "invalid_recovery_sidecar",
                        &relative,
                    )?;
                    report.quarantined_files += 2;
                    continue;
                }
            };
            let expected_relative = final_relative_path(&metadata);
            if expected_relative != relative {
                quarantine_file(&self.root, &path)?;
                quarantine_file(&self.root, &sidecar)?;
                self.record_reconciliation_event(
                    "orphan_quarantined",
                    "sidecar_path_identity_mismatch",
                    &relative,
                )?;
                report.quarantined_files += 2;
                continue;
            }
            let encrypted = std::fs::read(&path).map_err(|e| e.to_string())?;
            let verified = encrypted.len() as u64 == metadata.encrypted_byte_length
                && sha256_hex(&encrypted) == metadata.encrypted_sha256
                && decrypt(&metadata, &encrypted).is_ok_and(|plain| {
                    plain.len() as u64 == metadata.byte_length
                        && sha256_hex(&plain) == metadata.content_sha256
                });
            if !verified {
                quarantine_file(&self.root, &path)?;
                quarantine_file(&self.root, &sidecar)?;
                self.record_reconciliation_event(
                    "orphan_quarantined",
                    "orphan_integrity_failed",
                    &relative,
                )?;
                report.quarantined_files += 2;
                report.integrity_failures += 1;
                continue;
            }
            let sidecar_relative = sidecar
                .strip_prefix(&self.root)
                .map_err(|e| e.to_string())?;
            match self.import_recovered_orphan(&metadata, &relative, sidecar_relative) {
                Ok(()) => report.recovered_orphans += 1,
                Err(error) if error.contains("conflicts") => {
                    report.split_brain_conflicts += 1;
                }
                Err(error) => return Err(error),
            }
        }
        Ok(report)
    }

    fn record_reconciliation_event(
        &self,
        event_type: &str,
        reason: &str,
        relative_path: &Path,
    ) -> Result<(), String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        audit(
            &tx,
            event_type,
            "",
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            Some(reason),
            &random_hex(16)?,
            &json!({ "relative_path": path_text(relative_path) }),
        )?;
        tx.commit().map_err(db_error)
    }

    pub fn run_retention_jobs(&self, runtime_instance_id: &str) -> Result<usize, String> {
        self.initialize()?;
        if !self.retention_clock_is_sane()? {
            return Ok(0);
        }
        let conn = self.connect()?;
        let timestamp = now_ms();
        let mut statement = conn
            .prepare(
                "SELECT j.job_id, j.meeting_id, j.capture_run_id, j.reason,
                        j.attempt_count, r.owner_uid, r.capture_fence,
                        r.finished_at_ms
                 FROM retention_jobs j
                 JOIN capture_runs r ON r.capture_run_id=j.capture_run_id
                 WHERE j.state IN ('pending','retry')
                   AND j.due_at_ms<=?1
                   AND (
                        j.reason='explicit_user_delete'
                        OR (
                            r.finished_at_ms IS NOT NULL
                            AND ?1>=r.finished_at_ms + ?2
                            -- Policy retention assumes the cloud already has a
                            -- copy. Until the server acknowledges completion this
                            -- encrypted audio is the ONLY copy that exists, and
                            -- deleting it destroys the recording outright. An
                            -- explicit user delete still wins.
                            AND r.completion_acked!=0
                        )
                   )
                 ORDER BY j.due_at_ms",
            )
            .map_err(db_error)?;
        let jobs = statement
            .query_map(params![timestamp, AUDIO_RETENTION_MS], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)? as u32,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<i64>>(7)?,
                ))
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        drop(statement);
        drop(conn);

        let mut completed = 0;
        for job in jobs {
            if self.execute_retention_job(
                &job.0,
                &job.1,
                &job.2,
                &job.3,
                job.4,
                &job.5,
                job.6,
                runtime_instance_id,
            )? {
                completed += 1;
            }
        }
        Ok(completed)
    }

    #[allow(clippy::too_many_arguments)]
    fn execute_retention_job(
        &self,
        job_id: &str,
        meeting_id: &str,
        capture_run_id: &str,
        reason: &str,
        previous_attempt_count: u32,
        owner_uid: &str,
        capture_fence: i64,
        runtime_instance_id: &str,
    ) -> Result<bool, String> {
        let attempt = previous_attempt_count.saturating_add(1);
        {
            let mut conn = self.connect()?;
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let changed = tx
                .execute(
                    "UPDATE retention_jobs SET state='deleting',
                        attempt_count=?2, updated_at_ms=?3
                     WHERE job_id=?1 AND state IN ('pending','retry')",
                    params![job_id, attempt, now_ms()],
                )
                .map_err(db_error)?;
            if changed != 1 {
                tx.rollback().map_err(db_error)?;
                return Ok(false);
            }
            audit(
                &tx,
                "local_delete_started",
                owner_uid,
                Some(runtime_instance_id),
                Some(meeting_id),
                Some(capture_run_id),
                Some(capture_fence),
                Some(job_id),
                Some(attempt),
                None,
                None,
                Some("deleting"),
                Some(reason),
                capture_run_id,
                &json!({ "policy_version": "local-audio-v1" }),
            )?;
            tx.commit().map_err(db_error)?;
        }

        let segments = self
            .all_stored_segments()?
            .into_iter()
            .filter(|segment| segment.metadata.capture_run_id == capture_run_id)
            .collect::<Vec<_>>();
        let mut receipt_files = Vec::new();
        let mut failure: Option<String> = None;
        for segment in &segments {
            for relative_path in
                std::iter::once(&segment.local_path).chain(segment.metadata_path.iter())
            {
                let path = self.root.join(relative_path);
                let result = if path.exists() {
                    std::fs::remove_file(&path).map(|_| "deleted")
                } else {
                    Ok("already_absent")
                };
                match result {
                    Ok(result) => receipt_files.push(json!({
                        "relative_path": path_text(relative_path),
                        "content_sha256": segment.metadata.content_sha256,
                        "encrypted_sha256": segment.metadata.encrypted_sha256,
                        "result": result,
                    })),
                    Err(error) => {
                        failure = Some(format!("local_delete_failed: {error}"));
                        receipt_files.push(json!({
                            "relative_path": path_text(relative_path),
                            "content_sha256": segment.metadata.content_sha256,
                            "encrypted_sha256": segment.metadata.encrypted_sha256,
                            "result": "failed",
                        }));
                        break;
                    }
                }
            }
            if failure.is_some() {
                break;
            }
        }
        if let Some(parent) = segments.first().and_then(|segment| {
            self.root
                .join(&segment.local_path)
                .parent()
                .map(Path::to_path_buf)
        }) {
            let _ = sync_directory(&parent);
        }

        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now_ms();
        if let Some(error) = failure {
            let next_attempt = timestamp.saturating_add(full_jitter_delay(attempt)?);
            tx.execute(
                "UPDATE retention_jobs SET state='retry',
                    last_error_code='local_delete_failed',
                    due_at_ms=?2, updated_at_ms=?3
                 WHERE job_id=?1 AND state='deleting'",
                params![job_id, next_attempt, timestamp],
            )
            .map_err(db_error)?;
            audit(
                &tx,
                "local_delete_failed",
                owner_uid,
                Some(runtime_instance_id),
                Some(meeting_id),
                Some(capture_run_id),
                Some(capture_fence),
                Some(job_id),
                Some(attempt),
                None,
                Some("deleting"),
                Some("retry"),
                Some("local_delete_failed"),
                capture_run_id,
                &json!({
                    "error": error,
                    "next_attempt_at_ms": next_attempt,
                    "files": receipt_files,
                }),
            )?;
            tx.commit().map_err(db_error)?;
            return Ok(false);
        }

        let receipt = json!({
            "receipt_id": random_hex(16)?,
            "meeting_id": meeting_id,
            "capture_run_id": capture_run_id,
            "reason": reason,
            "policy_version": "local-audio-v1",
            "deleted_at_ms": timestamp,
            "files": receipt_files,
        });
        tx.execute(
            "UPDATE segments SET state='local_deleted', local_present=0,
                updated_at_ms=?2 WHERE capture_run_id=?1",
            params![capture_run_id, timestamp],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE capture_runs SET state='local_deleted',
                local_audio_deleted_at_ms=?2, updated_at_ms=?2
             WHERE capture_run_id=?1",
            params![capture_run_id, timestamp],
        )
        .map_err(db_error)?;
        tx.execute(
            "UPDATE retention_jobs SET state='succeeded', receipt_json=?2,
                last_error_code=NULL, updated_at_ms=?3
             WHERE job_id=?1 AND state='deleting'",
            params![
                job_id,
                serde_json::to_string(&receipt).map_err(|e| e.to_string())?,
                timestamp,
            ],
        )
        .map_err(db_error)?;
        audit(
            &tx,
            "local_delete_completed",
            owner_uid,
            Some(runtime_instance_id),
            Some(meeting_id),
            Some(capture_run_id),
            Some(capture_fence),
            Some(job_id),
            Some(attempt),
            None,
            Some("deleting"),
            Some("succeeded"),
            Some(reason),
            capture_run_id,
            &receipt,
        )?;
        tx.commit().map_err(db_error)?;
        Ok(true)
    }

    fn retention_clock_is_sane(&self) -> Result<bool, String> {
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now_ms();
        let previous: Option<i64> = tx
            .query_row(
                "SELECT value FROM metadata WHERE key='last_retention_check_ms'",
                [],
                |row| {
                    let value: String = row.get(0)?;
                    Ok(value.parse::<i64>().unwrap_or(0))
                },
            )
            .optional()
            .map_err(db_error)?;
        tx.execute(
            "INSERT OR REPLACE INTO metadata(key, value)
             VALUES('last_retention_check_ms', ?1)",
            params![timestamp.to_string()],
        )
        .map_err(db_error)?;
        let sane = previous.is_none_or(|last| {
            timestamp >= last && timestamp.saturating_sub(last) <= 24 * 60 * 60 * 1000
        });
        if !sane {
            audit(
                &tx,
                "retention_clock_anomaly",
                "",
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                Some("wall_clock_jump"),
                &random_hex(16)?,
                &json!({ "previous_ms": previous, "current_ms": timestamp }),
            )?;
        }
        tx.commit().map_err(db_error)?;
        Ok(sane)
    }
}

fn walk_files(root: &Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            if file_type.is_dir() {
                if path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| matches!(name, "quarantine" | "exports"))
                {
                    continue;
                }
                pending.push(path);
            } else if file_type.is_file() {
                files.push(path);
            }
        }
    }
    Ok(files)
}

fn should_ignore_reconciliation_path(relative: &Path) -> bool {
    let name = relative
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    matches!(
        name,
        DATABASE_FILE
            | "meeting-v2.sqlite3-wal"
            | "meeting-v2.sqlite3-shm"
            | "key.bin"
    ) || name.ends_with(".meta.json")
}

fn quarantine_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let relative = path.strip_prefix(root).map_err(|e| e.to_string())?;
    let quarantine_root = root.join("quarantine").join(now_ms().to_string());
    let mut destination = quarantine_root.join(relative);
    if destination.exists() {
        let suffix = random_hex(4)?;
        let name = destination
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("artifact");
        destination.set_file_name(format!("{name}.{suffix}"));
    }
    let parent = destination
        .parent()
        .ok_or_else(|| "quarantine path has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    durable_rename(path, &destination)?;
    sync_directory(parent)?;
    Ok(destination)
}

