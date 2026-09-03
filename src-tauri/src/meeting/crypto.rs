//! Segments-at-rest encryption for meeting captures. The AES-GCM mechanism and
//! its per-OS key wrapping live in crate::crypto; this module owns what is
//! genuinely meeting-specific: the key file location under the captures
//! directory and the "meeting" label in key errors. Segment layout: 12-byte
//! random nonce || ciphertext+tag.

use tauri::{AppHandle, Manager};

pub use crate::crypto::{decrypt, decrypt_with_aad, encrypt, encrypt_with_aad};

const KEY_FILE: &str = "key.bin";

fn key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(super::queue::CAPTURES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(KEY_FILE))
}

/// Loads the segment key, minting and wrapping a fresh one on first use. A
/// wrapped blob that no longer unwraps fails closed. Replacing it would
/// make every retained recording permanently unreadable while making new
/// captures appear healthy.
pub fn load_or_create_key(app: &AppHandle) -> Result<[u8; 32], String> {
    crate::crypto::load_or_create_key_at(&key_path(app)?, "meeting")
}
