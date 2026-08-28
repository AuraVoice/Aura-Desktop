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
#[serde(rename_all = "camelCase")]
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
    /// Account-bound server deletes written by builds that know which Firebase
    /// namespace received the upload. Legacy string tombstones remain above so
    /// old stores stay readable, but are never claimed under an arbitrary user.
    #[serde(default)]
    deletion_obligations: Vec<DeletionObligation>,
    /// One monthly-quota reset per Firebase account. Expired rows are removed
    /// during the next claim, so the list stays naturally bounded.
    #[serde(default)]
    quota_pauses: Vec<QuotaPause>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeletionObligation {
    trace_id: String,
    owner_uid: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaPause {
    owner_uid: String,
    blocked_until_ms: i64,
}

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
/// index behind.
pub fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::fsx::write_atomic(path, bytes, crate::fsx::Durability::Fsync)
}

fn read_index(app: &AppHandle) -> Result<TraceIndex, String> {
    let path = trace_dir(app)?.join(INDEX_FILE);
    let Ok(sealed) = std::fs::read(&path) else {
        return Ok(TraceIndex {
            version: TRACE_SCHEMA_VERSION,
            traces: Vec::new(),
            tombstones: Vec::new(),
            deletion_obligations: Vec::new(),
            quota_pauses: Vec::new(),
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
            deletion_obligations: Vec::new(),
            quota_pauses: Vec::new(),
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

/// Records that a trace which may have reached the server must now be deleted
/// there. Idempotent, durable, and account-bound.
fn remember_tombstone(index: &mut TraceIndex, trace_id: &str, owner_uid: &str) {
    if index
        .deletion_obligations
        .iter()
        .any(|item| item.trace_id == trace_id)
    {
        return;
    }
    index.deletion_obligations.push(DeletionObligation {
        trace_id: trace_id.to_string(),
        owner_uid: owner_uid.to_string(),
    });
}

/// The next id whose server-side copy still needs deleting for this account.
/// Left in the list until `resolve_tombstone` confirms, so a crash mid-request
/// retries rather than dropping the obligation.
pub fn claim_tombstone(app: &AppHandle, owner_uid: &str) -> Result<Option<String>, String> {
    with_index(app, |index| {
        let found = index
            .deletion_obligations
            .iter()
            .find(|item| item.owner_uid == owner_uid)
            .map(|item| item.trace_id.clone());
        (false, found)
    })
}

pub fn resolve_tombstone(
    app: &AppHandle,
    trace_id: &str,
    owner_uid: &str,
) -> Result<(), String> {
    with_index(app, |index| {
        let before = index.deletion_obligations.len();
        index
            .deletion_obligations
            .retain(|item| item.trace_id != trace_id || item.owner_uid != owner_uid);
        (index.deletion_obligations.len() != before, ())
    })
}

/// Atomically selects the oldest upload for this account and binds an unowned
/// trace before the lease can cross into JavaScript. A persisted quota pause or
/// outstanding delete prevents the claim.
pub fn claim_upload(
    app: &AppHandle,
    owner_uid: &str,
    now: i64,
) -> Result<Option<TraceRecord>, String> {
    with_index(app, |index| {
        let pause_count = index.quota_pauses.len();
        index
            .quota_pauses
            .retain(|pause| pause.blocked_until_ms > now);
        let mut changed = pause_count != index.quota_pauses.len();
        if index
            .quota_pauses
            .iter()
            .any(|pause| pause.owner_uid == owner_uid)
        {
            return (changed, None);
        }

        let candidate = index
            .traces
            .iter()
            .enumerate()
            .filter(|(_, record)| {
                record.share_state == ShareState::Pending
                    && record.share_next_attempt_ms <= now
                    && record.is_shareable()
                    && record
                        .upload_owner_uid
                        .as_deref()
                        .is_none_or(|bound| bound == owner_uid)
                    && !index.tombstones.iter().any(|id| id == &record.trace_id)
                    && !index
                        .deletion_obligations
                        .iter()
                        .any(|item| item.trace_id == record.trace_id)
            })
            .min_by_key(|(_, record)| record.recorded_at_ms)
            .map(|(position, _)| position);
        let Some(position) = candidate else {
            return (changed, None);
        };
        if index.traces[position].upload_owner_uid.is_none() {
            index.traces[position].upload_owner_uid = Some(owner_uid.to_string());
            changed = true;
        }
        (changed, Some(index.traces[position].clone()))
    })
}

pub fn pause_uploads(
    app: &AppHandle,
    owner_uid: &str,
    blocked_until_ms: i64,
) -> Result<(), String> {
    with_index(app, |index| {
        index
            .quota_pauses
            .retain(|pause| pause.owner_uid != owner_uid);
        index.quota_pauses.push(QuotaPause {
            owner_uid: owner_uid.to_string(),
            blocked_until_ms,
        });
        (true, ())
    })
}

pub fn upload_owner_matches(
    app: &AppHandle,
    trace_id: &str,
    owner_uid: &str,
) -> Result<bool, String> {
    with_records(app, |records| {
        let matches = records.iter().any(|record| {
            record.trace_id == trace_id
                && record.upload_owner_uid.as_deref() == Some(owner_uid)
        });
        (false, matches)
    })
}

pub fn update_owned(
    app: &AppHandle,
    trace_id: &str,
    owner_uid: &str,
    update: impl FnOnce(&mut TraceRecord),
) -> Result<bool, String> {
    with_records(app, |records| {
        match records.iter_mut().find(|record| {
            record.trace_id == trace_id
                && record.upload_owner_uid.as_deref() == Some(owner_uid)
        }) {
            Some(record) => {
                update(record);
                (true, true)
            }
            None => (false, false),
        }
    })
}

/// Queues a server-side delete for every trace ever bound to an account, and
/// marks them so nothing re-queues them for upload until that delete resolves.
/// This is what makes revoking sharing meaningful after a partial upload.
pub fn tombstone_all_shared(app: &AppHandle) -> Result<usize, String> {
    with_index(app, |index| {
        let shared: Vec<(String, String)> = index
            .traces
            .iter()
            .filter(|record| record.share_state != ShareState::Ineligible)
            .filter_map(|record| {
                record
                    .upload_owner_uid
                    .as_ref()
                    .map(|owner| (record.trace_id.clone(), owner.clone()))
            })
            .collect();
        for (trace_id, owner_uid) in &shared {
            remember_tombstone(index, trace_id, owner_uid);
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
        (count > 0, count)
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
/// A trace ever bound for upload leaves an account-bound tombstone behind, so a
/// partial metadata-only upload is deleted too.
pub fn delete(app: &AppHandle, trace_id: &str) -> Result<bool, String> {
    let removed = with_index(app, |index| {
        let before = index.traces.len();
        let upload_owner = index
            .traces
            .iter()
            .find(|record| record.trace_id == trace_id)
            .and_then(|record| record.upload_owner_uid.clone());
        index.traces.retain(|record| record.trace_id != trace_id);
        let removed = index.traces.len() != before;
        if removed {
            if let Some(owner_uid) = upload_owner {
                remember_tombstone(index, trace_id, &owner_uid);
            }
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
    // The tombstones for anything ever bound have to be written BEFORE the
    // index file is removed, and they are the one thing that must survive it -
    // so the index is rewritten holding only them, rather than deleted outright.
    let (count, pending, paused) = with_index(app, |index| {
        let count = index.traces.len();
        let shared: Vec<(String, String)> = index
            .traces
            .iter()
            .filter_map(|record| {
                record
                    .upload_owner_uid
                    .as_ref()
                    .map(|owner| (record.trace_id.clone(), owner.clone()))
            })
            .collect();
        for (trace_id, owner_uid) in &shared {
            remember_tombstone(index, trace_id, owner_uid);
        }
        index.traces.clear();
        let pending = index.tombstones.len() + index.deletion_obligations.len();
        (true, (count, pending, !index.quota_pauses.is_empty()))
    })?;

    let dir = trace_dir(app)?;
    let audio = dir.join(AUDIO_DIR);
    if audio.exists() {
        std::fs::remove_dir_all(&audio).map_err(|e| e.to_string())?;
    }
    // Nothing was ever shared and nothing is queued: drop the index file
    // entirely, so "delete everything" really does leave no trace store behind.
    if pending == 0 && !paused {
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
    let (dropped, survivors) = with_index(app, |index| {
        let before = index.traces.len();
        let mut removed: Vec<(String, String)> = index
            .traces
            .iter()
            .filter(|record| record.recorded_at_ms < cutoff)
            .filter_map(|record| {
                record
                    .upload_owner_uid
                    .as_ref()
                    .map(|owner| (record.trace_id.clone(), owner.clone()))
            })
            .collect();
        index
            .traces
            .retain(|record| record.recorded_at_ms >= cutoff);
        index
            .traces
            .sort_by_key(|record| record.recorded_at_ms);
        if index.traces.len() > MAX_TRACES {
            removed.extend(
                index.traces[..index.traces.len() - MAX_TRACES]
                    .iter()
                    .filter_map(|record| {
                        record
                            .upload_owner_uid
                            .as_ref()
                            .map(|owner| (record.trace_id.clone(), owner.clone()))
                    }),
            );
            index.traces.drain(..index.traces.len() - MAX_TRACES);
        }
        for (trace_id, owner_uid) in removed {
            remember_tombstone(index, &trace_id, &owner_uid);
        }
        let dropped = before - index.traces.len();
        (dropped > 0, (dropped, index.traces.clone()))
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
                .filter(|record| record.edits.iter().any(|edit| edit.class.is_ground_truth()))
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
            pending_deletions: index.tombstones.len() + index.deletion_obligations.len(),
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

pub use crate::util::now_ms;
