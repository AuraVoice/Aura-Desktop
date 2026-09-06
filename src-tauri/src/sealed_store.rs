//! Sealed-row mechanics shared by the encrypted SQLite stores
//! (chat_cache.rs, interview_store.rs): AES-GCM with each value bound to its
//! row through associated data, so a sealed blob cannot be replayed into a
//! different row or account.
//!
//! AAD GRAMMARS ARE NOT SHARED. A store's row AAD is frozen by its
//! already-sealed rows (changing one byte makes every existing row
//! undecryptable), so each grammar lives next to its store, marked FROZEN.
//! New stores build theirs with `aad` below instead of inventing a format.

pub fn seal(key: &[u8; 32], plaintext: &str, aad: &str) -> Result<Vec<u8>, String> {
    crate::crypto::encrypt_with_aad(key, plaintext.as_bytes(), aad.as_bytes())
}

pub fn unseal(key: &[u8; 32], sealed: &[u8], aad: &str) -> Result<String, String> {
    let plain = crate::crypto::decrypt_with_aad(key, sealed, aad.as_bytes())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

/// `unseal` against a cipher that was built once, for callers decrypting many
/// rows in a loop.
pub fn unseal_with(cipher: &crate::crypto::SealedCipher, sealed: &[u8], aad: &str) -> Result<String, String> {
    let plain = cipher.decrypt_with_aad(sealed, aad.as_bytes())?;
    String::from_utf8(plain).map_err(|e| e.to_string())
}

/// The canonical AAD grammar for new stores: a versioned namespace and
/// NUL-separated parts, so ids containing a join character cannot make two
/// distinct rows collide (the flaw in the older colon-joined grammar).
pub fn aad(namespace_version: &str, parts: &[&str]) -> String {
    let mut out = String::from(namespace_version);
    for part in parts {
        out.push('\0');
        out.push_str(part);
    }
    out
}
