//! Cross-process ownership for meeting side effects.
//!
//! Aura intentionally allows an installed release and `tauri dev` process to
//! coexist. Only one of them may run meeting detection, capture, upload, or
//! maintenance. The named mutex is held for this process's entire lifetime.

#[derive(Debug)]
pub struct MeetingRuntimeLease {
    owns_runtime: bool,
    runtime_instance_id: String,
    #[cfg(windows)]
    handle: Option<windows::Win32::Foundation::HANDLE>,
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
            return match result {
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
            };
        }

        #[cfg(not(windows))]
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
