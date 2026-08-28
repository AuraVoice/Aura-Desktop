//! App-wide at-rest encryption: AES-256-GCM with per-feature keys wrapped by
//! Windows DPAPI (current-user scope).
//!
//! DPAPI is the right wrapper here because it keys off the Windows user
//! account itself: a wrapped key file is useless copied to another machine or
//! user profile, with zero password/keychain UX. The unwrapped key never
//! touches disk. Payload layout: 12-byte random nonce || ciphertext+tag.
//!
//! This module owns the mechanism only. Each feature owns its OWN key file
//! and location (meeting/crypto.rs, dictation/vocab.rs) so that, for example,
//! deleting the meeting captures directory cannot silently brick the
//! dictation vocabulary.

#![cfg(windows)]

use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{LocalFree, HLOCAL};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

pub const NONCE_LEN: usize = 12;

/// Loads the AES-256 key at `path`, minting and DPAPI-wrapping a fresh one on
/// first use. A wrapped blob that no longer unwraps fails closed rather than
/// being replaced: swapping the key would make everything sealed under it
/// permanently unreadable while making new writes appear healthy. `label`
/// names the owning feature in error strings. The first write takes the
/// hardened create_new + write-through path so two concurrent processes can
/// never clobber each other's freshly minted key. The caller owns creating
/// the parent directory.
pub fn load_or_create_key_at(path: &Path, label: &str) -> Result<[u8; 32], String> {
    if let Ok(wrapped) = std::fs::read(path) {
        let key_bytes = dpapi_unprotect(&wrapped)
            .map_err(|e| format!("stored {label} key could not be unwrapped: {e}"))?;
        if key_bytes.len() != 32 {
            return Err(format!("stored {label} key has an invalid length"));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_bytes);
        return Ok(key);
    }

    let key = Aes256Gcm::generate_key(OsRng);
    let wrapped = dpapi_protect(key.as_slice())?;
    crate::fsx::write_atomic(path, &wrapped, crate::fsx::Durability::WriteThrough)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(key.as_slice());
    Ok(out)
}

/// Encryption without associated data.
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

/// Encryption that binds the ciphertext to caller-supplied associated data,
/// so a sealed value cannot be replayed into a different row or owner.
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

/// Decryption without associated data.
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
