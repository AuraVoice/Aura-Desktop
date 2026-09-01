//! Cross-process ownership for meeting side effects.
//!
//! Aura intentionally allows an installed release and `tauri dev` process to
//! coexist. Only one of them may run meeting detection, capture, upload, or
//! maintenance. The lease is held for this process's entire lifetime.
//!
//! Windows uses a named mutex; macOS uses a non-blocking `flock` on a lock
//! file, which gives the same three properties: exactly one holder, automatic
//! release when the process dies however it dies, and a scope that is per-user
//! rather than machine-wide. Losing the race is not an error - the loser simply
//! reports `owns_runtime: false` and keeps out of the way.

#[derive(Debug)]
pub struct MeetingRuntimeLease {
    owns_runtime: bool,
    runtime_instance_id: String,
    #[cfg(windows)]
    handle: Option<windows::Win32::Foundation::HANDLE>,
    /// Held open for the process's lifetime: closing the descriptor is what
    /// releases the advisory lock, so this must outlive every meeting
    /// side effect rather than being dropped after `acquire`.
    #[cfg(target_os = "macos")]
    lock_file: Option<std::fs::File>,
}

impl MeetingRuntimeLease {
    pub fn acquire() -> Self {
        let runtime_instance_id = super::evidence_store::random_hex(16)
            .map(|value| format!("runtime_{value}"))
            .unwrap_or_else(|_| {
                format!("runtime_{}_{}", std::process::id(), super::now_ms().max(0))
            });
        #[cfg(windows)]
        {
            use windows::core::w;
            use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
            use windows::Win32::System::Threading::CreateMutexW;

            // Local\ scopes the mutex to the interactive Windows session. That
            // is the correct boundary for two Aura tray processes competing
            // for the same audio devices and local capture directory.
            let result = unsafe {
                CreateMutexW(None, true, w!("Local\\com.aura.desktop.meeting-runtime-v2"))
            };
            match result {
                Ok(handle) => {
                    let owns_runtime = unsafe { GetLastError() } != ERROR_ALREADY_EXISTS;
                    Self {
                        owns_runtime,
                        runtime_instance_id,
                        handle: Some(handle),
                    }
                }
                Err(error) => {
                    log::error!("meeting.runtime: failed to acquire runtime lease: {error}");
                    Self {
                        owns_runtime: false,
                        runtime_instance_id,
                        handle: None,
                    }
                }
            }
        }

        #[cfg(target_os = "macos")]
        {
            match acquire_lock_file() {
                Some((file, owns_runtime)) => Self {
                    owns_runtime,
                    runtime_instance_id,
                    lock_file: Some(file),
                },
                // The lock file itself could not be opened (no home directory,
                // a read-only volume). Refusing the runtime is the safe
                // direction: two processes both capturing into one SQLite
                // store is worse than neither doing it.
                None => Self {
                    owns_runtime: false,
                    runtime_instance_id,
                    lock_file: None,
                },
            }
        }

        #[cfg(not(any(windows, target_os = "macos")))]
        {
            Self {
                owns_runtime: true,
                runtime_instance_id,
            }
        }
    }

    pub fn owns_runtime(&self) -> bool {
        self.owns_runtime
    }

    pub fn runtime_instance_id(&self) -> &str {
        &self.runtime_instance_id
    }
}

#[cfg(windows)]
impl Drop for MeetingRuntimeLease {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::ReleaseMutex;

        if let Some(handle) = self.handle.take() {
            if self.owns_runtime {
                let _ = unsafe { ReleaseMutex(handle) };
            }
            let _ = unsafe { CloseHandle(handle) };
        }
    }
}

// HANDLE is an opaque kernel object handle. This type never dereferences it,
// and ownership is released only from Drop.
#[cfg(windows)]
unsafe impl Send for MeetingRuntimeLease {}
#[cfg(windows)]
unsafe impl Sync for MeetingRuntimeLease {}

/// Opens the lease file and tries to take an exclusive advisory lock on it.
/// `Some((file, true))` means this process owns the runtime; `Some((file,
/// false))` means another Aura process already does.
///
/// The lock lives beside the capture store rather than in a temp directory so
/// it shares that directory's per-user scope, which is the macOS equivalent of
/// `Local\` scoping the Windows mutex to the interactive session.
#[cfg(target_os = "macos")]
fn acquire_lock_file() -> Option<(std::fs::File, bool)> {
    use std::os::unix::io::AsRawFd;

    let path = lock_path()?;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(&path)
        .ok()?;
    // LOCK_NB so a second process reports the conflict instead of hanging on
    // startup behind the first one.
    let taken = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    Some((file, taken))
}

/// The bundle identifier from tauri.conf.json, spelled out because the lease is
/// acquired in the builder chain before any `AppHandle` exists to ask for
/// `app_local_data_dir()`. Same coupling, same reason, as `crypto.rs`'s
/// keychain SERVICE constant; keep the three in agreement.
#[cfg(target_os = "macos")]
const BUNDLE_IDENTIFIER: &str = "com.aura.desktop";

/// Resolves to the same directory `queue::base_dir` uses at runtime
/// (`app_local_data_dir()` is `~/Library/Application Support/<identifier>` on
/// macOS), so the lock sits with the store it protects.
#[cfg(target_os = "macos")]
fn lock_path() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(
        std::path::PathBuf::from(home)
            .join("Library/Application Support")
            .join(BUNDLE_IDENTIFIER)
            .join(super::evidence_store::CAPTURES_DIR)
            .join("runtime.lock"),
    )
}
