//! One-shot import of the retired trace store into the dictation history.
//!
//! The trace subsystem (`dictation/trace/`, removed in 9227b79 and 3e63a25)
//! wrote its own encrypted store next to this one and left it behind when the
//! code was deleted:
//!
//! ```text
//! dictation/traces/
//!   index.enc              serde_json(TraceIndex), sealed with vocab::encrypt
//!   audio/<id>.wav.enc     16 kHz mono 16-bit PCM WAV, same key, no AAD
//! ```
//!
//! Both were sealed with the SAME dictation key this store uses, which is the
//! only reason this migration is possible at all: `key.bin` never changed.
//!
//! Two format differences to bridge:
//!
//! - The old blobs used `vocab::encrypt`/`decrypt`, the plain non-AAD pair.
//!   Everything written here is resealed with per-row AAD, so an imported clip
//!   ends up as well bound to its row as a natively captured one.
//! - The old audio is WAV, this store is FLAC. The samples are identical
//!   (16 kHz mono, straight from `dictation::audio`), so this decodes the fixed
//!   44-byte header and re-encodes rather than transcoding anything.
//!
//! Idempotent: imported rows keep their original `traceId`, so the primary key
//! makes a second run a no-op rather than a duplicate. Nothing in `traces/` is
//! deleted - the user removes it themselves once they trust the result.

#![cfg(windows)]

use std::path::PathBuf;

use log::{info, warn};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::history;
use super::vocab::{decrypt, dictation_dir, load_or_create_key};

const TRACES_DIR: &str = "traces";
const INDEX_FILE: &str = "index.enc";
const AUDIO_DIR: &str = "audio";

/// The canonical RIFF/WAVE header the old writer emitted, byte for byte. It
/// never varied, so the decode below can skip it rather than walk chunks.
const WAV_HEADER_BYTES: usize = 44;

/// Only the fields the history store needs. Deserializing a subset is
/// deliberate: the retired record carried the app name, field identity, token
/// timings, edit ops and upload bookkeeping, and none of that is wanted here.
/// `serde` ignores what is not named.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceRecord {
    trace_id: String,
    recorded_at_ms: i64,
    audio_ms: u32,
    #[serde(default)]
    has_audio: bool,
    /// What Aura actually typed, which is what this store records.
    #[serde(default)]
    inserted_text: String,
    /// The pre-correction decode, used only when `inserted_text` is empty.
    #[serde(default)]
    raw_transcript: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TraceIndex {
    #[serde(default)]
    traces: Vec<TraceRecord>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    /// Records found in the old index.
    pub found: i64,
    /// Rows written on this run.
    pub imported: i64,
    /// Already present, so skipped. A re-run reports everything here.
    pub skipped: i64,
    /// Imported as text because the clip was missing or would not decode.
    pub without_audio: i64,
}

fn traces_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dictation_dir(app)?.join(TRACES_DIR))
}

/// Whether the retired store still exists at all. A missing file is the normal
/// case on a fresh install and is not an error.
fn traces_present(app: &AppHandle) -> bool {
    traces_dir(app).is_ok_and(|dir| dir.join(INDEX_FILE).exists())
}

fn read_index(app: &AppHandle) -> Result<TraceIndex, String> {
    let path = traces_dir(app)?.join(INDEX_FILE);
    let sealed = std::fs::read(&path).map_err(|e| e.to_string())?;
    let key = load_or_create_key(app)?;
    let plain = decrypt(&key, &sealed)?;
    serde_json::from_slice(&plain).map_err(|e| e.to_string())
}

/// Decodes the old 16-bit PCM WAV into the `i32` samples flacenc wants.
///
/// Returns None for anything that is not the header this writer produced, so a
/// stray file in that folder is skipped rather than imported as noise.
fn wav_to_pcm(wav: &[u8]) -> Option<Vec<i32>> {
    if wav.len() <= WAV_HEADER_BYTES || &wav[0..4] != b"RIFF" || &wav[8..12] != b"WAVE" {
        return None;
    }
    Some(
        wav[WAV_HEADER_BYTES..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| i32::from(i16::from_le_bytes(*pair)))
            .collect(),
    )
}

/// Runs the migration once, if it has not run for this account yet.
///
/// Called from `dictation_history_list` rather than exposed as a button: there
/// is exactly one right answer here (the records are the user's own dictations
/// and they expect to see them), so asking would have been a question with no
/// wrong answer to protect against.
///
/// The uid is the caller's, because the retired records predate account scoping
/// and carry none of their own. That also means the imported rows obey the same
/// sign-out wipe as everything else from the moment they land.
pub fn run_once(app: &AppHandle, uid: &str) {
    if uid.is_empty() || !traces_present(app) || already_ran(app, uid) {
        return;
    }
    match import(app, uid) {
        Ok(summary) => {
            info!(
                "dictation.history: import found={} imported={} skipped={} without_audio={}",
                summary.found, summary.imported, summary.skipped, summary.without_audio
            );
            mark_ran(app, uid);
        }
        // Left unmarked so the next list retries. A failed import must not
        // silently become "there was nothing to import".
        Err(error) => warn!("dictation.history: trace import failed: {error}"),
    }
}

fn import(app: &AppHandle, uid: &str) -> Result<ImportSummary, String> {
    let index = read_index(app)?;
    let key = load_or_create_key(app)?;
    let audio_dir = traces_dir(app)?.join(AUDIO_DIR);
    let conn = history::open_for_import(app)?;

    let mut summary = ImportSummary {
        found: index.traces.len() as i64,
        ..Default::default()
    };

    for record in &index.traces {
        let text = if record.inserted_text.trim().is_empty() {
            record.raw_transcript.trim()
        } else {
            record.inserted_text.trim()
        };
        if text.is_empty() || record.trace_id.len() < 8 {
            summary.skipped += 1;
            continue;
        }

        let already: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM transcripts WHERE uid = ?1 AND id = ?2",
                params![uid, record.trace_id],
                |row| row.get(0),
            )
            .unwrap_or(0);
        if already > 0 {
            summary.skipped += 1;
            continue;
        }

        // Audio is best effort, exactly as it is on the capture path: a
        // clip that will not decode costs its transcript nothing.
        let mut clip: Option<Vec<i32>> = None;
        if record.has_audio {
            let path = audio_dir.join(format!("{}.wav.enc", record.trace_id));
            clip = std::fs::read(&path)
                .ok()
                .and_then(|sealed| decrypt(&key, &sealed).ok())
                .as_deref()
                .and_then(wav_to_pcm);
        }
        if clip.is_none() {
            summary.without_audio += 1;
        }

        match history::insert_imported(
            app,
            &conn,
            &key,
            uid,
            &record.trace_id,
            record.recorded_at_ms,
            text,
            i64::from(record.audio_ms),
            clip.as_deref(),
        ) {
            Ok(()) => summary.imported += 1,
            Err(error) => {
                // Never a transcript in the message, same as everywhere
                // else in this module.
                warn!("dictation.history: one trace did not import: {error}");
                summary.skipped += 1;
            }
        }
    }

    Ok(summary)
}

/// The one-time marker, per account, in the history settings store. Keyed by
/// uid so a second account on the same machine gets its own decision rather
/// than inheriting one it was never part of.
fn ran_key(uid: &str) -> String {
    format!("tracesImported:{uid}")
}

fn already_ran(app: &AppHandle, uid: &str) -> bool {
    use tauri_plugin_store::StoreExt;
    // Fails CLOSED: an unreadable store means "assume it ran", because a
    // repeated import is wasted work on every single page load. The rows are
    // already idempotent, so nothing is lost by being cautious here.
    app.store(history::SETTINGS_STORE).is_ok_and(|store| {
        store
            .get(ran_key(uid))
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
    })
}

fn mark_ran(app: &AppHandle, uid: &str) {
    use tauri_plugin_store::StoreExt;
    let Ok(store) = app.store(history::SETTINGS_STORE) else {
        return;
    };
    store.set(ran_key(uid), serde_json::json!(true));
    let _ = store.save();
}
