//! App-wide at-rest encryption: AES-256-GCM with per-feature keys wrapped by
//! the OS account keystore.
//!
//! The CIPHER is cross-platform. Only the key WRAPPING is per-OS, and that is
//! the whole platform seam of this module (`keywrap` below):
//!
//! - Windows wraps with DPAPI (current-user scope).
//! - macOS wraps with AES-GCM under a master key held in the login Keychain.
//!
//! Both give the same property, which is why the wrapped blob is safe to leave
//! on disk: it is useless copied to another machine or user account, with no
//! password UX. The unwrapped key never touches disk. Payload layout is
//! 12-byte random nonce || ciphertext+tag.
//!
//! This module owns the mechanism only. Each feature owns its OWN key file
//! and location (meeting/crypto.rs, dictation/vocab.rs) so that, for example,
//! deleting the meeting captures directory cannot silently brick the
//! dictation vocabulary. That layout is identical on both platforms.

use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};

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
        let key_bytes = keywrap::unwrap(&wrapped)
            .map_err(|e| format!("stored {label} key could not be unwrapped: {e}"))?;
        if key_bytes.len() != 32 {
            return Err(format!("stored {label} key has an invalid length"));
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(&key_bytes);
        return Ok(key);
    }

    let key = Aes256Gcm::generate_key(OsRng);
    let wrapped = keywrap::wrap(key.as_slice())?;
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

/// The one platform seam in this module: wrapping a freshly minted key so it
/// can rest on disk, and unwrapping it again. Everything above is shared.
///
/// Both implementations MUST fail closed. Returning "no key here" for anything
/// other than a genuinely absent key makes `load_or_create_key_at` mint a
/// replacement, which leaves every already-sealed row permanently unreadable
/// while new writes look perfectly healthy.
#[cfg(windows)]
mod keywrap {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    pub fn wrap(data: &[u8]) -> Result<Vec<u8>, String> {
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

    pub fn unwrap(data: &[u8]) -> Result<Vec<u8>, String> {
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
}

/// macOS has no DPAPI. The equivalent account-scoped secret store is the login
/// Keychain, so one master key lives there and wraps the per-feature key files
/// with the same AES-GCM used everywhere else. The key files stay exactly where
/// Windows puts them, which keeps the "each feature owns its own key file"
/// invariant identical across platforms.
///
/// The keychain item's access control is bound to the signing identity that
/// created it. BEFORE PUBLIC LAUNCH: replacing the individual Developer ID
/// with the company's changes the Team ID, so every beta install sees one
/// "Aura Desktop wants to use your confidential information" prompt on its
/// first launch after that update. "Always Allow" resolves it for good; Deny
/// leaves every encrypted store unavailable by design (see `master_key`), and
/// must never be answered by minting a replacement.
#[cfg(target_os = "macos")]
mod keywrap {
    use security_framework::passwords::{get_generic_password, set_generic_password};

    const SERVICE: &str = "com.aura.desktop";
    const ACCOUNT: &str = "at-rest-master-key";

    /// The ONLY status that may mint a new master key. Every other failure
    /// (locked keychain, denied ACL, user cancelled) means the key probably
    /// still exists and we must not replace it. See `keywrap`'s doc comment.
    const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

    fn master_key() -> Result<[u8; 32], String> {
        match get_generic_password(SERVICE, ACCOUNT) {
            Ok(bytes) => to_key(&bytes),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => mint(),
            Err(error) => Err(format!(
                "keychain is unavailable, refusing to mint a replacement key: {error}"
            )),
        }
    }

    fn mint() -> Result<[u8; 32], String> {
        use aes_gcm::aead::{KeyInit, OsRng};
        let fresh = aes_gcm::Aes256Gcm::generate_key(OsRng);
        set_generic_password(SERVICE, ACCOUNT, fresh.as_slice())
            .map_err(|e| format!("could not store the master key in the keychain: {e}"))?;
        // Read back rather than trusting what we just wrote: if a second
        // process minted concurrently, the keychain holds one winner and both
        // processes must agree on it before anything gets wrapped.
        let stored = get_generic_password(SERVICE, ACCOUNT)
            .map_err(|e| format!("could not read back the master key: {e}"))?;
        to_key(&stored)
    }

    fn to_key(bytes: &[u8]) -> Result<[u8; 32], String> {
        if bytes.len() != 32 {
            return Err("keychain master key has an invalid length".to_string());
        }
        let mut key = [0u8; 32];
        key.copy_from_slice(bytes);
        Ok(key)
    }

    pub fn wrap(data: &[u8]) -> Result<Vec<u8>, String> {
        super::encrypt(&master_key()?, data)
    }

    pub fn unwrap(data: &[u8]) -> Result<Vec<u8>, String> {
        super::decrypt(&master_key()?, data)
    }
}

/// No other desktop target ships, and guessing at a key store would be worse
/// than refusing. Failing here disables the encrypted stores rather than
/// writing anything in the clear.
#[cfg(not(any(windows, target_os = "macos")))]
mod keywrap {
    pub fn wrap(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("at-rest key wrapping is not supported on this platform".to_string())
    }

    pub fn unwrap(_data: &[u8]) -> Result<Vec<u8>, String> {
        Err("at-rest key wrapping is not supported on this platform".to_string())
    }
}
