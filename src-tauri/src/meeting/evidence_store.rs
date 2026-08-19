//! SQLite-backed meeting evidence store.
//!
//! SQLite is the authority for capture state, durable network jobs, receipts,
//! retention, and the local audit trail. Encrypted audio remains in separate
//! digest-addressed files under `meeting-captures/`.

use std::collections::HashMap;
#[cfg(not(windows))]
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const CAPTURES_DIR: &str = "meeting-captures";
pub const DATABASE_FILE: &str = "meeting-v2.sqlite3";
const LEGACY_MANIFEST_FILE: &str = "manifest.json";
const SCHEMA_VERSION: i64 = 2;
const AUDIO_RETENTION_MS: i64 = 7 * 24 * 60 * 60 * 1000;
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
        self.migrate_schema(&mut conn)?;
        self.migrate_legacy_manifest(&mut conn)?;
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

    fn migrate_schema(&self, conn: &mut Connection) -> Result<(), String> {
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
        // Existing databases predate server_capture_fence. CREATE TABLE IF NOT
        // EXISTS above is a no-op for them, so add the column separately and
        // tolerate the duplicate-column error on a re-run.
        let has_column = tx
            .prepare("SELECT server_capture_fence FROM capture_runs LIMIT 1")
            .is_ok();
        if !has_column {
            tx.execute_batch("ALTER TABLE capture_runs ADD COLUMN server_capture_fence INTEGER;")
                .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)
    }
}

fn db_error(error: rusqlite::Error) -> String {
    format!("meeting evidence database error: {error}")
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

pub fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value).map_err(|e| e.to_string())?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

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

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows does not provide POSIX directory fsync semantics through
        // std::fs. Every publication rename uses MOVEFILE_WRITE_THROUGH in
        // durable_rename, which flushes the rename before returning.
        let _ = path;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| e.to_string())
    }
}

pub(super) fn durable_rename(from: &Path, to: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::PCWSTR;
        use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

        let from_wide = from
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let to_wide = to
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        unsafe {
            MoveFileExW(
                PCWSTR(from_wide.as_ptr()),
                PCWSTR(to_wide.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| error.to_string())
    }
    #[cfg(not(windows))]
    {
        std::fs::rename(from, to).map_err(|error| error.to_string())?;
        let parent = to
            .parent()
            .ok_or_else(|| "rename target has no parent".to_string())?;
        sync_directory(parent)
    }
}

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

#[derive(Clone, Default, Deserialize)]
struct LegacyManifest {
    #[serde(default)]
    meetings: HashMap<String, LegacyMeeting>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyMeeting {
    #[serde(default)]
    owner_uid: Option<String>,
    event_id: String,
    started_at_ms: i64,
    #[serde(default)]
    completed: bool,
    #[serde(default)]
    complete_reason: String,
    #[serde(default)]
    total_duration_ms: i64,
    #[serde(default)]
    finished_at_ms: Option<i64>,
    #[serde(default)]
    retain_local_until_ms: Option<i64>,
    #[serde(default)]
    completion_acked: bool,
    #[serde(default)]
    acked_at_ms: Option<i64>,
    #[serde(default)]
    local_audio_deleted_at_ms: Option<i64>,
    #[serde(default)]
    segments: Vec<LegacySegment>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacySegment {
    seq: u32,
    start_ms: i64,
    duration_ms: i64,
    #[serde(default)]
    uploaded: bool,
    #[serde(default)]
    incomplete: bool,
    #[serde(default)]
    content_sha256: String,
    #[serde(default)]
    encrypted_sha256: String,
    #[serde(default)]
    byte_length: u64,
    #[serde(default)]
    encrypted_byte_length: u64,
    #[serde(default = "default_channel_count")]
    channel_count: u8,
    #[serde(default = "default_sample_rate")]
    sample_rate_hz: u32,
    #[serde(default = "default_true")]
    local_present: bool,
}

fn default_channel_count() -> u8 {
    2
}

fn default_sample_rate() -> u32 {
    16_000
}

fn default_true() -> bool {
    true
}

impl Store {
    fn migrate_legacy_manifest(&self, conn: &mut Connection) -> Result<(), String> {
        let already_migrated: Option<String> = conn
            .query_row(
                "SELECT value FROM metadata WHERE key='legacy_manifest_migrated'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if already_migrated.is_some() {
            return Ok(());
        }

        let manifest_path = self.root.join(LEGACY_MANIFEST_FILE);
        if !manifest_path.exists() {
            conn.execute(
                "INSERT OR REPLACE INTO metadata(key, value) VALUES('legacy_manifest_migrated', ?1)",
                params![now_ms().to_string()],
            )
            .map_err(db_error)?;
            return Ok(());
        }

        let raw = std::fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
        let manifest: LegacyManifest = serde_json::from_str(&raw).map_err(|e| {
            format!(
                "legacy meeting manifest is invalid; refusing to replace it with an empty store: {e}"
            )
        })?;

        #[derive(Clone)]
        struct MigratedSegment {
            metadata: SegmentRecoveryMetadata,
            local_path: PathBuf,
            metadata_path: Option<PathBuf>,
            local_present: bool,
            legacy_uploaded: bool,
        }

        let mut migrated: Vec<(String, LegacyMeeting, String, Vec<MigratedSegment>)> = Vec::new();
        for (meeting_id, meeting) in &manifest.meetings {
            validate_identity(meeting_id, "meeting id")?;
            let owner_uid = meeting
                .owner_uid
                .clone()
                .unwrap_or_else(|| "legacy-unowned".to_string());
            let run_hash = sha256_hex(format!(
                "{meeting_id}\0{owner_uid}\0{}",
                meeting.started_at_ms
            ));
            let capture_run_id = format!("legacy_{}", &run_hash[..24]);
            let mut segments = Vec::new();
            for segment in &meeting.segments {
                let old_relative =
                    PathBuf::from(meeting_id).join(format!("{:04}.flac.enc", segment.seq));
                let old_path = self.root.join(&old_relative);
                let local_present = segment.local_present && old_path.exists();
                let encrypted = if local_present {
                    Some(std::fs::read(&old_path).map_err(|e| e.to_string())?)
                } else {
                    None
                };
                let encrypted_sha256 = if segment.encrypted_sha256.is_empty() {
                    encrypted.as_ref().map(sha256_hex).unwrap_or_default()
                } else {
                    segment.encrypted_sha256.clone()
                };
                let encrypted_byte_length = if segment.encrypted_byte_length == 0 {
                    encrypted.as_ref().map_or(0, |bytes| bytes.len() as u64)
                } else {
                    segment.encrypted_byte_length
                };
                let metadata = SegmentRecoveryMetadata {
                    schema_version: 2,
                    encryption_version: 1,
                    owner_uid: owner_uid.clone(),
                    meeting_id: meeting_id.clone(),
                    capture_run_id: capture_run_id.clone(),
                    capture_fence: 0,
                    protocol_version: 1,
                    event_id: meeting.event_id.clone(),
                    started_at_ms: meeting.started_at_ms,
                    runtime_instance_id: "legacy-migration".to_string(),
                    installation_id: "legacy".to_string(),
                    seq: segment.seq,
                    start_ms: segment.start_ms,
                    duration_ms: segment.duration_ms,
                    incomplete: segment.incomplete,
                    content_sha256: segment.content_sha256.clone(),
                    encrypted_sha256,
                    byte_length: segment.byte_length,
                    encrypted_byte_length,
                    channel_count: segment.channel_count,
                    sample_rate_hz: segment.sample_rate_hz,
                    metrics: SegmentAudioMetrics::default(),
                };

                let (relative_path, metadata_path) =
                    if local_present && !metadata.content_sha256.is_empty() {
                        let target_relative = final_relative_path(&metadata);
                        let target = self.root.join(&target_relative);
                        let sidecar_relative = metadata_relative_path(&metadata);
                        let sidecar = self.root.join(&sidecar_relative);
                        let parent = target
                            .parent()
                            .ok_or_else(|| "segment path has no parent".to_string())?;
                        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                        if target.exists() && target != old_path {
                            return Err(format!(
                                "legacy migration target already exists: {}",
                                target.display()
                            ));
                        }
                        if !sidecar.exists() {
                            let bytes =
                                serde_json::to_vec_pretty(&metadata).map_err(|e| e.to_string())?;
                            let tmp = sidecar.with_extension(format!(
                                "json.{}.{}.tmp",
                                std::process::id(),
                                random_hex(4)?
                            ));
                            write_new_synced(&tmp, &bytes)?;
                            durable_rename(&tmp, &sidecar)?;
                        }
                        if old_path.exists() && old_path != target {
                            durable_rename(&old_path, &target)?;
                        }
                        sync_directory(parent)?;
                        (target_relative, Some(sidecar_relative))
                    } else {
                        // Missing plaintext digests are never fabricated. Keep the
                        // legacy path and mark the row unverified.
                        (old_relative, None)
                    };
                segments.push(MigratedSegment {
                    metadata,
                    local_path: relative_path,
                    metadata_path,
                    local_present,
                    legacy_uploaded: segment.uploaded,
                });
            }
            migrated.push((
                meeting_id.clone(),
                meeting.clone(),
                capture_run_id,
                segments,
            ));
        }

        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let timestamp = now_ms();
        for (meeting_id, meeting, capture_run_id, segments) in &migrated {
            let owner_uid = meeting.owner_uid.as_deref().unwrap_or("legacy-unowned");
            tx.execute(
                "INSERT OR IGNORE INTO meetings(
                    meeting_id, owner_uid, event_id, created_at_ms, updated_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, ?5)",
                params![
                    meeting_id,
                    owner_uid,
                    meeting.event_id,
                    meeting.started_at_ms,
                    timestamp
                ],
            )
            .map_err(db_error)?;
            let state = if meeting.owner_uid.is_none() {
                "legacy_unowned"
            } else if meeting.local_audio_deleted_at_ms.is_some() {
                "local_deleted"
            } else if meeting.completed {
                "finalized_local"
            } else {
                "capturing_interrupted"
            };
            tx.execute(
                "INSERT OR IGNORE INTO capture_runs(
                    capture_run_id, meeting_id, owner_uid, event_id,
                    capture_fence, protocol_version, runtime_instance_id,
                    installation_id, state, started_at_ms, finished_at_ms,
                    retain_local_until_ms, complete_reason, total_duration_ms,
                    completion_acked, acked_at_ms, local_audio_deleted_at_ms,
                    created_at_ms, updated_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, 0, 1, 'legacy-migration',
                          'legacy', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                          ?13, ?6, ?14)",
                params![
                    capture_run_id,
                    meeting_id,
                    owner_uid,
                    meeting.event_id,
                    state,
                    meeting.started_at_ms,
                    meeting.finished_at_ms,
                    meeting.retain_local_until_ms,
                    meeting.complete_reason,
                    meeting.total_duration_ms,
                    meeting.completion_acked,
                    meeting.acked_at_ms,
                    meeting.local_audio_deleted_at_ms,
                    timestamp,
                ],
            )
            .map_err(db_error)?;

            for migrated_segment in segments {
                let metadata = &migrated_segment.metadata;
                let segment_state = if !migrated_segment.local_present {
                    "local_missing"
                } else if metadata.content_sha256.is_empty() {
                    "legacy_unverified"
                } else {
                    "local_ready"
                };
                tx.execute(
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
                              ?11, ?12, ?13, ?14, 1, ?15, ?16, 0, 0, 0, 0,
                              0, 0, 0, 0, '', '', ?17, ?17)",
                    params![
                        capture_run_id,
                        meeting_id,
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
                        path_text(&migrated_segment.local_path),
                        migrated_segment
                            .metadata_path
                            .as_ref()
                            .map(|path| path_text(path)),
                        segment_state,
                        migrated_segment.local_present,
                        timestamp,
                    ],
                )
                .map_err(db_error)?;
                if meeting.owner_uid.is_some()
                    && migrated_segment.local_present
                    && !metadata.content_sha256.is_empty()
                {
                    let job_id = upload_job_id(
                        meeting_id,
                        capture_run_id,
                        metadata.seq,
                        &metadata.content_sha256,
                    );
                    // A legacy uploaded boolean is not a receipt. Requeue the
                    // exact retained bytes instead of inventing success.
                    tx.execute(
                        "INSERT OR IGNORE INTO upload_jobs(
                            job_id, meeting_id, capture_run_id, seq,
                            content_sha256, state, next_attempt_at_ms,
                            last_error_code, created_at_ms, updated_at_ms
                         ) VALUES(?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?6, ?6)",
                        params![
                            job_id,
                            meeting_id,
                            capture_run_id,
                            metadata.seq,
                            metadata.content_sha256,
                            timestamp,
                            migrated_segment
                                .legacy_uploaded
                                .then_some("legacy_upload_receipt_missing"),
                        ],
                    )
                    .map_err(db_error)?;
                }
            }
            audit(
                &tx,
                "legacy_manifest_migrated",
                owner_uid,
                Some("legacy-migration"),
                Some(meeting_id),
                Some(capture_run_id),
                Some(0),
                None,
                None,
                None,
                None,
                Some(state),
                None,
                capture_run_id,
                &json!({ "segment_count": segments.len() }),
            )?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO metadata(key, value) VALUES('legacy_manifest_migrated', ?1)",
            params![timestamp.to_string()],
        )
        .map_err(db_error)?;
        tx.commit().map_err(db_error)?;

        let migrated_path = self.root.join("manifest.v1.migrated.json");
        if !migrated_path.exists() {
            durable_rename(&manifest_path, &migrated_path)?;
            sync_directory(&self.root)?;
        }
        Ok(())
    }
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

    fn record_split_brain(
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
        owner_uid: &str,
        meeting_id: &str,
        capture_run_id: &str,
        capture_fence: i64,
        runtime_instance_id: &str,
        total_duration_ms: i64,
        reason: &str,
    ) -> Result<String, String> {
        self.initialize()?;
        let mut conn = self.connect()?;
        let segments = query_segments(&conn, capture_run_id)?;
        let manifest_sha256 = manifest_digest(&segments, total_duration_ms, reason);
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let run: (String, String, i64, String, Option<i64>) = tx
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
        if run.0 != owner_uid || run.1 != meeting_id || run.2 != capture_fence {
            return Err("capture finalization identity mismatch".to_string());
        }
        if matches!(
            run.3.as_str(),
            "split_brain" | "local_missing" | "local_deleted"
        ) {
            return Err(format!("capture cannot finalize from {}", run.3));
        }
        let finished_at_ms = now_ms();
        let retain_until = run
            .4
            .unwrap_or(0)
            .max(finished_at_ms.saturating_add(AUDIO_RETENTION_MS));
        let integrity_failed = reason == "capture_failed"
            || segments.iter().any(|segment| {
                !segment.local_present
                    || matches!(
                        segment.state.as_str(),
                        "local_missing" | "split_brain" | "legacy_unverified"
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
            Some(&run.3),
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
                              'local_missing','split_brain','legacy_unverified'
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
            if job.8 >= 2 {
                "upload_accepted"
            } else {
                "upload_accepted_legacy"
            },
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
        let changed = uploads + completions + restored > 0;
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
}

fn full_jitter_delay(attempt_count: u32) -> Result<i64, String> {
    let exponent = attempt_count.saturating_sub(1).min(20);
    let ceiling = RETRY_BASE_MS
        .saturating_mul(1i64 << exponent)
        .min(RETRY_MAX_MS)
        .max(1);
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
                            r.state='needs_attention'
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

impl Store {
    /// Moves capture runs that a DEAD process left in `capturing` over to
    /// `capturing_interrupted`. Nothing else did this: that state was only ever
    /// written by the legacy v1 migration, and `reconcile` below rebuilds
    /// orphaned segment FILES, never the run rows. A run stranded in
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
            if segment.metadata.content_sha256.is_empty() {
                // A pre-digest legacy row is preserved but cannot be promoted
                // to verified evidence.
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
            | "manifest.v1.migrated.json"
            | LEGACY_MANIFEST_FILE
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

    fn audit_export(&self, capture_run_id: &str) -> Result<Vec<Value>, String> {
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

#[cfg(test)]
mod tests {
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
    fn invalid_legacy_manifest_fails_closed_and_remains_on_disk() {
        let directory = TestDirectory::new();
        let manifest = directory.0.join(LEGACY_MANIFEST_FILE);
        std::fs::write(&manifest, b"{not-json").unwrap();
        let error = directory.store().initialize().unwrap_err();
        assert!(error.contains("refusing to replace it with an empty store"));
        assert_eq!(std::fs::read(&manifest).unwrap(), b"{not-json");
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
}
