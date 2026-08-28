//! Small cross-module utilities. The canonical wall clock lives here so no
//! feature module has to define (or borrow another feature's) epoch math, and
//! the poison-recovering mutex lock has one shared spelling.

use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

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
