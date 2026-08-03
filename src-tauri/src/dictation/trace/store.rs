//! Trace storage: encrypted at rest, bounded, and deletable.
//!
//! Layout, under the app's local data directory:
//!
//! ```text
//! dictation/
//!   key.bin          <- DPAPI-wrapped AES key, owned by vocab.rs
//!   vocab.enc
//!   corrections.enc
//!   traces/          <- everything this module owns
//!     settings.json  <- the opt-in switch, no user content
//!     index.enc      <- every TraceRecord
//!     audio/<id>.wav.enc
//! ```
//!
//! The key is `vocab.rs`'s, reused rather than minted fresh, and that direction
//! matters: `traces/` is a subdirectory, so "delete all my training data"
//! removes `traces/` and cannot touch `key.bin`. The inverse arrangement is
//! exactly the failure `vocab.rs`'s own header warns about, where deleting one
//! feature's data silently bricks another's.
//!
//! One process-wide lock serialises every index read-modify-write, because the
//! trace worker and the settings page's commands both reach in here. Without it
//! a delete issued while an observation was being written would lose whichever
//! landed first.

#![cfg(windows)]

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::record::{ShareState, TraceRecord, TraceState, TraceSummary, TRACE_SCHEMA_VERSION};
use super::settings::{MAX_AUDIO_BYTES, MAX_TRACES};

const TRACES_DIR: &str = "traces";
const AUDIO_DIR: &str = "audio";
const INDEX_FILE: &str = "index.enc";

#[derive(Default, Serialize, Deserialize)]
struct TraceIndex {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    traces: Vec<TraceRecord>,
    /// Ids of traces that reached the server and have since been deleted here.
    ///
    /// The record itself is gone the instant the user asks - that is the point
    /// of a delete - so the id has to survive on its own until the server
    /// confirms. Without this list, deleting a shared recording would remove the
    /// local copy and quietly leave the uploaded one, which would make the
    /// delete button a lie.
    #[serde(default)]
    tombstones: Vec<String>,
}

/// Ceiling on unsent tombstones. Reached only if the server is unreachable for a
/// very long time while the user deletes a lot; past it the oldest are dropped,
/// because an unbounded list of ids in an encrypted blob is its own problem.
const MAX_TOMBSTONES: usize = 2_000;

/// Guards every read-modify-write of the index. A `OnceLock` rather than a
/// managed Tauri state so `store` functions stay callable from anywhere without
/// threading a handle through.
fn index_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// The trace directory. Deliberately does NOT create it: a user who has never
/// switched the feature on must not end up with a directory implying they did.
/// Creation happens in `settings::save` and in `write_index`.
pub fn trace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("dictation")
        .join(TRACES_DIR))
}

fn audio_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(trace_dir(app)?.join(AUDIO_DIR))
}

fn audio_path(app: &AppHandle, trace_id: &str) -> Result<PathBuf, String> {
    Ok(audio_dir(app)?.join(format!("{trace_id}.wav.enc")))
}

/// Write-to-temp-then-rename, so a crash mid-write can never leave a truncated
/// index behind. Same shape as `vocab::write_store`.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension(format!("tmp{}", std::process::id()));
    let mut handle = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    handle.write_all(bytes).map_err(|e| e.to_string())?;
    handle.sync_all().map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

fn read_index(app: &AppHandle) -> Result<TraceIndex, String> {
    let path = trace_dir(app)?.join(INDEX_FILE);
    let Ok(sealed) = std::fs::read(&path) else {
        return Ok(TraceIndex {
            version: TRACE_SCHEMA_VERSION,
            traces: Vec::new(),
            tombstones: Vec::new(),
        });
    };
    let key = super::super::vocab::load_or_create_key(app)?;
    let plain = super::super::vocab::decrypt(&key, &sealed)?;
    let index: TraceIndex = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
    // An index written by a future build is not merged or migrated: a record
    // read under the wrong assumptions becomes a wrong training label, which is
    // worse than starting the corpus again.
    if index.version != TRACE_SCHEMA_VERSION {
        return Ok(TraceIndex {
            version: TRACE_SCHEMA_VERSION,
            traces: Vec::new(),
            tombstones: Vec::new(),
        });
    }
    Ok(index)
}

fn write_index(app: &AppHandle, index: &TraceIndex) -> Result<(), String> {
    let key = super::super::vocab::load_or_create_key(app)?;
    let plain = serde_json::to_vec(index).map_err(|e| e.to_string())?;
    let sealed = super::super::vocab::encrypt(&key, &plain)?;
    write_atomically(&trace_dir(app)?.join(INDEX_FILE), &sealed)
}

/// Runs `edit` against the whole record list under the lock, and writes the
/// result back when it reports a change. Every mutation in this module goes
/// through here so there is exactly one place the index is persisted.
pub fn with_records<R>(
    app: &AppHandle,
    edit: impl FnOnce(&mut Vec<TraceRecord>) -> (bool, R),
) -> Result<R, String> {
    with_index(app, |index| edit(&mut index.traces))
}

/// The same read-modify-write, but over the whole index including the tombstone
/// list. Private because callers have no business seeing the container; the
/// tombstone helpers below are the supported surface.
fn with_index<R>(
    app: &AppHandle,
    edit: impl FnOnce(&mut TraceIndex) -> (bool, R),
) -> Result<R, String> {
    let _guard = index_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut index = read_index(app)?;
    let (changed, result) = edit(&mut index);
    if changed {
        index.version = TRACE_SCHEMA_VERSION;
        write_index(app, &index)?;
    }
    Ok(result)
}

/// Records that a trace which had reached the server must now be deleted there.
/// Idempotent: the same id is never queued twice.
fn remember_tombstone(index: &mut TraceIndex, trace_id: &str) {
    if index.tombstones.iter().any(|id| id == trace_id) {
        return;
    }
    if index.tombstones.len() >= MAX_TOMBSTONES {
        index.tombstones.remove(0);
    }
    index.tombstones.push(trace_id.to_string());
}

/// The next id whose server-side copy still needs deleting, if any. Left in the
/// list until `resolve_tombstone` confirms, so a crash mid-request retries
/// rather than dropping the obligation.
pub fn claim_tombstone(app: &AppHandle) -> Result<Option<String>, String> {
    with_index(app, |index| {
        (false, index.tombstones.first().cloned())
    })
}

pub fn resolve_tombstone(app: &AppHandle, trace_id: &str) -> Result<(), String> {
    with_index(app, |index| {
        let before = index.tombstones.len();
        index.tombstones.retain(|id| id != trace_id);
        (index.tombstones.len() != before, ())
    })
}

/// Queues a server-side delete for every trace already uploaded, and marks them
/// so nothing re-queues them for upload. This is what makes revoking the sharing
/// consent mean something rather than merely stopping future uploads.
pub fn tombstone_all_shared(app: &AppHandle) -> Result<usize, String> {
    with_index(app, |index| {
        let shared: Vec<String> = index
            .traces
            .iter()
            .filter(|record| record.share_state == ShareState::Uploaded)
            .map(|record| record.trace_id.clone())
            .collect();
        for trace_id in &shared {
            remember_tombstone(index, trace_id);
        }
        for record in index.traces.iter_mut() {
            if record.share_state != ShareState::Ineligible {
                record.share_state = ShareState::Ineligible;
                record.shared_at_ms = None;
                record.share_attempts = 0;
                record.share_next_attempt_ms = 0;
            }
        }
        let count = shared.len();
        (true, count)
    })
}

/// Read-only view of the records, newest first.
pub fn list(app: &AppHandle, limit: usize) -> Result<Vec<TraceRecord>, String> {
    with_records(app, |records| {
        let mut out = records.clone();
        out.sort_by_key(|record| std::cmp::Reverse(record.recorded_at_ms));
        out.truncate(limit);
        (false, out)
    })
}

pub fn append(app: &AppHandle, record: TraceRecord) -> Result<(), String> {
    with_records(app, |records| {
        records.push(record);
        (true, ())
    })
}

/// Applies `update` to one record. Returns false when the id is unknown, which
/// happens legitimately: retention can prune a trace while its field is still
/// being watched.
pub fn update(
    app: &AppHandle,
    trace_id: &str,
    update: impl FnOnce(&mut TraceRecord),
) -> Result<bool, String> {
    with_records(app, |records| {
        match records.iter_mut().find(|record| record.trace_id == trace_id) {
            Some(record) => {
                update(record);
                (true, true)
            }
            None => (false, false),
        }
    })
}

pub fn save_audio(app: &AppHandle, trace_id: &str, wav: &[u8]) -> Result<(), String> {
    let key = super::super::vocab::load_or_create_key(app)?;
    let sealed = super::super::vocab::encrypt(&key, wav)?;
    write_atomically(&audio_path(app, trace_id)?, &sealed)
}

pub fn read_audio(app: &AppHandle, trace_id: &str) -> Result<Vec<u8>, String> {
    let sealed = std::fs::read(audio_path(app, trace_id)?).map_err(|e| e.to_string())?;
    let key = super::super::vocab::load_or_create_key(app)?;
    super::super::vocab::decrypt(&key, &sealed)
}

fn remove_audio(app: &AppHandle, trace_id: &str) {
    if let Ok(path) = audio_path(app, trace_id) {
        let _ = std::fs::remove_file(path);
    }
}

/// Deletes one trace and its audio.
///
/// A trace that had already been uploaded leaves a tombstone behind, so the
/// server copy is deleted too. Without that, deleting a shared recording would
/// remove only the local half and the button would be lying.
pub fn delete(app: &AppHandle, trace_id: &str) -> Result<bool, String> {
    let removed = with_index(app, |index| {
        let before = index.traces.len();
        let was_shared = index
            .traces
            .iter()
            .any(|record| record.trace_id == trace_id && record.share_state == ShareState::Uploaded);
        index.traces.retain(|record| record.trace_id != trace_id);
        let removed = index.traces.len() != before;
        if removed && was_shared {
            remember_tombstone(index, trace_id);
        }
        (removed, removed)
    })?;
    if removed {
        remove_audio(app, trace_id);
    }
    Ok(removed)
}

/// Removes everything this feature has ever stored, and nothing else.
///
/// Only `traces/` is deleted. `key.bin`, `vocab.enc` and `corrections.enc` live
/// in the parent directory and survive, so wiping the training corpus never
/// costs the user the vocabulary they built up.
pub fn delete_all(app: &AppHandle) -> Result<usize, String> {
    // The tombstones for anything already uploaded have to be written BEFORE the
    // index file is removed, and they are the one thing that must survive it -
    // so the index is rewritten holding only them, rather than deleted outright.
    let (count, pending) = with_index(app, |index| {
        let count = index.traces.len();
        let shared: Vec<String> = index
            .traces
            .iter()
            .filter(|record| record.share_state == ShareState::Uploaded)
            .map(|record| record.trace_id.clone())
            .collect();
        for trace_id in &shared {
            remember_tombstone(index, trace_id);
        }
        index.traces.clear();
        let pending = index.tombstones.len();
        (true, (count, pending))
    })?;

    let dir = trace_dir(app)?;
    let audio = dir.join(AUDIO_DIR);
    if audio.exists() {
        std::fs::remove_dir_all(&audio).map_err(|e| e.to_string())?;
    }
    // Nothing was ever shared and nothing is queued: drop the index file
    // entirely, so "delete everything" really does leave no trace store behind.
    if pending == 0 {
        let index_path = dir.join(INDEX_FILE);
        if index_path.exists() {
            std::fs::remove_file(&index_path).map_err(|e| e.to_string())?;
        }
    }
    Ok(count)
}

/// Enforces the retention window and the two ceilings, oldest first.
///
/// Returns how many records were dropped. Runs at startup and after each write,
/// so a store that has been left alone for a month is pruned the moment the app
/// comes back rather than on a timer that may never fire.
pub fn prune(app: &AppHandle, retention_days: u32) -> Result<usize, String> {
    let cutoff = now_ms() - (retention_days as i64 * 24 * 60 * 60 * 1000);
    let (dropped, survivors) = with_records(app, |records| {
        let before = records.len();
        records.retain(|record| record.recorded_at_ms >= cutoff);
        records.sort_by_key(|record| record.recorded_at_ms);
        if records.len() > MAX_TRACES {
            records.drain(..records.len() - MAX_TRACES);
        }
        let dropped = before - records.len();
        (dropped > 0, (dropped, records.clone()))
    })?;

    // Audio is reconciled against the surviving records rather than against a
    // remembered list of dropped ids, so a blob orphaned by an earlier crash is
    // cleaned up on the next run too.
    let live: Vec<String> = survivors
        .iter()
        .map(|record| record.trace_id.clone())
        .collect();
    prune_orphan_audio(app, &live);
    enforce_audio_ceiling(app, &survivors)?;
    Ok(dropped)
}

/// Deletes audio whose record no longer exists.
fn prune_orphan_audio(app: &AppHandle, live_ids: &[String]) {
    let Ok(dir) = audio_dir(app) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(id) = name.strip_suffix(".wav.enc") else {
            continue;
        };
        if !live_ids.iter().any(|live| live == id) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

/// Drops the oldest audio blobs once the total passes the ceiling. The RECORDS
/// are kept: the transcript pair is still evidence about the recognizer even
/// once its audio is gone, it just stops being trainable, which is what
/// `hasAudio` tells a reader.
fn enforce_audio_ceiling(app: &AppHandle, records: &[TraceRecord]) -> Result<(), String> {
    let mut total = audio_bytes(app);
    if total <= MAX_AUDIO_BYTES {
        return Ok(());
    }
    let mut oldest: Vec<&TraceRecord> = records.iter().filter(|record| record.has_audio).collect();
    oldest.sort_by_key(|record| record.recorded_at_ms);
    for record in oldest {
        if total <= MAX_AUDIO_BYTES {
            break;
        }
        if let Ok(path) = audio_path(app, &record.trace_id) {
            let size = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
            if std::fs::remove_file(&path).is_ok() {
                total = total.saturating_sub(size);
                let _ = update(app, &record.trace_id, |stored| stored.has_audio = false);
            }
        }
    }
    Ok(())
}

pub fn audio_bytes(app: &AppHandle) -> u64 {
    let Ok(dir) = audio_dir(app) else {
        return 0;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .flatten()
        .filter_map(|entry| entry.metadata().ok())
        .map(|metadata| metadata.len())
        .sum()
}

pub fn summary(app: &AppHandle) -> Result<TraceSummary, String> {
    let audio = audio_bytes(app);
    with_index(app, |index| {
        let records = &index.traces;
        let summary = TraceSummary {
            total: records.len(),
            verified: records.iter().filter(|record| record.is_verified()).count(),
            watching: records
                .iter()
                .filter(|record| record.state == TraceState::Watching)
                .count(),
            with_edits: records
                .iter()
                .filter(|record| !record.edits.is_empty())
                .count(),
            audio_bytes: audio,
            oldest_recorded_at_ms: records.iter().map(|record| record.recorded_at_ms).min(),
            shared: records
                .iter()
                .filter(|record| record.share_state == ShareState::Uploaded)
                .count(),
            pending_share: records
                .iter()
                .filter(|record| record.share_state == ShareState::Pending)
                .count(),
            pending_deletions: index.tombstones.len(),
        };
        (false, summary)
    })
}

/// A UI Automation anchor cannot outlive the process that holds it, so any
/// trace still marked `Watching` when the app starts is one whose field can
/// never be re-read. Settled as `AnchorLost` rather than left pending forever,
/// and deliberately NOT promoted to a verified label: nobody observed whether
/// the user corrected it.
pub fn settle_orphans(app: &AppHandle) -> Result<usize, String> {
    with_records(app, |records| {
        let mut settled = 0usize;
        for record in records.iter_mut() {
            if record.state == TraceState::Watching {
                record.state = TraceState::AnchorLost;
                record.anchor_note = Some("app_restarted".to_string());
                settled += 1;
            }
        }
        (settled > 0, settled)
    })
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}
