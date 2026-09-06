//! Local, encrypted history of finished dictations: the transcript text and the
//! captured audio clip, so the Dictation page can list, search, replay, export
//! and delete what the user has dictated.
//!
//! ## Why this exists at all
//!
//! Until this module, a dictation was write-only: `run_utterance` produced the
//! text, typed it into the focused app, and dropped it. That was a deliberate
//! posture, and reversing it was a deliberate product decision, so the reversal
//! is narrow and everything that made the old posture safe still holds:
//!
//! - Nothing is written unencrypted. Transcript text is AES-256-GCM ciphertext
//!   in a BLOB column; the audio clip is AES-256-GCM over the FLAC bytes.
//! - Nothing here is logged at any level beyond counts, byte sizes, durations
//!   and outcomes. No transcript, and no path that could contain user content.
//! - The store is per-account, and `security::session_changed` wipes every other
//!   account's rows AND clips on every transition, signed in or out.
//!
//! ## What is NOT stored, and why
//!
//! - **Password-field dictations.** Aura deliberately refuses to type into a
//!   password box; archiving that text to disk would be strictly worse than
//!   typing it. See the outcome match in `mod.rs`.
//! - **Failed holds.** No transcript means a row that says nothing. The
//!   in-memory `FailedUtterance` recovery buffer is unchanged.
//! - **The target application name.** `mod.rs` already computes an app key for
//!   biasing, so it would be free to take, but it is the one field that turns a
//!   transcript log into a browsing-and-activity log. It appears nowhere in the
//!   UI, and `usage.rs` documents application names as deliberately excluded.
//!   Adding it later is a non-destructive `ALTER TABLE ... ADD COLUMN`.
//!
//! ## Retention: two independent caps
//!
//! Text is tiny (a few hundred bytes a row) and capped by age alone. Audio is
//! about 1 MB a minute and capped by age OR total bytes, whichever bites first,
//! evicted oldest first. Eviction unlinks the clip and NULLs `audio_path` while
//! keeping the row, so "the audio aged out but the transcript is still here" is
//! a designed state rather than an error. That is what bounds disk without ever
//! losing the thing the user actually reads.
//!
//! Modelled on `interview_store.rs` (same encrypted-SQLite shape, same per-row
//! AAD, same "a row that will not decrypt is skipped, never fatal" rule), but
//! sealed under the DICTATION key from `vocab.rs`, never meeting's: "delete my
//! recordings" must not silently brick dictation.

use std::path::PathBuf;

use log::warn;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

use crate::sealed_store::aad;
use crate::util::now_ms;

// Platform shims, mirroring `interview_store.rs`. The store compiles
// everywhere and is simply inert off Windows: the crypto, the DPAPI-wrapped
// key, and the sample/FLAC path are all Windows-only, and every entry point
// checks `ENCRYPTION_AVAILABLE` before it reaches one of these.

#[cfg(any(windows, target_os = "macos"))]
use crate::sealed_store::{seal, unseal};

#[cfg(not(any(windows, target_os = "macos")))]
fn seal(_key: &[u8; 32], _plaintext: &str, _aad: &str) -> Result<Vec<u8>, String> {
    Err(UNAVAILABLE.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn unseal(_key: &[u8; 32], _sealed: &[u8], _aad: &str) -> Result<String, String> {
    Err(UNAVAILABLE.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
use super::vocab::{dictation_dir, load_or_create_key};

#[cfg(not(any(windows, target_os = "macos")))]
fn dictation_dir(_app: &AppHandle) -> Result<PathBuf, String> {
    Err(UNAVAILABLE.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
fn load_or_create_key(_app: &AppHandle) -> Result<[u8; 32], String> {
    Err(UNAVAILABLE.to_string())
}

#[cfg(not(any(windows, target_os = "macos")))]
const UNAVAILABLE: &str = "dictation history is unavailable on this platform";

const DATABASE_FILE: &str = "history.sqlite3";
const CLIPS_DIR: &str = "clips";
pub(super) const SETTINGS_STORE: &str = "dictation-history.json";
const ENABLED_KEY: &str = "enabled";

/// Text retention. Transcripts are cheap; this is the only bound they need.
const MAX_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
/// Backstop on row count, so a runaway writer cannot grow the list until the
/// decrypt-everything list read stops being instant.
const MAX_ENTRIES: i64 = 20_000;
/// Audio budget: about nine hours of retained speech. Comfortably covers 90
/// days for a typical user and only bites for the heaviest, who still keep
/// weeks of replayable audio plus the full 90 days of searchable text.
const MAX_AUDIO_BYTES: i64 = 512 * 1024 * 1024;

/// Whether rows can be sealed on this platform. False disables the store
/// outright rather than degrading it to readable text on disk.
///
/// True everywhere, matching `chat_cache.rs` and `interview_store.rs`. It was
/// `cfg!(windows)` long after the macOS `seal`/`unseal`/`store_clip`/`read_clip`
/// paths below were implemented, which left every one of this module's entry
/// points short-circuiting on macOS: the table was permanently empty, the share
/// queue polled nothing, and `retain_only_for_session` never pruned, so the
/// account isolation this module is supposed to provide was vacuous there.
const ENCRYPTION_AVAILABLE: bool = true;

/// FROZEN namespace: existing sealed rows decrypt only under exactly this
/// grammar (this version string, NUL-separated parts).
const AAD_NAMESPACE: &str = "aura-dictation-history-v1";

/// Binds a sealed value to exactly one account, one row, and one slot, so a
/// blob cannot be replayed into another account or another field.
fn row_aad(uid: &str, id: &str, slot: &str) -> String {
    aad(AAD_NAMESPACE, &[uid, id, slot])
}

/// One stored dictation, as the dashboard sees it. `text` is plaintext across
/// the IPC boundary and sealed before it reaches disk.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationHistoryEntry {
    pub id: String,
    pub recorded_at_ms: i64,
    pub text: String,
    pub word_count: i64,
    pub duration_ms: i64,
    /// The clip is referenced by a row AND still present on disk. False is the
    /// normal end state for an old dictation, not a failure.
    pub has_audio: bool,
    pub flagged: bool,
    /// The transcript as it left ASR (after vocab corrections), present only
    /// when AI polish changed the text. None means the final text IS the raw.
    pub raw_text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySettings {
    /// On by default: a history nobody opted into is a history nobody finds.
    pub enabled: bool,
    /// Total encrypted bytes of retained audio, so the settings rail can say
    /// what the feature actually costs on this disk.
    pub audio_bytes: i64,
    pub entry_count: i64,
}

// ---------------------------------------------------------------- settings

pub fn is_enabled(app: &AppHandle) -> bool {
    let Ok(store) = app.store(SETTINGS_STORE) else {
        // Fail OPEN, unlike consent.rs. An unreadable settings file is not a
        // reason to silently stop recording a history the user expects to be
        // there; nothing leaves the machine either way.
        return true;
    };
    store
        .get(ENABLED_KEY)
        .and_then(|value| value.as_bool())
        .unwrap_or(true)
}

fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    let store = app
        .store(SETTINGS_STORE)
        .map_err(|e| format!("could not open the dictation history settings: {e}"))?;
    store.set(ENABLED_KEY, serde_json::json!(enabled));
    store
        .save()
        .map_err(|e| format!("could not save the dictation history settings: {e}"))
}

// ------------------------------------------------------------------ paths

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dictation_dir(app)?.join(DATABASE_FILE))
}

/// Clips are sharded by the first two characters of their id, so a heavy user's
/// thousands of files never land in one directory. The uid deliberately never
/// appears in a path: it lives in the row and in the AAD only.
fn clip_relative(id: &str) -> String {
    format!("{CLIPS_DIR}/{}/{id}.flac.enc", &id[..2])
}

fn clip_path(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    Ok(dictation_dir(app)?.join(relative))
}

fn open(app: &AppHandle) -> Result<Connection, String> {
    let conn = Connection::open(db_path(app)?).map_err(|e| e.to_string())?;
    conn.execute_batch(
        // A dictation finishing while the page is listing is a real overlap,
        // and each side opens its own connection, so without a busy timeout
        // one of them fails outright instead of waiting a few milliseconds.
        "PRAGMA busy_timeout = 3000;",
    )
    .map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS transcripts (
            uid TEXT NOT NULL,
            id TEXT NOT NULL,
            recorded_at_ms INTEGER NOT NULL,
            word_count INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            text BLOB NOT NULL,
            flagged INTEGER NOT NULL DEFAULT 0,
            audio_path TEXT,
            audio_bytes INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (uid, id)
         );
         CREATE INDEX IF NOT EXISTS transcripts_recent
            ON transcripts (uid, recorded_at_ms DESC);
         CREATE INDEX IF NOT EXISTS transcripts_audio_sweep
            ON transcripts (recorded_at_ms) WHERE audio_path IS NOT NULL;",
    )
    .map_err(|e| e.to_string())?;
    // Nullable column added after v0.11.2: the raw transcript as it left ASR,
    // stored only when AI polish changed it. CREATE TABLE IF NOT EXISTS is a
    // no-op on an existing table, so the upgrade is this guarded ALTER; the
    // only expected error is "duplicate column name" on an already-upgraded DB.
    let _ = conn.execute_batch("ALTER TABLE transcripts ADD COLUMN raw_text BLOB;");
    // Sharing state (share.rs). Same guarded-ALTER upgrade as raw_text above.
    // These live on the transcript row rather than in a second store because
    // the row already IS the record being shared; a parallel index was what the
    // retired trace subsystem did, and keeping two copies of the same dictation
    // in sync is the thing that made it worth deleting.
    let _ = conn.execute_batch(
        "ALTER TABLE transcripts ADD COLUMN share_state INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE transcripts ADD COLUMN share_attempts INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch(
        "ALTER TABLE transcripts ADD COLUMN share_next_attempt_ms INTEGER NOT NULL DEFAULT 0;",
    );
    let _ = conn.execute_batch("ALTER TABLE transcripts ADD COLUMN shared_at_ms INTEGER;");
    // The id the server knows this row by. Not the row id: the backend requires
    // 24 lowercase hex and `new_id` produces 16, while rows imported from the
    // retired store already carry a 24-hex id that must be preserved.
    let _ = conn.execute_batch("ALTER TABLE transcripts ADD COLUMN share_trace_id TEXT;");
    conn.execute_batch(
        // An uploaded row deleted locally leaves an obligation to delete the
        // server's copy. It outlives the row, so it cannot live on it.
        "CREATE TABLE IF NOT EXISTS share_deletions (
            uid TEXT NOT NULL,
            trace_id TEXT NOT NULL,
            requested_at_ms INTEGER NOT NULL,
            PRIMARY KEY (uid, trace_id)
         );
         CREATE TABLE IF NOT EXISTS share_quota_pause (
            uid TEXT PRIMARY KEY,
            blocked_until_ms INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS transcripts_share_queue
            ON transcripts (uid, share_next_attempt_ms) WHERE share_state = 1;",
    )
    .map_err(|e| e.to_string())?;
    Ok(conn)
}

/// The connection, for `share.rs`. Same reasoning as `open_for_import`.
#[cfg(any(windows, target_os = "macos"))]
pub(super) fn open_for_share(app: &AppHandle) -> Result<Connection, String> {
    open(app)
}

/// Clip path resolution, for `share.rs`.
#[cfg(any(windows, target_os = "macos"))]
pub(super) fn clip_path_for_share(app: &AppHandle, relative: &str) -> Result<PathBuf, String> {
    clip_path(app, relative)
}

/// The per-row AAD grammar, for `share.rs`. Exposed rather than re-derived so
/// the two cannot drift: a mismatched AAD reads as corruption, not as a bug.
#[cfg(any(windows, target_os = "macos"))]
pub(super) fn share_row_aad(uid: &str, id: &str, slot: &str) -> String {
    row_aad(uid, id, slot)
}

/// The connection, for `import_traces.rs`. Exposed rather than duplicated so
/// the migration cannot drift from the schema or the busy timeout.
#[cfg(any(windows, target_os = "macos"))]
pub(super) fn open_for_import(app: &AppHandle) -> Result<Connection, String> {
    open(app)
}

/// Writes one migrated dictation, sealing it exactly as a freshly captured one
/// is: same AAD grammar, same clip layout, same FLAC encode. `pcm` is None when
/// the old clip was missing or unreadable, which lands the row as text only -
/// the same `has_audio: false` state eviction produces.
#[cfg(any(windows, target_os = "macos"))]
#[allow(clippy::too_many_arguments)]
pub(super) fn insert_imported(
    app: &AppHandle,
    conn: &Connection,
    key: &[u8; 32],
    uid: &str,
    id: &str,
    recorded_at_ms: i64,
    text: &str,
    duration_ms: i64,
    pcm: Option<&[i32]>,
) -> Result<(), String> {
    let sealed_text = seal(key, text, &row_aad(uid, id, "text"))?;
    let mut relative: Option<String> = None;
    let mut audio_bytes: i64 = 0;
    if let Some(pcm) = pcm {
        match store_pcm(app, key, uid, id, pcm) {
            Ok(written) => {
                relative = Some(clip_relative(id));
                audio_bytes = written;
            }
            Err(error) => warn!("dictation.history: imported clip was not saved: {error}"),
        }
    }
    conn.execute(
        "INSERT INTO transcripts (
            uid, id, recorded_at_ms, word_count, duration_ms, text,
            flagged, audio_path, audio_bytes, raw_text
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, NULL)",
        params![
            uid,
            id,
            recorded_at_ms,
            super::usage::word_count(text) as i64,
            duration_ms,
            sealed_text,
            relative,
            audio_bytes,
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// A 16-character random hex id. Random rather than sequential so a clip's
/// filename says nothing about when it was made or how many exist.
fn new_id() -> String {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).expect("system RNG");
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ------------------------------------------------------------------ sweep

/// Drops everything past either text bound, then evicts audio past either audio
/// bound, oldest first. Audio eviction unlinks the file and NULLs the column;
/// the row itself survives until the age or count bound takes it.
fn sweep(app: &AppHandle, conn: &Connection, uid: &str) -> Result<(), String> {
    let cutoff = now_ms() - MAX_AGE_MS;
    let mut doomed: Vec<String> = Vec::new();
    {
        let mut statement = conn
            .prepare(
                "SELECT audio_path FROM transcripts
                 WHERE uid = ?1 AND audio_path IS NOT NULL AND (
                    recorded_at_ms < ?2
                    OR id NOT IN (
                        SELECT id FROM transcripts WHERE uid = ?1
                        ORDER BY recorded_at_ms DESC LIMIT ?3
                    )
                 )",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![uid, cutoff, MAX_ENTRIES], |row| {
                row.get::<_, String>(0)
            })
            .map_err(|e| e.to_string())?;
        doomed.extend(rows.flatten());
    }
    conn.execute(
        "DELETE FROM transcripts
         WHERE uid = ?1 AND (
            recorded_at_ms < ?2
            OR id NOT IN (
                SELECT id FROM transcripts WHERE uid = ?1
                ORDER BY recorded_at_ms DESC LIMIT ?3
            )
         )",
        params![uid, cutoff, MAX_ENTRIES],
    )
    .map_err(|e| e.to_string())?;

    // Size budget. Evicts the oldest audio first and keeps its transcript, so
    // the user loses replay long before they lose the words.
    let mut total: i64 = conn
        .query_row(
            "SELECT COALESCE(SUM(audio_bytes), 0) FROM transcripts
             WHERE uid = ?1 AND audio_path IS NOT NULL",
            params![uid],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if total > MAX_AUDIO_BYTES {
        let mut evict: Vec<(String, String)> = Vec::new();
        {
            let mut statement = conn
                .prepare(
                    "SELECT id, audio_path, audio_bytes FROM transcripts
                     WHERE uid = ?1 AND audio_path IS NOT NULL
                     ORDER BY recorded_at_ms ASC",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map(params![uid], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            for (id, relative, bytes) in rows.flatten() {
                if total <= MAX_AUDIO_BYTES {
                    break;
                }
                total -= bytes;
                evict.push((id, relative));
            }
        }
        for (id, relative) in evict {
            conn.execute(
                "UPDATE transcripts SET audio_path = NULL, audio_bytes = 0
                 WHERE uid = ?1 AND id = ?2",
                params![uid, id],
            )
            .map_err(|e| e.to_string())?;
            doomed.push(relative);
        }
    }

    remove_clips(app, &doomed);
    Ok(())
}

// ----------------------------------------------------------------- writing

/// Off the dictation worker thread. Takes ownership of the captured samples so
/// the hot path pays one `String` clone and nothing else; the FLAC encode, the
/// seal and the insert all happen on the blocking pool while the HUD caption is
/// already on screen.
///
/// Every failure here is swallowed after a warn. The words were already typed
/// by the time this runs, so a full disk must never surface in the HUD or
/// change what the user just saw happen.
pub fn record_later(
    app: &AppHandle,
    text: String,
    raw_text: Option<String>,
    samples: Vec<f32>,
    duration_ms: i64,
    words: u64,
) {
    if !ENCRYPTION_AVAILABLE || text.trim().is_empty() || !is_enabled(app) {
        return;
    }
    let Some(uid) = crate::security::current_uid(app) else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = record(
            &app,
            &uid,
            &text,
            raw_text.as_deref(),
            &samples,
            duration_ms,
            words,
        ) {
            warn!("dictation.history: entry was not saved: {error}");
        }
    });
}

fn record(
    app: &AppHandle,
    uid: &str,
    text: &str,
    raw_text: Option<&str>,
    samples: &[f32],
    duration_ms: i64,
    words: u64,
) -> Result<(), String> {
    let key = load_or_create_key(app)?;
    let id = new_id();
    let sealed_text = seal(&key, text, &row_aad(uid, &id, "text"))?;
    let sealed_raw = match raw_text {
        Some(raw) => Some(seal(&key, raw, &row_aad(uid, &id, "raw"))?),
        None => None,
    };

    // The clip is best effort on top of the transcript. A row with no audio is
    // a normal state; a transcript lost because its audio failed is not.
    let mut relative: Option<String> = None;
    let mut audio_bytes: i64 = 0;
    if !samples.is_empty() {
        match store_clip(app, &key, uid, &id, samples) {
            Ok(written) => {
                relative = Some(clip_relative(&id));
                audio_bytes = written;
            }
            Err(error) => warn!("dictation.history: clip was not saved: {error}"),
        }
    }

    let conn = open(app)?;
    conn.execute(
        "INSERT INTO transcripts (
            uid, id, recorded_at_ms, word_count, duration_ms, text,
            flagged, audio_path, audio_bytes, raw_text
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)",
        params![
            uid,
            id,
            now_ms(),
            words as i64,
            duration_ms,
            sealed_text,
            relative,
            audio_bytes,
            sealed_raw,
        ],
    )
    .map_err(|e| e.to_string())?;
    sweep(app, &conn, uid)
}

/// Encodes to FLAC, seals, and writes atomically. Returns the encrypted size,
/// which is what the audio budget is measured in.
#[cfg(not(any(windows, target_os = "macos")))]
fn store_clip(
    _app: &AppHandle,
    _key: &[u8; 32],
    _uid: &str,
    _id: &str,
    _samples: &[f32],
) -> Result<i64, String> {
    Err(UNAVAILABLE.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
fn store_clip(
    app: &AppHandle,
    key: &[u8; 32],
    uid: &str,
    id: &str,
    samples: &[f32],
) -> Result<i64, String> {
    let pcm: Vec<i32> = super::audio::to_i16(samples)
        .into_iter()
        .map(i32::from)
        .collect();
    store_pcm(app, key, uid, id, &pcm)
}

/// The one place a clip is encoded, sealed and written. Live capture arrives
/// here as f32 through `store_clip`; the trace import arrives with i16-derived
/// samples it decoded from the old WAV. Both must produce byte-identical
/// on-disk shape, so neither gets its own copy of this.
#[cfg(any(windows, target_os = "macos"))]
fn store_pcm(
    app: &AppHandle,
    key: &[u8; 32],
    uid: &str,
    id: &str,
    pcm: &[i32],
) -> Result<i64, String> {
    let flac = crate::meeting::audio::encode_flac(pcm, 1)?;
    let sealed = crate::crypto::encrypt_with_aad(key, &flac, row_aad(uid, id, "audio").as_bytes())?;
    let relative = clip_relative(id);
    let path = clip_path(app, &relative)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    crate::fsx::write_atomic(&path, &sealed, crate::fsx::Durability::Fsync)?;
    Ok(sealed.len() as i64)
}

// ---------------------------------------------------------------- commands

/// Every stored dictation for this account, newest first, with the retention
/// sweep run first. Text is decrypted here rather than searched in SQL: the
/// column is ciphertext, so there is no plaintext-searchable copy anywhere and
/// the dashboard filters the decrypted array in memory instead.
#[tauri::command]
pub async fn dictation_history_list(
    app: AppHandle,
    uid: String,
) -> Result<Vec<DictationHistoryEntry>, String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Ok(Vec::new());
    }
    tauri::async_runtime::spawn_blocking(move || {
        // Migrates the retired trace store on first sight, before anything is
        // read, so those dictations are simply present rather than being an
        // opt-in the user has to discover. Idempotent and flag-guarded, so
        // every later list pays one boolean.
        #[cfg(windows)]
        super::import_traces::run_once(&app, &uid);
        let key = load_or_create_key(&app)?;
        let conn = open(&app)?;
        sweep(&app, &conn, &uid)?;
        let mut statement = conn
            .prepare(
                "SELECT id, recorded_at_ms, word_count, duration_ms, text, flagged, audio_path,
                        raw_text
                 FROM transcripts WHERE uid = ?1 ORDER BY recorded_at_ms DESC",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![uid], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<Vec<u8>>>(7)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        // Resolved once: clip_path() goes through dictation_dir(), which
        // creates the directory, and doing that per row would be one syscall
        // per stored dictation on every page load.
        let dir = dictation_dir(&app)?;
        let mut entries = Vec::new();
        for (id, recorded_at_ms, word_count, duration_ms, sealed, flagged, audio_path, sealed_raw) in
            rows.flatten()
        {
            // A row that will not decrypt is skipped, never fatal: one bad blob
            // must not make the whole page unreadable.
            let Ok(text) = unseal(&key, &sealed, &row_aad(&uid, &id, "text")) else {
                continue;
            };
            // The raw slot degrades to None instead, so a bad raw blob costs
            // the "view original speech" affordance, not the whole entry.
            let raw_text = sealed_raw
                .and_then(|sealed| unseal(&key, &sealed, &row_aad(&uid, &id, "raw")).ok());
            let has_audio = audio_path
                .as_deref()
                .is_some_and(|relative| dir.join(relative).exists());
            entries.push(DictationHistoryEntry {
                id,
                recorded_at_ms,
                text,
                word_count,
                duration_ms,
                has_audio,
                flagged: flagged != 0,
                raw_text,
            });
        }
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The decrypted FLAC bytes for one clip, raw over IPC so there is no base64
/// round trip. The dashboard wraps them in a Blob and plays that. The asset
/// protocol cannot be used, because what is on disk is ciphertext, and writing
/// a decrypted temp file to make it work would put unowned plaintext audio on
/// the very disk this module exists to keep it off.
#[tauri::command]
pub async fn dictation_history_audio(
    app: AppHandle,
    uid: String,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Err("dictation history is unavailable".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let plain = read_clip(&app, &uid, &id)?;
        Ok(tauri::ipc::Response::new(plain))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(any(windows, target_os = "macos")))]
fn read_clip(_app: &AppHandle, _uid: &str, _id: &str) -> Result<Vec<u8>, String> {
    Err(UNAVAILABLE.to_string())
}

#[cfg(any(windows, target_os = "macos"))]
fn read_clip(app: &AppHandle, uid: &str, id: &str) -> Result<Vec<u8>, String> {
    let key = load_or_create_key(app)?;
    let conn = open(app)?;
    let relative: Option<String> = conn
        .query_row(
            "SELECT audio_path FROM transcripts WHERE uid = ?1 AND id = ?2",
            params![uid, id],
            |row| row.get(0),
        )
        .map_err(|_| "that dictation is no longer stored".to_string())?;
    let relative = relative.ok_or_else(|| "no audio is stored for this dictation".to_string())?;
    let sealed = std::fs::read(clip_path(app, &relative)?)
        .map_err(|_| "the audio for this dictation is no longer stored".to_string())?;
    crate::crypto::decrypt_with_aad(&key, &sealed, row_aad(uid, id, "audio").as_bytes())
}

#[tauri::command]
pub async fn dictation_history_set_flag(
    app: AppHandle,
    uid: String,
    id: String,
    flagged: bool,
) -> Result<(), String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        conn.execute(
            "UPDATE transcripts SET flagged = ?3 WHERE uid = ?1 AND id = ?2",
            params![uid, id, i64::from(flagged)],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_history_delete(
    app: AppHandle,
    uid: String,
    id: String,
) -> Result<(), String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let relative: Option<String> = conn
            .query_row(
                "SELECT audio_path FROM transcripts WHERE uid = ?1 AND id = ?2",
                params![uid, id],
                |row| row.get(0),
            )
            .unwrap_or(None);
        conn.execute(
            "DELETE FROM transcripts WHERE uid = ?1 AND id = ?2",
            params![uid, id],
        )
        .map_err(|e| e.to_string())?;
        // Row first, file second. An orphan file is reaped by the next sweep,
        // but a row pointing at a deleted file would show a play button that
        // cannot work.
        if let Some(relative) = relative {
            remove_clips(&app, std::slice::from_ref(&relative));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Empties the history for one account, or for every account when `uid` is
/// absent. Drops the clip tree wholesale rather than file by file.
#[tauri::command]
pub async fn dictation_history_clear(app: AppHandle, uid: Option<String>) -> Result<(), String> {
    if !ENCRYPTION_AVAILABLE {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        match uid {
            Some(id) if !id.is_empty() => {
                let doomed = clip_paths(&conn, Some(&id))?;
                conn.execute("DELETE FROM transcripts WHERE uid = ?1", params![id])
                    .map_err(|e| e.to_string())?;
                remove_clips(&app, &doomed);
            }
            _ => {
                conn.execute("DELETE FROM transcripts", [])
                    .map_err(|e| e.to_string())?;
                drop_clip_tree(&app);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_history_export_audio(
    app: AppHandle,
    uid: String,
    id: String,
) -> Result<String, String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Err("dictation history is unavailable".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let plain = read_clip(&app, &uid, &id)?;
        write_export(&app, &uid, &id, "flac", &plain)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_history_export_text(
    app: AppHandle,
    uid: String,
    id: String,
) -> Result<String, String> {
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Err("dictation history is unavailable".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let key = load_or_create_key(&app)?;
        let sealed: Vec<u8> = {
            let conn = open(&app)?;
            conn.query_row(
                "SELECT text FROM transcripts WHERE uid = ?1 AND id = ?2",
                params![uid, id],
                |row| row.get(0),
            )
            .map_err(|_| "that dictation is no longer stored".to_string())?
        };
        let text = unseal(&key, &sealed, &row_aad(&uid, &id, "text"))?;
        write_export(&app, &uid, &id, "txt", text.as_bytes())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_history_settings(
    app: AppHandle,
    uid: String,
) -> Result<HistorySettings, String> {
    let enabled = is_enabled(&app);
    if !ENCRYPTION_AVAILABLE || uid.is_empty() {
        return Ok(HistorySettings {
            enabled,
            audio_bytes: 0,
            entry_count: 0,
        });
    }
    tauri::async_runtime::spawn_blocking(move || {
        let conn = open(&app)?;
        let (audio_bytes, entry_count): (i64, i64) = conn
            .query_row(
                "SELECT COALESCE(SUM(audio_bytes), 0), COUNT(*) FROM transcripts WHERE uid = ?1",
                params![uid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        Ok(HistorySettings {
            enabled,
            audio_bytes,
            entry_count,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Turning history off stops future capture. It deliberately does NOT delete
/// what is already stored: "stop recording me" and "erase what you have" are
/// different requests, and conflating them would destroy data on a toggle flip.
/// Clearing is the separate, explicitly confirmed action.
#[tauri::command]
pub async fn dictation_history_set_settings(
    app: AppHandle,
    uid: String,
    enabled: bool,
) -> Result<HistorySettings, String> {
    set_enabled(&app, enabled)?;
    dictation_history_settings(app, uid).await
}

// ------------------------------------------------------------ session hook

/// Relative clip paths, either for one account or for every account.
fn clip_paths(conn: &Connection, uid: Option<&str>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    match uid {
        Some(uid) => {
            let mut statement = conn
                .prepare(
                    "SELECT audio_path FROM transcripts
                     WHERE uid = ?1 AND audio_path IS NOT NULL",
                )
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map(params![uid], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            out.extend(rows.flatten());
        }
        None => {
            let mut statement = conn
                .prepare("SELECT audio_path FROM transcripts WHERE audio_path IS NOT NULL")
                .map_err(|e| e.to_string())?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            out.extend(rows.flatten());
        }
    }
    Ok(out)
}

fn remove_clips(app: &AppHandle, relatives: &[String]) {
    if relatives.is_empty() {
        return;
    }
    // Resolved once for the same reason the list read does it: clip_path goes
    // through dictation_dir, which creates the directory.
    let Ok(dir) = dictation_dir(app) else {
        return;
    };
    for relative in relatives {
        let _ = std::fs::remove_file(dir.join(relative));
    }
}

fn drop_clip_tree(app: &AppHandle) {
    if let Ok(dir) = dictation_dir(app) {
        let _ = std::fs::remove_dir_all(dir.join(CLIPS_DIR));
    }
}

/// Native session-boundary hook, mirroring `interview_store::retain_only_for_session`
/// but deleting clip files as well as rows. Runs on EVERY transition, not only
/// a revoke, so a sign-in following a crash still drops the previous account's
/// dictations before the dashboard can paint them.
///
/// Paths are collected first, rows deleted second, files unlinked last: a crash
/// in between leaves orphan files, which the next sweep reaps, rather than rows
/// pointing at nothing.
pub fn retain_only_for_session(app: &AppHandle, uid: Option<String>) {
    if !ENCRYPTION_AVAILABLE {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tauri::async_runtime::spawn_blocking(move || {
            let conn = open(&app)?;
            match uid {
                Some(id) if !id.is_empty() => {
                    let keep = clip_paths(&conn, Some(&id))?;
                    let doomed: Vec<String> = clip_paths(&conn, None)?
                        .into_iter()
                        .filter(|path| !keep.contains(path))
                        .collect();
                    conn.execute("DELETE FROM transcripts WHERE uid <> ?1", params![id])
                        .map_err(|e| e.to_string())?;
                    remove_clips(&app, &doomed);
                }
                // No uid to scope by, which means signed out. That is NOT a
                // reason to destroy anything: every read is already uid-scoped,
                // so isolation does not need deletion, and signing back in must
                // return the user's own history. Deleting here conflated "nobody
                // is looking" with "this must die", and because a transient
                // signed-out report arrives on every launch it wiped the whole
                // store between sessions. Account switches still prune, in the
                // arm above. Explicit erasure (account deletion, clear history)
                // does not route through this function.
                _ => {
                    warn!("dictation.history: session prune skipped, no uid to scope by");
                }
            }
            Ok::<(), String>(())
        })
        .await;
        match result {
            Ok(Err(error)) => warn!("dictation.history: session prune failed: {error}"),
            Err(error) => warn!("dictation.history: session prune join failed: {error}"),
            Ok(Ok(())) => {}
        }
    });
}

// ----------------------------------------------------------------- exports

/// Writes a decrypted copy into the user's Downloads folder and returns its
/// path, so React can hand it to `openPath`. Same shape as the meeting module's
/// export: no file-picker plugin is a dependency, and adding one for a single
/// save dialog is more surface than the established pattern.
fn write_export(
    app: &AppHandle,
    uid: &str,
    id: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let recorded_at_ms: i64 = {
        let conn = open(app)?;
        conn.query_row(
            "SELECT recorded_at_ms FROM transcripts WHERE uid = ?1 AND id = ?2",
            params![uid, id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| now_ms())
    };
    let dir = app
        .path()
        .download_dir()
        .map_err(|e| e.to_string())?
        .join("Aura Dictation");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}-{}.{extension}", stamp(recorded_at_ms), &id[..8]));
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// `yyyy-mm-dd-hhmm` in UTC, so an exported filename sorts correctly and never
/// depends on a locale.
fn stamp(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let (year, month, day) = civil_from_days(seconds.div_euclid(86_400));
    let time = seconds.rem_euclid(86_400);
    format!(
        "{year:04}-{month:02}-{day:02}-{:02}{:02}",
        time / 3600,
        (time % 3600) / 60
    )
}

/// Howard Hinnant's civil-from-days. Inline so an export filename needs no date
/// crate, which the tree does not otherwise carry.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}
