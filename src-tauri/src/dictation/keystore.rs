//! The dictation directory and the key everything under it is sealed with.
//!
//! At rest every dictation artifact is AES-256-GCM encrypted under a key
//! wrapped by the platform (DPAPI in current-user scope on Windows, a locally
//! derived master key on macOS). The mechanism lives in `crate::crypto`, but
//! this module mints its OWN key in its OWN directory on purpose: meeting's
//! `key.bin` lives under the captures directory, so sharing it would mean
//! "delete my recordings" silently bricks dictation.
//!
//! This was `vocab.rs`, which also held a personalization store (user phrases,
//! confirmed corrections, contextual biasing and a post-decode correction
//! pass). That store had a complete read path on the utterance hot path and no
//! writer any UI could reach, so every lookup was a guaranteed miss bought with
//! two file reads and a double-metaphone encode per dictation. It was removed
//! rather than finished; the ASR handshake still carries a keyterms channel,
//! so a real vocabulary source can be added back without re-plumbing anything.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// Own directory, own key. See the module header for why this is not shared
/// with the meeting module's captures directory.
const DICTATION_DIR: &str = "dictation";
const KEY_FILE: &str = "key.bin";

pub(super) fn dictation_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(DICTATION_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Loads the dictation key, minting and wrapping a fresh one on first use.
///
/// A wrapped blob that no longer unwraps fails closed rather than being
/// replaced, so a machine or profile change surfaces as an error instead of
/// silently discarding history nobody can read any more. `crypto` owns that
/// rule; this module only says which key file it applies to.
pub(super) fn load_or_create_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let key_path = dictation_dir(app)?.join(KEY_FILE);
    crate::crypto::load_or_create_key_at(&key_path, "dictation")
}
