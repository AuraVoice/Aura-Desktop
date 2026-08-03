//! Segments-at-rest encryption: AES-256-GCM with a per-install key wrapped by
//! Windows DPAPI (current-user scope).
//!
//! DPAPI is the right wrapper here because it keys off the Windows user
//! account itself: the wrapped key file is useless copied to another machine
//! or user profile, with zero password/keychain UX. The unwrapped key never
//! touches disk. Segment layout: 12-byte random nonce || ciphertext+tag.

#![cfg(windows)]

use std::io::Write;

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use tauri::{AppHandle, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

const KEY_FILE: &str = "key.bin";
const NONCE_LEN: usize = 12;

fn key_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(super::queue::CAPTURES_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(KEY_FILE))
}

/// Loads the segment key, minting and DPAPI-wrapping a fresh one on first
/// use. A wrapped blob that no longer unwraps fails closed. Replacing it would
/// make every retained recording permanently unreadable while making new
/// captures appear healthy.
pub fn load_or_create_key(app: &AppHandle) -> Result<[u8; 32], String> {
    let path = key_path(app)?;
    if let Ok(wrapped) = std::fs::read(&path) {
        let key_bytes = dpapi_unprotect(&wrapped)
            .map_err(|e| format!("stored meeting key could not be unwrapped: {e}"))?;
        if key_bytes.len() != 32 {
            return Err("stored meeting key has an invalid length".to_string());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_bytes);
        return Ok(key);
    }

    let key = Aes256Gcm::generate_key(OsRng);
    let wrapped = dpapi_protect(key.as_slice())?;
    let tmp = path.with_extension(format!("bin.{}.tmp", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&tmp)
        .map_err(|e| e.to_string())?;
    file.write_all(&wrapped).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    super::evidence_store::durable_rename(&tmp, &path)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(key.as_slice());
    Ok(out)
}

/// Legacy v1 encryption without associated data. Retained only so valid
/// manifest.json recordings can migrate and export.
pub fn encrypt(key: &[u8; 32], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(&nonce, plaintext)
        .map_err(|e| format!("encrypt failed: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// V2 encryption binds the ciphertext to its owner, meeting, capture run,
/// fence, sequence, and plaintext digest through caller-supplied AAD.
pub fn encrypt_with_aad(key: &[u8; 32], plaintext: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ciphertext = cipher
        .encrypt(
            &nonce,
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|e| format!("encrypt failed: {e}"))?;
    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Legacy v1 decryption without associated data.
pub fn decrypt(key: &[u8; 32], data: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() <= NONCE_LEN {
        return Err("segment too short to decrypt".to_string());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&data[..NONCE_LEN]);
    cipher
        .decrypt(nonce, &data[NONCE_LEN..])
        .map_err(|e| format!("decrypt failed: {e}"))
}

pub fn decrypt_with_aad(key: &[u8; 32], data: &[u8], aad: &[u8]) -> Result<Vec<u8>, String> {
    if data.len() <= NONCE_LEN {
        return Err("segment too short to decrypt".to_string());
    }
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key));
    let nonce = Nonce::from_slice(&data[..NONCE_LEN]);
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &data[NONCE_LEN..],
                aad,
            },
        )
        .map_err(|e| format!("decrypt failed: {e}"))
}

fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            PCWSTR::null(),
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("CryptProtectData failed: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(bytes)
    }
}

fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    let input = CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|e| format!("CryptUnprotectData failed: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as *mut core::ffi::c_void)));
        Ok(bytes)
    }
}
