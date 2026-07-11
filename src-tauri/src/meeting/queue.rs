//! Durable upload queue - a manifest JSON plus encrypted segment files under
//! `app_local_data_dir/meeting-captures/`.
//!
//! The manifest is the source of truth the JS upload pump reads after any
//! restart, so every mutation goes through load -> modify -> atomic save
//! (temp file + rename, so a crash mid-write can never half-corrupt it).
//! Serialization is plain std::fs like updater.rs's marker, not the store
//! plugin - segment metadata and multi-megabyte blobs don't belong in a
//! store file that plugins re-read wholesale.
//!
//! Layout:
//!   meeting-captures/manifest.json
//!   meeting-captures/key.bin                    (DPAPI-wrapped, crypto.rs)
//!   meeting-captures/{meeting_id}/{seq:04}.flac.enc

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use log::{error, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub const CAPTURES_DIR: &str = "meeting-captures";
const MANIFEST_FILE: &str = "manifest.json";

/// Serializes every load-modify-save on the manifest. The engine thread, the
/// upload pump's ack path, completion, and pruning all mutate the same file;
/// without this, two concurrent read-modify-writes silently drop whichever
/// mutation saves first (orphaned segment files, "never uploaded" rows).
static MANIFEST_LOCK: Mutex<()> = Mutex::new(());

/// Unsent captures older than this are dropped, not retried forever
/// (MEETING_NOTES_PLAN.md section 6).
const EXPIRY_MS: i64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentEntry {
    pub seq: u32,
    pub start_ms: i64,
    pub duration_ms: i64,
    #[serde(default)]
    pub uploaded: bool,
    /// A device re-bind failed inside this segment's window: its audio may
    /// have a silent hole. Recorded rather than hidden - the transcript is
    /// then honest about being partial instead of pretending to be clean.
    #[serde(default)]
    pub incomplete: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingEntry {
    pub event_id: String,
    pub started_at_ms: i64,
    #[serde(default)]
    pub completed: bool,
    #[serde(default)]
    pub complete_reason: String,
    #[serde(default)]
    pub total_duration_ms: i64,
    #[serde(default)]
    pub segments: Vec<SegmentEntry>,
}

#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Manifest {
    #[serde(default)]
    pub meetings: HashMap<String, MeetingEntry>,
}

fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(CAPTURES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// meeting_id is a backend-minted uuid hex, but never trust a path component
/// that crossed the IPC boundary: charset allowlist + length bound, strictly
/// tighter than the old `/ \ .` deny-list.
pub fn validate_meeting_id(meeting_id: &str) -> Result<(), String> {
    let valid = !meeting_id.is_empty()
        && meeting_id.len() <= 128
        && meeting_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if valid {
        Ok(())
    } else {
        Err("invalid meeting id".to_string())
    }
}

pub fn segment_path(app: &AppHandle, meeting_id: &str, seq: u32) -> Result<PathBuf, String> {
    validate_meeting_id(meeting_id)?;
    Ok(base_dir(app)?.join(meeting_id).join(format!("{seq:04}.flac.enc")))
}

pub fn load(app: &AppHandle) -> Manifest {
    let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_unlocked(app)
}

fn load_unlocked(app: &AppHandle) -> Manifest {
    let Ok(dir) = base_dir(app) else {
        return Manifest::default();
    };
    match std::fs::read_to_string(dir.join(MANIFEST_FILE)) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_else(|e| {
            error!("meeting.queue: manifest unparseable, starting fresh: {e}");
            Manifest::default()
        }),
        Err(_) => Manifest::default(),
    }
}

fn save(app: &AppHandle, manifest: &Manifest) -> Result<(), String> {
    let dir = base_dir(app)?;
    let raw = serde_json::to_string_pretty(manifest).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("{MANIFEST_FILE}.tmp"));
    let path = dir.join(MANIFEST_FILE);
    std::fs::write(&tmp, raw).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

/// Persist one encrypted segment and its manifest row. Creates the meeting
/// entry on first segment (which also makes a rejoin continue seq numbering:
/// the entry survives between the engine's runs).
#[allow(clippy::too_many_arguments)]
pub fn write_segment(
    app: &AppHandle,
    meeting_id: &str,
    event_id: &str,
    started_at_ms: i64,
    seq: u32,
    start_ms: i64,
    duration_ms: i64,
    encrypted: &[u8],
    incomplete: bool,
) -> Result<(), String> {
    let path = segment_path(app, meeting_id, seq)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, encrypted).map_err(|e| e.to_string())?;

    let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut manifest = load_unlocked(app);
    let entry = manifest
        .meetings
        .entry(meeting_id.to_string())
        .or_insert_with(|| MeetingEntry {
            event_id: event_id.to_string(),
            started_at_ms,
            completed: false,
            complete_reason: String::new(),
            total_duration_ms: 0,
            segments: Vec::new(),
        });
    // A rejoin reopens a completed entry: new audio means the capture is
    // live again and /complete must be re-sent afterwards.
    entry.completed = false;
    entry.segments.retain(|segment| segment.seq != seq);
    entry.segments.push(SegmentEntry {
        seq,
        start_ms,
        duration_ms,
        uploaded: false,
        incomplete,
    });
    entry.segments.sort_by_key(|segment| segment.seq);
    save(app, &manifest)
}

/// The next unused segment seq for a meeting - lets a rejoined capture
/// continue numbering instead of overwriting the first session's files.
pub fn next_seq(app: &AppHandle, meeting_id: &str) -> u32 {
    load(app)
        .meetings
        .get(meeting_id)
        .and_then(|entry| entry.segments.iter().map(|segment| segment.seq).max())
        .map(|max| max + 1)
        .unwrap_or(0)
}

/// The span already recorded for a meeting (max start+duration), so a rejoin
/// stamps its new segments after the first session's timeline.
pub fn recorded_span_ms(app: &AppHandle, meeting_id: &str) -> i64 {
    load(app)
        .meetings
        .get(meeting_id)
        .map(|entry| {
            entry
                .segments
                .iter()
                .map(|segment| segment.start_ms + segment.duration_ms)
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

pub fn mark_uploaded(app: &AppHandle, meeting_id: &str, seq: u32) -> Result<(), String> {
    let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut manifest = load_unlocked(app);
    let Some(entry) = manifest.meetings.get_mut(meeting_id) else {
        return Ok(()); // pruned/acked underneath the upload - nothing to record
    };
    for segment in &mut entry.segments {
        if segment.seq == seq {
            segment.uploaded = true;
        }
    }
    save(app, &manifest)
}

pub fn mark_completed(
    app: &AppHandle,
    meeting_id: &str,
    event_id: &str,
    started_at_ms: i64,
    total_duration_ms: i64,
    reason: &str,
) -> Result<(), String> {
    let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut manifest = load_unlocked(app);
    // Zero-segment captures (mic init failure, sub-2s call) still get an
    // entry, so the upload pump can tell the backend to settle the claimed
    // meeting as failed instead of leaving it "capturing" forever.
    let entry = manifest
        .meetings
        .entry(meeting_id.to_string())
        .or_insert_with(|| MeetingEntry {
            event_id: event_id.to_string(),
            started_at_ms,
            completed: false,
            complete_reason: String::new(),
            total_duration_ms: 0,
            segments: Vec::new(),
        });
    entry.completed = true;
    entry.complete_reason = reason.to_string();
    entry.total_duration_ms = entry.total_duration_ms.max(total_duration_ms);
    save(app, &manifest)
}

/// Deletes a meeting's segment files and manifest entry (after the backend
/// acked /complete, or at expiry).
pub fn remove_meeting(app: &AppHandle, meeting_id: &str) -> Result<(), String> {
    {
        let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut manifest = load_unlocked(app);
        if manifest.meetings.remove(meeting_id).is_some() {
            save(app, &manifest)?;
        }
    }
    if let Ok(path) = segment_path(app, meeting_id, 0) {
        if let Some(dir) = path.parent() {
            if dir.exists() {
                if let Err(e) = std::fs::remove_dir_all(dir) {
                    warn!("meeting.queue: failed to remove segment dir: {e}");
                }
            }
        }
    }
    Ok(())
}

/// Startup sweep: drop entries older than the retention window. Returns how
/// many were dropped (logged by the caller).
pub fn prune_expired(app: &AppHandle) -> usize {
    let manifest = load(app);
    let cutoff = super::now_ms() - EXPIRY_MS;
    let expired: Vec<String> = manifest
        .meetings
        .iter()
        .filter(|(_, entry)| entry.started_at_ms < cutoff)
        .map(|(id, _)| id.clone())
        .collect();
    for meeting_id in &expired {
        if let Err(e) = remove_meeting(app, meeting_id) {
            error!("meeting.queue: failed to prune {meeting_id}: {e}");
        }
    }
    expired.len()
}

#[cfg(test)]
mod tests {
    use super::validate_meeting_id;

    #[test]
    fn accepts_backend_shaped_ids() {
        assert!(validate_meeting_id("3f2a9c1b7d4e4f209a1b2c3d4e5f6a7b").is_ok());
        assert!(validate_meeting_id("mtg_2026-07-11").is_ok());
        assert!(validate_meeting_id("a").is_ok());
    }

    #[test]
    fn rejects_everything_path_shaped_or_odd() {
        for bad in [
            "",
            "../x",
            "a/b",
            r"a\b",
            "a.b",
            "id with space",
            "id\nnewline",
            "sémantic",
            "..",
        ] {
            assert!(validate_meeting_id(bad).is_err(), "{bad:?}");
        }
        assert!(validate_meeting_id(&"x".repeat(129)).is_err());
        assert!(validate_meeting_id(&"x".repeat(128)).is_ok());
    }
}
