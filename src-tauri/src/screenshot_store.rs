//! Encrypted local retention for screen captures.
//!
//! Every JPEG is encrypted before it reaches disk. Files live under the
//! app-local data directory for 180 days and are pruned on startup, daily,
//! and before each new write.
//!
//! Two write paths, on purpose, because they have different contracts:
//!
//! * An EXPLICIT capture is something the user asked for, so
//!   [`save_capture`] still writes synchronously and the caller learns whether
//!   it landed.
//! * A normal VOICE-TURN capture is incidental to answering a question, so it
//!   goes through [`PersistenceQueue`]. The response path enqueues and returns
//!   immediately; encryption and the disk write happen on a dedicated worker
//!   thread afterwards. Waiting on AES-GCM plus a directory prune before the
//!   frame could even reach LiveKit was pure added latency on every spoken turn.
//!
//! Durability of the queued path is deliberately weaker: the queue is bounded
//! at [`QUEUE_CAPACITY`], a full queue DROPS the incoming frame rather than
//! blocking the voice response, and anything still queued when the process
//! exits is lost (`drain_for_shutdown` gives it a brief chance, not a
//! guarantee). Retention is unchanged at 180 days either way.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use log::{info, warn};
use tauri::{AppHandle, Manager};

use crate::util::{lock, now_ms_u64};

const CAPTURES_DIR: &str = "screen-captures";
const RETENTION_DAYS: u64 = 180;
const RETENTION_MS: u64 = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MAINTENANCE_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
static FILE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Deep enough to absorb a burst of turns behind one slow write, shallow
/// enough that a pathologically slow disk cannot hold megabytes of frames.
const QUEUE_CAPACITY: usize = 8;

/// The synchronous path prunes before every write. The worker cannot: pruning
/// scans the whole directory, and a turn-rate write loop would rescan it
/// constantly. Once a minute keeps the 180-day policy honest for the cost of
/// one scan, and startup/daily maintenance still covers an idle app.
const WORKER_PRUNE_INTERVAL: Duration = Duration::from_secs(60);

/// How long shutdown waits for in-flight persistence before giving up.
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_millis(1500);

pub fn save_capture(app: &AppHandle, kind: &str, jpeg: &[u8]) -> Result<PathBuf, String> {
    let base_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join(CAPTURES_DIR);
    let key = crate::meeting::crypto::load_or_create_key(app)?;
    save_capture_in(&base_dir, &key, kind, jpeg, now_ms_u64())
}

struct PersistJob {
    kind: &'static str,
    jpeg: Vec<u8>,
    captured_at_ms: u64,
}

#[derive(Default)]
struct QueueState {
    jobs: VecDeque<PersistJob>,
    busy: bool,
    /// Set once at shutdown: finish what is queued, then stop.
    stopping: bool,
    dropped_total: u64,
}

#[derive(Default)]
struct QueueInner {
    state: Mutex<QueueState>,
    signal: Condvar,
}

/// Bounded, single-owner background persistence for voice-turn captures.
///
/// Managed as Tauri state. One worker thread, never one task per screenshot:
/// an unbounded spawn-per-capture would let a stalled disk accumulate frames
/// without limit, which is exactly the failure this queue exists to bound.
pub struct PersistenceQueue {
    inner: Arc<QueueInner>,
}

impl PersistenceQueue {
    /// Starts the worker. Called once from `lib.rs` setup.
    pub fn start(app: &AppHandle) -> Self {
        let inner = Arc::new(QueueInner::default());
        let worker_inner = Arc::clone(&inner);
        let worker_app = app.clone();
        if let Err(e) = std::thread::Builder::new()
            .name("aura-screenshot-persist".into())
            .spawn(move || worker_loop(worker_app, worker_inner))
        {
            warn!("screenshot store: persistence worker failed to start: {e}");
        }
        Self { inner }
    }

    /// Hands a frame off for encryption and writing. Never blocks, never fails
    /// the caller: a full queue drops this frame and says so in the log.
    pub fn enqueue(&self, kind: &'static str, jpeg: Vec<u8>) {
        let mut state = lock(&self.inner.state);
        if state.stopping {
            return;
        }
        if state.jobs.len() >= QUEUE_CAPACITY {
            state.dropped_total += 1;
            let dropped_total = state.dropped_total;
            drop(state);
            // Sanitized: a count and a depth, never bytes, paths or content.
            warn!(
                "[Capture] persistence_dropped {{queue_len:{QUEUE_CAPACITY}, dropped_total:{dropped_total}}}"
            );
            return;
        }
        state.jobs.push_back(PersistJob {
            kind,
            jpeg,
            captured_at_ms: now_ms_u64(),
        });
        drop(state);
        self.inner.signal.notify_one();
    }

    /// Gives queued writes a brief chance to land before the process goes away.
    /// Best effort by design - see the module docs.
    pub fn drain_for_shutdown(&self) {
        {
            let mut state = lock(&self.inner.state);
            state.stopping = true;
        }
        self.inner.signal.notify_all();
        let deadline = Instant::now() + SHUTDOWN_DRAIN_TIMEOUT;
        loop {
            {
                let state = lock(&self.inner.state);
                if state.jobs.is_empty() && !state.busy {
                    return;
                }
                if Instant::now() >= deadline {
                    let remaining = state.jobs.len();
                    warn!("[Capture] persistence_shutdown_incomplete {{queued:{remaining}}}");
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

fn worker_loop(app: AppHandle, inner: Arc<QueueInner>) {
    let mut key: Option<[u8; 32]> = None;
    let mut base_dir: Option<PathBuf> = None;
    let mut last_prune: Option<Instant> = None;

    loop {
        let job = {
            let mut state = lock(&inner.state);
            loop {
                if let Some(job) = state.jobs.pop_front() {
                    state.busy = true;
                    break Some(job);
                }
                if state.stopping {
                    break None;
                }
                state = inner
                    .signal
                    .wait(state)
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
            }
        };
        let Some(job) = job else {
            return;
        };

        let started = Instant::now();
        // Resolved lazily and cached: the DPAPI unwrap is the expensive part
        // and it does not change for the life of the process.
        if base_dir.is_none() {
            match app.path().app_local_data_dir() {
                Ok(dir) => base_dir = Some(dir.join(CAPTURES_DIR)),
                Err(e) => warn!("[Capture] persistence_failed {{reason:data_dir, error:{e}}}"),
            }
        }
        if key.is_none() {
            match crate::meeting::crypto::load_or_create_key(&app) {
                Ok(loaded) => key = Some(loaded),
                Err(e) => warn!("[Capture] persistence_failed {{reason:key, error:{e}}}"),
            }
        }
        if let (Some(dir), Some(key)) = (base_dir.as_deref(), key.as_ref()) {
            let due = last_prune.is_none_or(|at| at.elapsed() >= WORKER_PRUNE_INTERVAL);
            if due {
                last_prune = Some(Instant::now());
                match prune_expired_in(dir, job.captured_at_ms) {
                    Ok(removed) if removed > 0 => {
                        info!("screenshot store: pruned {removed} expired capture(s)")
                    }
                    Ok(_) => {}
                    Err(e) => warn!("[Capture] persistence_prune_failed {{error:{e}}}"),
                }
            }
            match write_capture_in(dir, key, job.kind, &job.jpeg, job.captured_at_ms) {
                Ok(_) => info!(
                    "[Capture] persistence_write_ms:{}",
                    started.elapsed().as_millis()
                ),
                // A failed write is never allowed to end capture or retry in a
                // loop: the frame is already answered against, so it is dropped.
                Err(e) => warn!("[Capture] persistence_failed {{reason:write, error:{e}}}"),
            }
        }

        let mut state = lock(&inner.state);
        state.busy = false;
    }
}

pub fn startup_maintenance(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let maintenance_app = app.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                let base_dir = maintenance_app
                    .path()
                    .app_local_data_dir()
                    .map_err(|e| e.to_string())?
                    .join(CAPTURES_DIR);
                prune_expired_in(&base_dir, now_ms_u64())
            })
            .await;
            match result {
                Ok(Ok(removed)) if removed > 0 => {
                    info!("screenshot store: pruned {removed} expired capture(s)")
                }
                Ok(Ok(_)) => {}
                Ok(Err(e)) => warn!("screenshot store: maintenance failed: {e}"),
                Err(e) => warn!("screenshot store: maintenance worker failed: {e}"),
            }
            tokio::time::sleep(MAINTENANCE_INTERVAL).await;
        }
    });
}

fn save_capture_in(
    base_dir: &Path,
    key: &[u8; 32],
    kind: &str,
    jpeg: &[u8],
    captured_at_ms: u64,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
    prune_expired_in(base_dir, captured_at_ms)?;
    write_capture_in(base_dir, key, kind, jpeg, captured_at_ms)
}

/// The write half on its own, so the background worker can rate-limit pruning
/// independently (see `WORKER_PRUNE_INTERVAL`) without changing what a
/// synchronous explicit capture does.
fn write_capture_in(
    base_dir: &Path,
    key: &[u8; 32],
    kind: &str,
    jpeg: &[u8],
    captured_at_ms: u64,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(base_dir).map_err(|e| e.to_string())?;
    let encrypted = crate::meeting::crypto::encrypt(key, jpeg)?;
    let sequence = FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let filename = format!(
        "{captured_at_ms}-{}-{sequence}-{kind}.jpg.enc",
        std::process::id()
    );
    let final_path = base_dir.join(filename);
    crate::fsx::write_atomic(&final_path, &encrypted, crate::fsx::Durability::BestEffort)?;
    Ok(final_path)
}

fn prune_expired_in(base_dir: &Path, now_ms: u64) -> Result<usize, String> {
    if !base_dir.exists() {
        return Ok(0);
    }
    let entries = std::fs::read_dir(base_dir).map_err(|e| e.to_string())?;
    let cutoff = now_ms.saturating_sub(RETENTION_MS);
    let mut removed = 0;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|value| value.to_str()) != Some("enc") {
            continue;
        }
        let Some(captured_at_ms) = path
            .file_name()
            .and_then(|value| value.to_str())
            .and_then(|value| value.split('-').next())
            .and_then(|value| value.parse::<u64>().ok())
        else {
            continue;
        };
        if captured_at_ms < cutoff {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
            removed += 1;
        }
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "aura-screen-store-{}-{}-{name}",
            std::process::id(),
            now_ms_u64()
        ))
    }

    #[test]
    fn saves_encrypted_jpeg_and_prunes_only_expired_captures() {
        let base = test_dir("retention");
        let key = [7u8; 32];
        let old_ms = 1_000;
        let now = old_ms + RETENTION_MS + 1;
        let old = save_capture_in(&base, &key, "turn", b"old-jpeg", old_ms).unwrap();
        let current = save_capture_in(&base, &key, "turn", b"current-jpeg", now).unwrap();

        assert!(!old.exists());
        assert!(current.exists());
        let on_disk = std::fs::read(&current).unwrap();
        assert!(!on_disk
            .windows(b"current-jpeg".len())
            .any(|w| w == b"current-jpeg"));
        assert_eq!(
            crate::meeting::crypto::decrypt(&key, &on_disk).unwrap(),
            b"current-jpeg"
        );

        std::fs::remove_dir_all(base).unwrap();
    }
}
