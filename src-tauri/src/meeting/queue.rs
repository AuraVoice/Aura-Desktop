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
    /// Firebase UID that owned the native authorization when this capture
    /// was created. `None` represents a pre-ownership legacy row and is
    /// deliberately inaccessible to every account.
    #[serde(default)]
    pub owner_uid: Option<String>,
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

fn is_owned_by(entry: &MeetingEntry, owner_uid: &str) -> bool {
    entry.owner_uid.as_deref() == Some(owner_uid)
}

fn require_owned<'a>(
    manifest: &'a Manifest,
    meeting_id: &str,
    owner_uid: &str,
) -> Result<&'a MeetingEntry, String> {
    manifest
        .meetings
        .get(meeting_id)
        .filter(|entry| is_owned_by(entry, owner_uid))
        // Do not reveal whether the id belongs to another account or is a
        // legacy unowned row.
        .ok_or_else(|| "unknown meeting id".to_string())
}

fn require_owned_mut<'a>(
    manifest: &'a mut Manifest,
    meeting_id: &str,
    owner_uid: &str,
) -> Result<&'a mut MeetingEntry, String> {
    manifest
        .meetings
        .get_mut(meeting_id)
        .filter(|entry| is_owned_by(entry, owner_uid))
        .ok_or_else(|| "unknown meeting id".to_string())
}

fn retain_owned(manifest: &mut Manifest, owner_uid: &str) {
    manifest
        .meetings
        .retain(|_, entry| is_owned_by(entry, owner_uid));
}

/// The upload pump may see only rows owned by the UID in its native
/// authorization ticket. Legacy rows without an owner fail closed here.
pub fn load_for_owner(app: &AppHandle, owner_uid: &str) -> Manifest {
    let mut manifest = load(app);
    retain_owned(&mut manifest, owner_uid);
    manifest
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
    owner_uid: &str,
    event_id: &str,
    started_at_ms: i64,
    seq: u32,
    start_ms: i64,
    duration_ms: i64,
    encrypted: &[u8],
    incomplete: bool,
) -> Result<(), String> {
    let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut manifest = load_unlocked(app);
    if let Some(entry) = manifest.meetings.get(meeting_id) {
        if !is_owned_by(entry, owner_uid) {
            return Err("unknown meeting id".to_string());
        }
    }

    let path = segment_path(app, meeting_id, seq)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, encrypted).map_err(|e| e.to_string())?;

    let entry = manifest
        .meetings
        .entry(meeting_id.to_string())
        .or_insert_with(|| MeetingEntry {
            owner_uid: Some(owner_uid.to_string()),
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

/// Starting offsets for a new engine run. A missing row is a fresh capture;
/// an existing row must belong to the authorizing UID before rejoin state is
/// reused.
pub fn capture_offsets(
    app: &AppHandle,
    meeting_id: &str,
    owner_uid: &str,
) -> Result<(u32, i64), String> {
    let manifest = load(app);
    let Some(entry) = manifest.meetings.get(meeting_id) else {
        return Ok((0, 0));
    };
    if !is_owned_by(entry, owner_uid) {
        return Err("unknown meeting id".to_string());
    }
    let next_seq = entry
        .segments
        .iter()
        .map(|segment| segment.seq)
        .max()
        .map(|max| max + 1)
        .unwrap_or(0);
    let recorded_span_ms = entry
        .segments
        .iter()
        .map(|segment| segment.start_ms + segment.duration_ms)
        .max()
        .unwrap_or(0);
    Ok((next_seq, recorded_span_ms))
}

pub fn mark_uploaded(
    app: &AppHandle,
    meeting_id: &str,
    owner_uid: &str,
    seq: u32,
) -> Result<(), String> {
    let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut manifest = load_unlocked(app);
    let entry = require_owned_mut(&mut manifest, meeting_id, owner_uid)?;
    let segment = entry
        .segments
        .iter_mut()
        .find(|segment| segment.seq == seq)
        .ok_or_else(|| "unknown segment".to_string())?;
    segment.uploaded = true;
    save(app, &manifest)
}

pub fn mark_completed(
    app: &AppHandle,
    meeting_id: &str,
    owner_uid: &str,
    event_id: &str,
    started_at_ms: i64,
    total_duration_ms: i64,
    reason: &str,
) -> Result<(), String> {
    let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut manifest = load_unlocked(app);
    if let Some(entry) = manifest.meetings.get(meeting_id) {
        if !is_owned_by(entry, owner_uid) {
            return Err("unknown meeting id".to_string());
        }
    }
    // Zero-segment captures (mic init failure, sub-2s call) still get an
    // entry, so the upload pump can tell the backend to settle the claimed
    // meeting as failed instead of leaving it "capturing" forever.
    let entry = manifest
        .meetings
        .entry(meeting_id.to_string())
        .or_insert_with(|| MeetingEntry {
            owner_uid: Some(owner_uid.to_string()),
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
pub fn remove_meeting(app: &AppHandle, meeting_id: &str, owner_uid: &str) -> Result<(), String> {
    remove_meeting_inner(app, meeting_id, Some(owner_uid))
}

fn remove_meeting_inner(
    app: &AppHandle,
    meeting_id: &str,
    owner_uid: Option<&str>,
) -> Result<(), String> {
    {
        let _guard = MANIFEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut manifest = load_unlocked(app);
        if let Some(owner_uid) = owner_uid {
            require_owned(&manifest, meeting_id, owner_uid)?;
        }
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
        // Retention is installation maintenance, not an account operation;
        // it must also be able to delete inaccessible legacy rows.
        if let Err(e) = remove_meeting_inner(app, meeting_id, None) {
            error!("meeting.queue: failed to prune {meeting_id}: {e}");
        }
    }
    expired.len()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{
        is_owned_by, require_owned, retain_owned, validate_meeting_id, Manifest, MeetingEntry,
    };

    fn entry(owner_uid: Option<&str>) -> MeetingEntry {
        MeetingEntry {
            owner_uid: owner_uid.map(str::to_string),
            event_id: "event-1".to_string(),
            started_at_ms: 0,
            completed: false,
            complete_reason: String::new(),
            total_duration_ms: 0,
            segments: Vec::new(),
        }
    }

    #[test]
    fn ownership_matches_only_the_exact_uid() {
        assert!(is_owned_by(&entry(Some("uid-a")), "uid-a"));
        assert!(!is_owned_by(&entry(Some("uid-a")), "uid-b"));
    }

    #[test]
    fn legacy_entries_without_an_owner_fail_closed() {
        assert!(!is_owned_by(&entry(None), "uid-a"));
    }

    #[test]
    fn snapshot_filter_exposes_only_the_ticket_owner() {
        let mut manifest = Manifest {
            meetings: HashMap::from([
                ("owned".to_string(), entry(Some("uid-a"))),
                ("other".to_string(), entry(Some("uid-b"))),
                ("legacy".to_string(), entry(None)),
            ]),
        };

        retain_owned(&mut manifest, "uid-a");
        assert_eq!(manifest.meetings.len(), 1);
        assert!(manifest.meetings.contains_key("owned"));
    }

    #[test]
    fn read_and_mutation_gate_rejects_other_and_legacy_owners() {
        let manifest = Manifest {
            meetings: HashMap::from([
                ("owned".to_string(), entry(Some("uid-a"))),
                ("other".to_string(), entry(Some("uid-b"))),
                ("legacy".to_string(), entry(None)),
            ]),
        };

        assert!(require_owned(&manifest, "owned", "uid-a").is_ok());
        assert!(require_owned(&manifest, "other", "uid-a").is_err());
        assert!(require_owned(&manifest, "legacy", "uid-a").is_err());
    }

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
