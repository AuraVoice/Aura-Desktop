//! App-wide at-rest encryption: AES-256-GCM with per-feature keys wrapped by
//! the OS account keystore.
//!
//! The CIPHER is cross-platform. Only the key WRAPPING is per-OS, and that is
//! the whole platform seam of this module (`keywrap` below):
//!
//! - Windows wraps with DPAPI (current-user scope).
//! - macOS wraps with AES-GCM under a master key derived from a local salt
//!   file and the machine's hardware UUID. Not the login Keychain: see the
//!   macOS `keywrap` below for why that was retired and must not come back.
//!
//! Both give the same property, which is why the wrapped blob is safe to leave
//! on disk: it is useless copied to another machine or user account, with no
//! password UX and no dialog of any kind. The unwrapped key never touches disk.
//! Payload layout is 12-byte random nonce || ciphertext+tag.
//!
//! This module owns the mechanism only. Each feature owns its OWN key file
//! and location (meeting/crypto.rs, dictation/vocab.rs) so that, for example,
//! deleting the meeting captures directory cannot silently brick the
//! dictation vocabulary. That layout is identical on both platforms.

use std::path::Path;

use aes_gcm::aead::{Aead, KeyInit, OsRng, Payload};
use aes_gcm::{AeadCore, Aes256Gcm, Key, Nonce};

pub const NONCE_LEN: usize = 12;

/// Marks a key file written by the current wrapping scheme. Everything this
/// module writes carries it; anything without it predates the scheme.
///
/// On Windows an unmarked file is a plain DPAPI blob and still unwraps, so
/// existing installs are untouched forever. On macOS an unmarked file was
/// wrapped by the login-Keychain master key that `keywrap` no longer has, and
/// nothing can recover it - see that module's doc comment for why the keychain
/// went away. Such a file is deleted and re-minted ONCE.
///
/// The marker is what keeps that reset bounded. A MARKED blob that will not
/// unwrap still fails closed, which is the invariant that matters: replacing a
/// key that is merely unreadable today makes every row sealed under it
/// permanently unreadable while new writes look healthy. Do not "simplify"
/// this into an unconditional re-mint on any unwrap failure.
const KEY_FILE_MAGIC: &[u8; 8] = b"AURAKW\x02\x00";

/// Loads the AES-256 key at `path`, minting and wrapping a fresh one on first
/// use. A wrapped blob that no longer unwraps fails closed rather than being
/// replaced: swapping the key would make everything sealed under it
/// permanently unreadable while making new writes appear healthy. `label`
/// names the owning feature in error strings. The first write takes the
/// hardened create_new + write-through path so two concurrent processes can
/// never clobber each other's freshly minted key. The caller owns creating
/// the parent directory.
pub fn load_or_create_key_at(path: &Path, label: &str) -> Result<[u8; 32], String> {
    if let Ok(stored) = std::fs::read(path) {
        match stored.strip_prefix(KEY_FILE_MAGIC) {
            Some(wrapped) => {
                let key_bytes = keywrap::unwrap(wrapped)
                    .map_err(|e| format!("stored {label} key could not be unwrapped: {e}"))?;
                if key_bytes.len() != 32 {
                    return Err(format!("stored {label} key has an invalid length"));
                }
                let mut key = [0u8; 32];
                key.copy_from_slice(&key_bytes);
                return Ok(key);
            }
            None => {
                if let Some(key) = unwrap_unmarked(&stored, path, label)? {
                    return Ok(key);
                }
            }
        }
    }

    let key = Aes256Gcm::generate_key(OsRng);
    let wrapped = keywrap::wrap(key.as_slice())?;
    let mut blob = Vec::with_capacity(KEY_FILE_MAGIC.len() + wrapped.len());
    blob.extend_from_slice(KEY_FILE_MAGIC);
    blob.extend_from_slice(&wrapped);
    crate::fsx::write_atomic(path, &blob, crate::fsx::Durability::WriteThrough)?;
    let mut out = [0u8; 32];
    out.copy_from_slice(key.as_slice());
    Ok(out)
}

/// A key file with no `KEY_FILE_MAGIC`. `Ok(None)` means the caller should mint
/// a fresh one; the file is already gone by then.
#[cfg(not(target_os = "macos"))]
fn unwrap_unmarked(stored: &[u8], _path: &Path, label: &str) -> Result<Option<[u8; 32]>, String> {
    let key_bytes = keywrap::unwrap(stored)
        .map_err(|e| format!("stored {label} key could not be unwrapped: {e}"))?;
    if key_bytes.len() != 32 {
        return Err(format!("stored {label} key has an invalid length"));
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&key_bytes);
    Ok(Some(key))
}

/// See `KEY_FILE_MAGIC`: on macOS an unmarked file was sealed by the retired
/// login-Keychain master key, so there is nothing left to unwrap it with.
#[cfg(target_os = "macos")]
fn unwrap_unmarked(_stored: &[u8], path: &Path, label: &str) -> Result<Option<[u8; 32]>, String> {
    std::fs::remove_file(path)
        .map_err(|e| format!("could not drop the retired {label} key file: {e}"))?;
    log::warn!(
        "crypto: dropped the {label} key file sealed by the retired keychain master key; anything it sealed is unreadable and will be skipped"
    );
    Ok(None)
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

/// macOS has no DPAPI. The master key is derived instead, from a random salt
/// file that never leaves this machine and the machine's own hardware UUID:
///
///     master = SHA-256(domain ‖ salt ‖ gethostuuid())
///
/// The key files stay exactly where Windows puts them, which keeps the "each
/// feature owns its own key file" invariant identical across platforms.
///
/// THIS DELIBERATELY DOES NOT USE THE LOGIN KEYCHAIN, and putting it back would
/// be a regression. A keychain item's ACL is bound to the code identity that
/// created it, so the item minted by a `tauri dev` binary, by a locally signed
/// bundle, and by a release build are three different owners of one secret.
/// Every mismatch raises "Aura Desktop wants to access key com.aura.desktop in
/// your keychain", which asks for the LOGIN KEYCHAIN password - a password most
/// users have never knowingly set. Switching from the individual Developer ID
/// to the company's changes the Team ID and does the same thing to every
/// install at once. Apple's prompt-free answer is the data protection keychain,
/// which needs an App-ID-signed binary carrying the restricted
/// `keychain-access-groups` entitlement authorised by an embedded provisioning
/// profile; Tauri does not inject one, this app is deliberately unsandboxed,
/// and the access group is still Team-ID scoped, so the company-cert switch
/// would silently orphan every item rather than prompt.
///
/// What the derivation keeps: the wrapped blob is useless copied to another
/// Mac, because the hardware UUID is part of the key. What it gives up: another
/// process running as this same user can read the salt and derive the key. That
/// is exactly the property Windows already ships (`CryptProtectData` at
/// current-user scope, no extra entropy), so this is parity with Windows, not a
/// step below it. Replacing the logic board changes the UUID and makes existing
/// data unreadable - it fails closed, loudly, the same way a moved Windows
/// profile does.
#[cfg(target_os = "macos")]
mod keywrap {
    use std::io::Write;
    use std::path::PathBuf;
    use std::sync::OnceLock;

    use sha2::{Digest, Sha256};

    /// Domain separation, so the derived master key can never collide with any
    /// other SHA-256 this app takes over the same bytes.
    const DOMAIN: &[u8] = b"aura.at-rest.master.v2";

    const SALT_FILE: &str = "master.salt";
    const SALT_LEN: usize = 32;

    /// The bundle identifier from tauri.conf.json, spelled out because the salt
    /// is resolved from free functions with no `AppHandle` to ask for
    /// `app_local_data_dir()`. Same coupling, same reason, as
    /// `meeting::runtime_lease`'s copy; keep the three in agreement.
    const BUNDLE_IDENTIFIER: &str = "com.aura.desktop";

    /// Derived once per process. Every wrap and unwrap used to re-read the
    /// store, which on the keychain meant one round trip (and one chance to
    /// prompt) per sealed blob. Only successes are cached, so a transient
    /// failure stays retryable.
    static MASTER: OnceLock<[u8; 32]> = OnceLock::new();

    fn master_key() -> Result<[u8; 32], String> {
        if let Some(key) = MASTER.get() {
            return Ok(*key);
        }
        let mut hasher = Sha256::new();
        hasher.update(DOMAIN);
        hasher.update(load_or_create_salt()?);
        hasher.update(host_uuid()?);
        let key: [u8; 32] = hasher.finalize().into();
        Ok(*MASTER.get_or_init(|| key))
    }

    /// Resolves to the same directory `app_local_data_dir()` gives at runtime
    /// (`~/Library/Application Support/<identifier>` on macOS), so the salt
    /// sits with the key files it protects.
    fn salt_path() -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME")
            .ok_or_else(|| "HOME is not set, cannot locate the master key salt".to_string())?;
        Ok(PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join(BUNDLE_IDENTIFIER)
            .join(SALT_FILE))
    }

    /// FAILS CLOSED: only a salt file that is genuinely absent may be minted.
    /// A permission error or a short read means the salt probably still exists,
    /// and minting a replacement would make every already-sealed key file
    /// permanently unreadable while new writes looked perfectly healthy.
    fn load_or_create_salt() -> Result<Vec<u8>, String> {
        let path = salt_path()?;
        loop {
            match std::fs::read(&path) {
                Ok(salt) if salt.len() == SALT_LEN => return Ok(salt),
                Ok(_) => {
                    return Err(format!(
                        "the master key salt at {} has an invalid length",
                        path.display()
                    ))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(format!(
                        "the master key salt is unreadable, refusing to mint a replacement: {error}"
                    ))
                }
            }

            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("could not create the master key salt directory: {e}"))?;
            }

            // Same CSPRNG the per-feature keys are minted from, and the same
            // 32 bytes wide, so there is no second random path to audit.
            let fresh = {
                use aes_gcm::aead::{KeyInit, OsRng};
                aes_gcm::Aes256Gcm::generate_key(OsRng)
            };
            let mut salt = [0u8; SALT_LEN];
            salt.copy_from_slice(fresh.as_slice());

            // create_new on the FINAL path, not a temp plus rename: a rename
            // would clobber a salt another process just won the race to write,
            // and the two would then derive different master keys. Losing that
            // race is not an error, it just means re-reading the winner's file.
            match create_salt_file(&path, &salt) {
                Ok(()) => return Ok(salt.to_vec()),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(format!("could not write the master key salt: {error}"));
                }
            }
        }
    }

    fn create_salt_file(path: &std::path::Path, salt: &[u8]) -> std::io::Result<()> {
        use std::os::unix::fs::OpenOptionsExt;

        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(salt)?;
        file.sync_all()?;
        drop(file);
        if let Some(parent) = path.parent() {
            let _ = crate::fsx::sync_directory(parent);
        }
        Ok(())
    }

    /// The machine's hardware UUID, the same value IOKit reports as
    /// `IOPlatformUUID`. Readable by any non-sandboxed process: no entitlement,
    /// no TCC grant, and so nothing here can ever raise a dialog.
    fn host_uuid() -> Result<[u8; 16], String> {
        let mut uuid = [0u8; 16];
        // The wait argument is required, not optional. One second is the same
        // bound LLVM uses for this call; the value is already resident on a
        // running system, so it returns immediately in practice.
        let wait = libc::timespec {
            tv_sec: 1,
            tv_nsec: 0,
        };
        let status = unsafe { libc::gethostuuid(uuid.as_mut_ptr(), &wait) };
        if status != 0 {
            return Err(format!(
                "could not read the host UUID: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(uuid)
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
