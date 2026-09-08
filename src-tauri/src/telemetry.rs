//! Crash reporting glue and the two health signals the beta needs.
//!
//! Owns four things, none of which may ever block or fail the app:
//!
//! - The native crash reporter (`sentry-rust-minidump`): a separate process,
//!   this same binary relaunched with `--crash-reporter-server`, that writes
//!   and uploads a minidump when this process dies hard. Rust panics were
//!   already reported by `sentry_setup.rs`; this covers SIGSEGV, stack
//!   overflow and Objective-C exceptions from the AppKit and CoreAudio FFI.
//! - The dictation hold gate. A minidump taken mid-hold can carry transcript
//!   bytes from the dictation thread's stack, so a hold writes a marker file
//!   the reporter checks in `sentry_setup::before_send` and drops the dump
//!   if it is present, or cannot be read. Fail closed, same posture as the
//!   `mentions_dictation` filter next to it.
//! - Launch bookkeeping for the crash-loop beacon: a `running.marker` that is
//!   created at startup and removed on a clean exit, so the next launch knows
//!   the previous one died, and a counter file so a loop is visible as one.
//!   The webview posts the result to `POST /diagnostics/desktop`.
//! - `diagnostics_snapshot`, the subsystem health the webview sends as the
//!   `desktop_heartbeat` analytics event every ten minutes.
//!
//! Nothing here logs more than counts, paths and outcomes.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

static MINIDUMP: OnceLock<Mutex<sentry_rust_minidump::Handle>> = OnceLock::new();
static REPORTER_ALIVE: AtomicBool = AtomicBool::new(false);
static STARTED: OnceLock<Instant> = OnceLock::new();

/// The webview's store file and its per-install id key; both mirror
/// `overlayStorePath` and `desktopAnonIdKey` in src/lib/copy.ts.
const OVERLAY_STORE: &str = "overlay-window.json";
const ANON_ID_KEY: &str = "desktop_anon_id";

pub fn mark_started() {
    let _ = STARTED.set(Instant::now());
}

// ── Markers shared with the crash reporter process ──────────────────────────
// Computed without Tauri so the reporter child (which never builds an app)
// resolves exactly the same paths as the main process.

fn marker_dir() -> PathBuf {
    std::env::temp_dir().join("com.aura.desktop")
}

pub fn hold_marker_path() -> PathBuf {
    marker_dir().join("dictation-hold.marker")
}

pub fn crash_marker_path() -> PathBuf {
    marker_dir().join("last-crash.marker")
}

// ── Crash reporter ──────────────────────────────────────────────────────────

/// Starts the crash reporter child. Everything before this call runs in both
/// processes; in the child, `init` runs the reporter loop and exits, so
/// nothing after it ever runs there. A reporter that fails to start is a
/// warning, never a reason to abort launch.
pub fn init_minidump(client: &sentry::Client) {
    if cfg!(debug_assertions) {
        info!("crash reporter: skipped in a debug build");
        return;
    }
    match sentry_rust_minidump::init(client) {
        Ok(handle) => {
            REPORTER_ALIVE.store(true, Ordering::SeqCst);
            if MINIDUMP.set(Mutex::new(handle)).is_err() {
                warn!("crash reporter: started twice, keeping the first");
            }
        }
        Err(e) => warn!("crash reporter: failed to start: {e}"),
    }
}

fn forward_tag(key: &str, value: Option<&str>) {
    if let Some(handle) = MINIDUMP.get() {
        if let Ok(handle) = handle.lock() {
            handle.set_tag(key.to_string(), value.map(str::to_string));
        }
    }
}

/// Sets a tag on this process's Sentry scope AND on the reporter's, so a
/// native crash report carries the same context as a panic report.
pub fn set_scope_tag(key: &str, value: Option<&str>) {
    sentry::configure_scope(|scope| match value {
        Some(value) => scope.set_tag(key, value),
        None => scope.remove_tag(key),
    });
    forward_tag(key, value);
}

fn read_anon_id(app: &AppHandle) -> Option<String> {
    let store = app.store(OVERLAY_STORE).ok()?;
    let value = store.get(ANON_ID_KEY)?;
    value.as_str().map(str::to_string)
}

/// Called once from `.setup()`. Every read is optional: a missing store or
/// id just means one tag fewer on the report.
pub fn attach_process_tags(app: &AppHandle) {
    set_scope_tag("app_version", Some(env!("CARGO_PKG_VERSION")));
    set_scope_tag("os", Some(std::env::consts::OS));
    if let Ok(install_id) = crate::meeting::queue::installation_id(app) {
        set_scope_tag("install_id", Some(&install_id));
    }
    if let Some(anon_id) = read_anon_id(app) {
        set_scope_tag("anon_id", Some(&anon_id));
        let user = sentry::User {
            id: Some(anon_id),
            ..Default::default()
        };
        sentry::configure_scope(|scope| scope.set_user(Some(user.clone())));
        if let Some(handle) = MINIDUMP.get() {
            if let Ok(handle) = handle.lock() {
                handle.set_user(Some(user));
            }
        }
    }
}

// ── Dictation hold gate ─────────────────────────────────────────────────────

pub fn dictation_hold_started() {
    let path = hold_marker_path();
    let created = std::fs::create_dir_all(marker_dir())
        .and_then(|_| std::fs::write(&path, b""));
    if let Err(e) = created {
        // The gate fails closed without the marker: the next crash report is
        // dropped, which is the safe direction, but worth knowing about.
        error!("telemetry: could not write the dictation hold marker: {e}");
    }
    set_scope_tag("dictation_hold", Some("1"));
}

pub fn dictation_hold_ended() {
    clear_stale_hold_marker();
    set_scope_tag("dictation_hold", None);
}

pub fn clear_stale_hold_marker() {
    match std::fs::remove_file(hold_marker_path()) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => warn!("telemetry: could not remove the dictation hold marker: {e}"),
    }
}

// ── Launch bookkeeping ──────────────────────────────────────────────────────

pub mod startup_marker {
    use super::*;
    use crate::fsx::{write_atomic, Durability};

    const STATE_FILE: &str = "launch_state.json";
    const RUNNING_MARKER: &str = "running.marker";

    #[derive(Default, Serialize, Deserialize)]
    struct LaunchState {
        #[serde(default)]
        launch_count: u32,
        #[serde(default)]
        consecutive_failed_launches: u32,
        /// Unix seconds.
        #[serde(default)]
        last_started_at: u64,
        #[serde(default)]
        last_app_version: String,
    }

    #[derive(Clone, Serialize)]
    pub struct LastExit {
        pub kind: &'static str,
        pub at: Option<String>,
    }

    /// The body of `POST /diagnostics/desktop`; field names are that route's
    /// allowlist. Content-free by construction.
    #[derive(Clone, Serialize)]
    pub struct StartupPayload {
        pub install_id: Option<String>,
        pub app_version: String,
        pub os_platform: &'static str,
        pub os_version: String,
        pub os_arch: &'static str,
        pub launch_count: u32,
        pub consecutive_failed_launches: u32,
        pub last_exit: LastExit,
        pub crash_reporter_alive: bool,
        pub previous_app_version: Option<String>,
    }

    #[derive(Clone, Serialize)]
    pub struct StartupDiagnostics {
        pub should_report: bool,
        pub payload: StartupPayload,
    }

    fn telemetry_dir(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("telemetry");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir)
    }

    fn now_secs() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    }

    fn read_state(dir: &Path) -> LaunchState {
        std::fs::read(dir.join(STATE_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn write_state(dir: &Path, state: &LaunchState) {
        match serde_json::to_vec(state) {
            Ok(bytes) => {
                if let Err(e) = write_atomic(&dir.join(STATE_FILE), &bytes, Durability::BestEffort) {
                    warn!("telemetry: could not write launch state: {e}");
                }
            }
            Err(e) => warn!("telemetry: could not encode launch state: {e}"),
        }
    }

    /// The crash marker is written by `sentry_setup::before_send` in the
    /// reporter process; its contents are the unix time of the crash.
    fn take_crash_time() -> Option<u64> {
        let path = crash_marker_path();
        let stamp = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| s.trim().parse::<u64>().ok());
        if let Err(e) = std::fs::remove_file(&path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                warn!("telemetry: could not remove the crash marker: {e}");
            }
        }
        stamp
    }

    fn os_platform() -> &'static str {
        if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            std::env::consts::OS
        }
    }

    /// Runs once at setup. Decides how the previous run ended, updates the
    /// counters, drops the running marker for this run and parks the answer
    /// in managed state for `startup_diagnostics_snapshot`.
    pub fn begin(app: &AppHandle) {
        let dir = match telemetry_dir(app) {
            Ok(dir) => dir,
            Err(e) => {
                warn!("telemetry: launch bookkeeping unavailable: {e}");
                return;
            }
        };
        let mut state = read_state(&dir);
        let marker = dir.join(RUNNING_MARKER);
        let previous_ran = marker.exists();
        let crash_at = take_crash_time();
        let last_exit = if !previous_ran {
            LastExit { kind: "clean", at: None }
        } else if crash_at.is_some_and(|at| at >= state.last_started_at) {
            LastExit {
                kind: "crash",
                at: crash_at.map(|at| at.to_string()),
            }
        } else {
            LastExit { kind: "unknown", at: None }
        };
        let previous_version = (!state.last_app_version.is_empty()).then(|| state.last_app_version.clone());
        let app_version = env!("CARGO_PKG_VERSION").to_string();

        state.launch_count = state.launch_count.saturating_add(1);
        state.consecutive_failed_launches = if previous_ran {
            state.consecutive_failed_launches.saturating_add(1)
        } else {
            0
        };
        state.last_started_at = now_secs();
        state.last_app_version = app_version.clone();
        write_state(&dir, &state);
        if let Err(e) = std::fs::write(&marker, b"") {
            warn!("telemetry: could not write the running marker: {e}");
        }
        info!(
            "telemetry: launch {} previous_exit={} consecutive_failed={}",
            state.launch_count, last_exit.kind, state.consecutive_failed_launches
        );

        let payload = StartupPayload {
            install_id: read_anon_id(app),
            app_version,
            os_platform: os_platform(),
            os_version: tauri_plugin_os::version().to_string(),
            os_arch: std::env::consts::ARCH,
            launch_count: state.launch_count,
            consecutive_failed_launches: state.consecutive_failed_launches,
            last_exit: last_exit.clone(),
            crash_reporter_alive: REPORTER_ALIVE.load(Ordering::SeqCst),
            previous_app_version: previous_version,
        };
        app.manage(StartupDiagnostics {
            should_report: last_exit.kind != "clean",
            payload,
        });
    }

    /// A deliberate exit or restart: the next launch must not count it.
    pub fn clean_exit(app: &AppHandle) {
        let Ok(dir) = telemetry_dir(app) else { return };
        match std::fs::remove_file(dir.join(RUNNING_MARKER)) {
            Ok(()) | Err(_) => {}
        }
        let mut state = read_state(&dir);
        if state.consecutive_failed_launches != 0 {
            state.consecutive_failed_launches = 0;
            write_state(&dir, &state);
        }
    }

    /// Undo `clean_exit` when the exit it anticipated (an update install)
    /// did not happen after all.
    pub fn resume_running(app: &AppHandle) {
        let Ok(dir) = telemetry_dir(app) else { return };
        if let Err(e) = std::fs::write(dir.join(RUNNING_MARKER), b"") {
            warn!("telemetry: could not restore the running marker: {e}");
        }
    }

    #[tauri::command]
    pub async fn startup_diagnostics_snapshot(app: AppHandle) -> Result<StartupDiagnostics, String> {
        app.try_state::<StartupDiagnostics>()
            .map(|state| state.inner().clone())
            .ok_or_else(|| "launch bookkeeping unavailable".to_string())
    }
}

// ── Heartbeat ───────────────────────────────────────────────────────────────

/// Mirrored by `DiagnosticsSnapshot` in src/lib/telemetryInit.ts.
#[derive(Serialize)]
pub struct DiagnosticsSnapshot {
    pub dictation_worker_lost: bool,
    pub dictation_available: bool,
    pub dictation_blocker: Option<&'static str>,
    pub voice_toggle_available: bool,
    pub meeting_state: &'static str,
    pub updater_pending_version: Option<String>,
    pub log_file_bytes: u64,
    pub uptime_s: u64,
    pub crash_reporter_alive: bool,
}

/// Every read degrades to a default rather than failing: a heartbeat with a
/// missing field is still a heartbeat, and its absence is the signal that
/// matters.
#[tauri::command]
pub async fn diagnostics_snapshot(app: AppHandle) -> Result<DiagnosticsSnapshot, String> {
    let (dictation_available, dictation_blocker) = app
        .try_state::<crate::dictation::DictationHandle>()
        .map(|handle| {
            let status = crate::dictation::status_with_listener_health(&app, &handle);
            (status.available, status.blocker)
        })
        .unwrap_or((false, None));
    let voice_toggle_available = app
        .try_state::<crate::voice_toggle_key::VoiceToggleKeyHandle>()
        .map(|handle| handle.status().available)
        .unwrap_or(false);
    let meeting_state = if crate::meeting::is_capture_active(&app) {
        "capturing"
    } else {
        "idle"
    };
    let log_file_bytes = crate::logging::log_file_path(&app)
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .unwrap_or(0);
    Ok(DiagnosticsSnapshot {
        dictation_worker_lost: crate::dictation::worker_lost(),
        dictation_available,
        dictation_blocker,
        voice_toggle_available,
        meeting_state,
        updater_pending_version: crate::updater::pending_update_version(app.clone()),
        log_file_bytes,
        uptime_s: STARTED.get().map(|t| t.elapsed().as_secs()).unwrap_or(0),
        crash_reporter_alive: REPORTER_ALIVE.load(Ordering::SeqCst),
    })
}
