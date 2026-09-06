//! SQLite-backed meeting evidence store.
//!
//! SQLite is the authority for capture state, durable network jobs, receipts,
//! retention, and the local audit trail. Encrypted audio remains in separate
//! digest-addressed files under `meeting-captures/`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

mod capture;
mod export;
mod jobs;
mod maintenance;
mod recovery;
#[cfg(test)]
mod tests;

pub const CAPTURES_DIR: &str = "meeting-captures";
pub const DATABASE_FILE: &str = "meeting-v2.sqlite3";
pub const PROTOCOL_VERSION: u8 = 2;
const SCHEMA_VERSION: i64 = 2;
const AUDIO_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_CAPTURE_DURATION_MS: i64 = 60 * 60 * 1000;
const JOB_LEASE_MS: i64 = 2 * 60 * 1000;
const RETRY_BASE_MS: i64 = 30 * 1000;
const RETRY_MAX_MS: i64 = 10 * 60 * 1000;
const REJOIN_HOLD_MS: i64 = 10 * 60 * 1000;

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentAudioMetrics {
    pub mic_rms_dbfs: f64,
    pub system_rms_dbfs: f64,
    pub mic_clipping_ratio: f64,
    pub system_clipping_ratio: f64,
    pub mic_zero_ratio: f64,
    pub system_zero_ratio: f64,
    pub mic_vad_speech_ms: i64,
    pub system_vad_speech_ms: i64,
    pub mic_device_id_hash: String,
    pub system_device_id_hash: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentEntry {
    pub seq: u32,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub uploaded: bool,
    pub incomplete: bool,
    pub content_sha256: String,
    pub encrypted_sha256: String,
    pub byte_length: u64,
    pub encrypted_byte_length: u64,
    pub channel_count: u8,
    pub sample_rate_hz: u32,
    pub local_present: bool,
    pub state: String,
    pub metrics: SegmentAudioMetrics,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureEntry {
    pub owner_uid: String,
    pub meeting_id: String,
    pub capture_run_id: String,
    pub capture_fence: i64,
    pub protocol_version: u8,
    pub event_id: String,
    pub started_at_ms: i64,
    pub state: String,
    pub completed: bool,
    pub complete_reason: String,
    pub total_duration_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub retain_local_until_ms: Option<i64>,
    pub completion_acked: bool,
    pub acked_at_ms: Option<i64>,
    pub local_audio_deleted_at_ms: Option<i64>,
    pub manifest_sha256: Option<String>,
    pub next_retry_at_ms: Option<i64>,
    pub last_error_code: Option<String>,
    pub retryable: bool,
    pub segments: Vec<SegmentEntry>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub captures: Vec<CaptureEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentRecoveryMetadata {
    pub schema_version: u8,
    pub encryption_version: u8,
    pub owner_uid: String,
    pub meeting_id: String,
    pub capture_run_id: String,
    pub capture_fence: i64,
    pub protocol_version: u8,
    pub event_id: String,
    pub started_at_ms: i64,
    pub runtime_instance_id: String,
    pub installation_id: String,
    pub seq: u32,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub incomplete: bool,
    pub content_sha256: String,
    pub encrypted_sha256: String,
    pub byte_length: u64,
    pub encrypted_byte_length: u64,
    pub channel_count: u8,
    pub sample_rate_hz: u32,
    pub metrics: SegmentAudioMetrics,
}

impl SegmentRecoveryMetadata {
    pub fn aad(&self) -> Vec<u8> {
        format!(
            "aura-meeting-v2\0{}\0{}\0{}\0{}\0{}\0{}",
            self.owner_uid,
            self.meeting_id,
            self.capture_run_id,
            self.capture_fence,
            self.seq,
            self.content_sha256,
        )
        .into_bytes()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueJobLease {
    pub job_id: String,
    pub lease_token: String,
    pub kind: String,
    pub meeting_id: String,
    pub capture_run_id: String,
    pub capture_fence: i64,
    pub protocol_version: u8,
    pub event_id: String,
    pub seq: Option<u32>,
    pub start_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub incomplete: Option<bool>,
    pub content_sha256: Option<String>,
    pub byte_length: Option<u64>,
    pub channel_count: Option<u8>,
    pub sample_rate_hz: Option<u32>,
    pub manifest_sha256: Option<String>,
    pub segment_count: Option<u32>,
    pub total_duration_ms: Option<i64>,
    pub reason: Option<String>,
    pub segment_digests: Vec<String>,
    pub manifest_segments: Vec<CompletionSegment>,
    pub attempt_count: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionSegment {
    pub seq: u32,
    pub start_ms: i64,
    pub duration_ms: i64,
    pub incomplete: bool,
    pub content_sha256: String,
    pub byte_length: u64,
    pub channel_count: u8,
    pub sample_rate_hz: u32,
    pub metrics: SegmentAudioMetrics,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadReceipt {
    pub receipt_id: String,
    pub object: String,
    pub generation: String,
    pub content_sha256: String,
    pub byte_length: u64,
    pub accepted_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletionReceipt {
    pub receipt_id: String,
    pub manifest_sha256: String,
    pub accepted_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobFailureResult {
    pub state: String,
    pub next_attempt_at_ms: Option<i64>,
    pub retryable: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRecording {
    pub meeting_id: String,
    pub capture_run_id: String,
    pub event_id: String,
    pub state: String,
    pub started_at_ms: i64,
    pub finished_at_ms: Option<i64>,
    pub retain_local_until_ms: Option<i64>,
    pub segment_count: u32,
    pub byte_length: u64,
    pub exportable: bool,
    pub deletion_state: Option<String>,
    pub last_error_code: Option<String>,
}

/// Where and how `Store::export_bundle` writes a bundle.
pub struct ExportRequest<'a> {
    pub destination_root: &'a Path,
    pub include_audio: bool,
    pub sanitized_log_lines: &'a [String],
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub path: String,
    pub segment_count: u32,
    pub included_audio: bool,
}

#[derive(Clone, Debug)]
pub struct StoredSegment {
    pub metadata: SegmentRecoveryMetadata,
    pub local_path: PathBuf,
    pub metadata_path: Option<PathBuf>,
    pub local_present: bool,
    pub state: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationReport {
    pub recovered_orphans: u32,
    pub missing_files: u32,
    pub integrity_failures: u32,
    pub quarantined_files: u32,
    pub split_brain_conflicts: u32,
}

#[derive(Clone, Debug)]
pub struct BeginCapture {
    pub meeting_id: String,
    pub capture_run_id: String,
    pub capture_fence: i64,
    pub protocol_version: u8,
    pub owner_uid: String,
    pub event_id: String,
    pub started_at_ms: i64,
    pub runtime_instance_id: String,
    pub installation_id: String,
}

/// Identity of one capture run, threaded from the start command through the
/// engine to every persistence call, so the same-typed identity values can
/// never be passed in a swapped order. `runtime_instance_id` names the runtime
/// performing the action (engine or recovery), not necessarily the runtime
/// that originally started the run.
#[derive(Clone, Debug)]
pub struct CaptureRunRef {
    pub owner_uid: String,
    pub meeting_id: String,
    pub capture_run_id: String,
    pub capture_fence: i64,
    pub event_id: String,
    pub runtime_instance_id: String,
    pub installation_id: String,
}

#[derive(Clone, Debug)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn initialize(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let mut conn = self.connect()?;
        self.initialize_schema(&mut conn)?;
        Ok(())
    }

    pub fn record_runtime_lease(
        &self,
        runtime_instance_id: &str,
        owns_runtime: bool,
    ) -> Result<(), String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        audit(
            &tx,
            if owns_runtime {
                "runtime_lease_acquired"
            } else {
                "runtime_lease_passive"
            },
            "",
            Some(runtime_instance_id),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            runtime_instance_id,
            &json!({
                "process_id": std::process::id(),
                "owns_runtime": owns_runtime,
            }),
        )?;
        tx.commit().map_err(db_error)
    }

    fn connect(&self) -> Result<Connection, String> {
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let conn = Connection::open(self.root.join(DATABASE_FILE)).map_err(db_error)?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(db_error)?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=FULL;
             PRAGMA foreign_keys=ON;
             PRAGMA wal_autocheckpoint=1000;",
        )
        .map_err(db_error)?;
        Ok(conn)
    }

    fn initialize_schema(&self, conn: &mut Connection) -> Result<(), String> {
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(db_error)?;
        if version > SCHEMA_VERSION {
            return Err(format!(
                "meeting evidence database schema {version} is newer than supported {SCHEMA_VERSION}"
            ));
        }
        if version == SCHEMA_VERSION {
            return Ok(());
        }
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS meetings (
                meeting_id TEXT PRIMARY KEY,
                owner_uid TEXT NOT NULL,
                event_id TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS capture_runs (
                capture_run_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL REFERENCES meetings(meeting_id),
                owner_uid TEXT NOT NULL,
                event_id TEXT NOT NULL,
                -- The fence segments on disk were ENCRYPTED under. It is part
                -- of the AEAD associated data, so it must never change once any
                -- segment exists: changing it makes the run own audio
                -- undecryptable.
                capture_fence INTEGER NOT NULL,
                -- The fence the SERVER is on, when it has moved ahead of ours.
                -- Wire only: sent in upload/completion headers so a re-issued
                -- lease stops rejecting us. NULL means same as capture_fence.
                server_capture_fence INTEGER,
                protocol_version INTEGER NOT NULL,
                runtime_instance_id TEXT NOT NULL,
                installation_id TEXT NOT NULL,
                state TEXT NOT NULL,
                started_at_ms INTEGER NOT NULL,
                finished_at_ms INTEGER,
                retain_local_until_ms INTEGER,
                complete_reason TEXT NOT NULL DEFAULT '',
                total_duration_ms INTEGER NOT NULL DEFAULT 0,
                manifest_sha256 TEXT,
                completion_acked INTEGER NOT NULL DEFAULT 0,
                acked_at_ms INTEGER,
                local_audio_deleted_at_ms INTEGER,
                last_error_code TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS capture_runs_owner_updated
               ON capture_runs(owner_uid, updated_at_ms DESC);
             CREATE TABLE IF NOT EXISTS segments (
                capture_run_id TEXT NOT NULL REFERENCES capture_runs(capture_run_id),
                meeting_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                start_ms INTEGER NOT NULL,
                duration_ms INTEGER NOT NULL,
                incomplete INTEGER NOT NULL,
                content_sha256 TEXT NOT NULL,
                encrypted_sha256 TEXT NOT NULL,
                byte_length INTEGER NOT NULL,
                encrypted_byte_length INTEGER NOT NULL,
                channel_count INTEGER NOT NULL,
                sample_rate_hz INTEGER NOT NULL,
                local_path TEXT NOT NULL,
                metadata_path TEXT,
                encryption_version INTEGER NOT NULL,
                state TEXT NOT NULL,
                local_present INTEGER NOT NULL,
                mic_rms_dbfs REAL NOT NULL,
                system_rms_dbfs REAL NOT NULL,
                mic_clipping_ratio REAL NOT NULL,
                system_clipping_ratio REAL NOT NULL,
                mic_zero_ratio REAL NOT NULL,
                system_zero_ratio REAL NOT NULL,
                mic_vad_speech_ms INTEGER NOT NULL,
                system_vad_speech_ms INTEGER NOT NULL,
                mic_device_id_hash TEXT NOT NULL,
                system_device_id_hash TEXT NOT NULL,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                PRIMARY KEY(capture_run_id, seq)
             );
             CREATE UNIQUE INDEX IF NOT EXISTS segments_local_path
               ON segments(local_path);
             CREATE TABLE IF NOT EXISTS upload_jobs (
                job_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                capture_run_id TEXT NOT NULL,
                seq INTEGER NOT NULL,
                content_sha256 TEXT NOT NULL,
                state TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at_ms INTEGER NOT NULL,
                last_error_code TEXT,
                last_error_at_ms INTEGER,
                lease_token TEXT,
                lease_expires_at_ms INTEGER,
                receipt_json TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                UNIQUE(capture_run_id, seq, content_sha256)
             );
             CREATE INDEX IF NOT EXISTS upload_jobs_due
               ON upload_jobs(state, next_attempt_at_ms);
             CREATE TABLE IF NOT EXISTS completion_jobs (
                job_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                capture_run_id TEXT NOT NULL,
                manifest_sha256 TEXT NOT NULL,
                state TEXT NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                next_attempt_at_ms INTEGER NOT NULL,
                last_error_code TEXT,
                last_error_at_ms INTEGER,
                lease_token TEXT,
                lease_expires_at_ms INTEGER,
                receipt_json TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL,
                UNIQUE(capture_run_id, manifest_sha256)
             );
             CREATE INDEX IF NOT EXISTS completion_jobs_due
               ON completion_jobs(state, next_attempt_at_ms);
             CREATE TABLE IF NOT EXISTS retention_jobs (
                job_id TEXT PRIMARY KEY,
                meeting_id TEXT NOT NULL,
                capture_run_id TEXT NOT NULL,
                reason TEXT NOT NULL,
                policy_version TEXT NOT NULL,
                state TEXT NOT NULL,
                due_at_ms INTEGER NOT NULL,
                attempt_count INTEGER NOT NULL DEFAULT 0,
                last_error_code TEXT,
                receipt_json TEXT,
                created_at_ms INTEGER NOT NULL,
                updated_at_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS retention_jobs_due
               ON retention_jobs(state, due_at_ms);
             CREATE TABLE IF NOT EXISTS audit_events (
                local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                event_type TEXT NOT NULL,
                occurred_at_ms INTEGER NOT NULL,
                recorded_at_ms INTEGER NOT NULL,
                actor_type TEXT NOT NULL,
                actor_identity_hash TEXT NOT NULL,
                runtime_instance_id TEXT,
                meeting_id TEXT,
                capture_run_id TEXT,
                capture_fence INTEGER,
                job_id TEXT,
                attempt INTEGER,
                lease_token_hash TEXT,
                previous_state TEXT,
                next_state TEXT,
                reason_code TEXT,
                correlation_id TEXT NOT NULL,
                causation_id TEXT,
                software_version TEXT NOT NULL,
                schema_version INTEGER NOT NULL,
                details_json TEXT NOT NULL
             );
             PRAGMA user_version=2;",
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
}

fn db_error(error: rusqlite::Error) -> String {
    format!("meeting evidence database error: {error}")
}

pub use crate::util::now_ms;

pub use crate::util::{random_hex, sha256_hex};

fn actor_hash(owner_uid: &str) -> String {
    if owner_uid.is_empty() {
        String::new()
    } else {
        sha256_hex(owner_uid)
    }
}

#[allow(clippy::too_many_arguments)]
fn audit(
    tx: &Transaction<'_>,
    event_type: &str,
    owner_uid: &str,
    runtime_instance_id: Option<&str>,
    meeting_id: Option<&str>,
    capture_run_id: Option<&str>,
    capture_fence: Option<i64>,
    job_id: Option<&str>,
    attempt: Option<u32>,
    lease_token: Option<&str>,
    previous_state: Option<&str>,
    next_state: Option<&str>,
    reason_code: Option<&str>,
    correlation_id: &str,
    details: &Value,
) -> Result<(), String> {
    let timestamp = now_ms();
    let event_id = random_hex(16)?;
    let lease_token_hash = lease_token.map(sha256_hex);
    tx.execute(
        "INSERT INTO audit_events (
            event_id, event_type, occurred_at_ms, recorded_at_ms,
            actor_type, actor_identity_hash, runtime_instance_id,
            meeting_id, capture_run_id, capture_fence, job_id, attempt,
            lease_token_hash, previous_state, next_state, reason_code,
            correlation_id, causation_id, software_version, schema_version,
            details_json
         ) VALUES (?1, ?2, ?3, ?3, 'desktop_user', ?4, ?5, ?6, ?7, ?8,
                   ?9, ?10, ?11, ?12, ?13, ?14, ?15, NULL, ?16, ?17, ?18)",
        params![
            event_id,
            event_type,
            timestamp,
            actor_hash(owner_uid),
            runtime_instance_id,
            meeting_id,
            capture_run_id,
            capture_fence,
            job_id,
            attempt,
            lease_token_hash,
            previous_state,
            next_state,
            reason_code,
            correlation_id,
            env!("CARGO_PKG_VERSION"),
            SCHEMA_VERSION,
            serde_json::to_string(details).map_err(|e| e.to_string())?,
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

pub fn validate_identity(value: &str, label: &str) -> Result<(), String> {
    let valid = !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-');
    if valid {
        Ok(())
    } else {
        Err(format!("invalid {label}"))
    }
}

fn final_relative_path(metadata: &SegmentRecoveryMetadata) -> PathBuf {
    PathBuf::from(&metadata.meeting_id)
        .join(&metadata.capture_run_id)
        .join(format!(
            "{:06}-{}.flac.enc",
            metadata.seq, metadata.content_sha256
        ))
}

fn metadata_relative_path(metadata: &SegmentRecoveryMetadata) -> PathBuf {
    PathBuf::from(&metadata.meeting_id)
        .join(&metadata.capture_run_id)
        .join(format!(
            "{:06}-{}.meta.json",
            metadata.seq, metadata.content_sha256
        ))
}

pub(super) use crate::fsx::{durable_rename, sync_directory};

fn write_new_synced(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())
}

fn manifest_digest(segments: &[SegmentEntry], total_duration_ms: i64, reason: &str) -> String {
    let value = json!({
        "schema_version": 2,
        "segments": segments.iter().map(|segment| json!({
            "seq": segment.seq,
            "content_sha256": segment.content_sha256,
            "byte_length": segment.byte_length,
            "start_ms": segment.start_ms,
            "duration_ms": segment.duration_ms,
            "incomplete": segment.incomplete,
            "channel_count": segment.channel_count,
            "sample_rate_hz": segment.sample_rate_hz,
        })).collect::<Vec<_>>(),
        "total_duration_ms": total_duration_ms,
        "reason": reason,
    });
    sha256_hex(serde_json::to_vec(&value).unwrap_or_default())
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn upload_job_id(meeting_id: &str, capture_run_id: &str, seq: u32, content_sha256: &str) -> String {
    format!("upload:{meeting_id}:{capture_run_id}:{seq}:{content_sha256}")
}

fn completion_job_id(meeting_id: &str, capture_run_id: &str, manifest_sha256: &str) -> String {
    format!("complete:{meeting_id}:{capture_run_id}:{manifest_sha256}")
}

fn validate_sha256(value: &str, label: &str) -> Result<(), String> {
    let valid = value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    if valid {
        Ok(())
    } else {
        Err(format!("invalid {label}"))
    }
}

fn query_segments(conn: &Connection, capture_run_id: &str) -> Result<Vec<SegmentEntry>, String> {
    let mut statement = conn
        .prepare(
            "SELECT
                s.seq, s.start_ms, s.duration_ms,
                EXISTS(
                    SELECT 1 FROM upload_jobs j
                    WHERE j.capture_run_id=s.capture_run_id
                      AND j.seq=s.seq
                      AND j.content_sha256=s.content_sha256
                      AND j.state='succeeded'
                ),
                s.incomplete, s.content_sha256, s.encrypted_sha256,
                s.byte_length, s.encrypted_byte_length, s.channel_count,
                s.sample_rate_hz, s.local_present, s.state,
                s.mic_rms_dbfs, s.system_rms_dbfs, s.mic_clipping_ratio,
                s.system_clipping_ratio, s.mic_zero_ratio, s.system_zero_ratio,
                s.mic_vad_speech_ms, s.system_vad_speech_ms,
                s.mic_device_id_hash, s.system_device_id_hash
             FROM segments s
             WHERE s.capture_run_id=?1
             ORDER BY s.seq",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![capture_run_id], map_segment)
        .map_err(db_error)?;
    rows.map(|row| row.map_err(db_error)).collect()
}

fn map_segment(row: &Row<'_>) -> rusqlite::Result<SegmentEntry> {
    Ok(SegmentEntry {
        seq: row.get::<_, i64>(0)? as u32,
        start_ms: row.get(1)?,
        duration_ms: row.get(2)?,
        uploaded: row.get::<_, i64>(3)? != 0,
        incomplete: row.get::<_, i64>(4)? != 0,
        content_sha256: row.get(5)?,
        encrypted_sha256: row.get(6)?,
        byte_length: row.get::<_, i64>(7)? as u64,
        encrypted_byte_length: row.get::<_, i64>(8)? as u64,
        channel_count: row.get::<_, i64>(9)? as u8,
        sample_rate_hz: row.get::<_, i64>(10)? as u32,
        local_present: row.get::<_, i64>(11)? != 0,
        state: row.get(12)?,
        metrics: SegmentAudioMetrics {
            mic_rms_dbfs: row.get(13)?,
            system_rms_dbfs: row.get(14)?,
            mic_clipping_ratio: row.get(15)?,
            system_clipping_ratio: row.get(16)?,
            mic_zero_ratio: row.get(17)?,
            system_zero_ratio: row.get(18)?,
            mic_vad_speech_ms: row.get(19)?,
            system_vad_speech_ms: row.get(20)?,
            mic_device_id_hash: row.get(21)?,
            system_device_id_hash: row.get(22)?,
        },
    })
}


fn full_jitter_delay(attempt_count: u32) -> Result<i64, String> {
    let exponent = attempt_count.saturating_sub(1).min(20);
    let ceiling = RETRY_BASE_MS
        .saturating_mul(1i64 << exponent)
        .clamp(1, RETRY_MAX_MS);
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    Ok((u64::from_le_bytes(bytes) % ceiling as u64) as i64)
}

fn query_segments_tx(
    tx: &Transaction<'_>,
    capture_run_id: &str,
) -> Result<Vec<SegmentEntry>, String> {
    let mut statement = tx
        .prepare(
            "SELECT
                s.seq, s.start_ms, s.duration_ms,
                EXISTS(
                    SELECT 1 FROM upload_jobs j
                    WHERE j.capture_run_id=s.capture_run_id
                      AND j.seq=s.seq
                      AND j.content_sha256=s.content_sha256
                      AND j.state='succeeded'
                ),
                s.incomplete, s.content_sha256, s.encrypted_sha256,
                s.byte_length, s.encrypted_byte_length, s.channel_count,
                s.sample_rate_hz, s.local_present, s.state,
                s.mic_rms_dbfs, s.system_rms_dbfs, s.mic_clipping_ratio,
                s.system_clipping_ratio, s.mic_zero_ratio, s.system_zero_ratio,
                s.mic_vad_speech_ms, s.system_vad_speech_ms,
                s.mic_device_id_hash, s.system_device_id_hash
             FROM segments s
             WHERE s.capture_run_id=?1
             ORDER BY s.seq",
        )
        .map_err(db_error)?;
    let rows = statement
        .query_map(params![capture_run_id], map_segment)
        .map_err(db_error)?;
    rows.map(|row| row.map_err(db_error)).collect()
}

fn map_stored_segment(row: &Row<'_>) -> rusqlite::Result<StoredSegment> {
    Ok(StoredSegment {
        metadata: SegmentRecoveryMetadata {
            schema_version: 2,
            encryption_version: row.get::<_, i64>(19)? as u8,
            owner_uid: row.get(0)?,
            meeting_id: row.get(1)?,
            capture_run_id: row.get(2)?,
            capture_fence: row.get(3)?,
            protocol_version: row.get::<_, i64>(4)? as u8,
            event_id: row.get(5)?,
            started_at_ms: row.get(6)?,
            runtime_instance_id: row.get(7)?,
            installation_id: row.get(8)?,
            seq: row.get::<_, i64>(9)? as u32,
            start_ms: row.get(10)?,
            duration_ms: row.get(11)?,
            incomplete: row.get::<_, i64>(12)? != 0,
            content_sha256: row.get(13)?,
            encrypted_sha256: row.get(14)?,
            byte_length: row.get::<_, i64>(15)? as u64,
            encrypted_byte_length: row.get::<_, i64>(16)? as u64,
            channel_count: row.get::<_, i64>(17)? as u8,
            sample_rate_hz: row.get::<_, i64>(18)? as u32,
            metrics: SegmentAudioMetrics {
                mic_rms_dbfs: row.get(24)?,
                system_rms_dbfs: row.get(25)?,
                mic_clipping_ratio: row.get(26)?,
                system_clipping_ratio: row.get(27)?,
                mic_zero_ratio: row.get(28)?,
                system_zero_ratio: row.get(29)?,
                mic_vad_speech_ms: row.get(30)?,
                system_vad_speech_ms: row.get(31)?,
                mic_device_id_hash: row.get(32)?,
                system_device_id_hash: row.get(33)?,
            },
        },
        local_path: PathBuf::from(row.get::<_, String>(20)?),
        metadata_path: row.get::<_, Option<String>>(21)?.map(PathBuf::from),
        local_present: row.get::<_, i64>(22)? != 0,
        state: row.get(23)?,
    })
}

