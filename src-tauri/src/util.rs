//! Small cross-module utilities. The canonical wall clock lives here so no
//! feature module has to define (or borrow another feature's) epoch math, and
//! the poison-recovering mutex lock has one shared spelling.
//!
//! Hex encoding is here for the same reason. It had grown three spellings of
//! "sha256 as lowercase hex" and three of "n random bytes as hex", and the
//! random ones disagreed about what to do when the system RNG fails: one
//! panicked, two returned an error. Both now have exactly one answer.

use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

/// Milliseconds since the Unix epoch, floored at 0 when the clock reads
/// before it.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// The same clock for call sites that store unsigned timestamps.
pub fn now_ms_u64() -> u64 {
    now_ms() as u64
}

/// A poisoned mutex must not take the app down; recover the guard.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Lowercase hex of a SHA-256 digest, the form every wire contract here uses
/// (`X-Audio-Sha256`, the meeting segment digests, the trace fingerprints).
pub fn sha256_hex(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

/// `bytes` random bytes as lowercase hex.
///
/// Returns an error rather than panicking. A failing system RNG is a real
/// condition on a locked-down machine, and the caller is always in a position
/// to fail the one operation instead of taking the process down with it.
pub fn random_hex(bytes: usize) -> Result<String, String> {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value).map_err(|e| format!("system RNG failed: {e}"))?;
    Ok(value.iter().map(|byte| format!("{byte:02x}")).collect())
}
