//! "Mute other apps while dictating" (Settings > System > Sound).
//!
//! Walks the default render endpoint's audio sessions via WASAPI's session API
//! (the same mechanism behind the Windows volume mixer) and mutes everyone
//! else's active session for the duration of a dictation, then unmutes exactly
//! the sessions it muted.
//!
//! Two rules shape the whole design:
//!
//! - **Only ever unmute what we muted.** A session the user had already muted
//!   themselves is skipped entirely and never recorded, so restoring can never
//!   turn someone's audio back on against their wishes.
//! - **Assume we will be killed mid-dictation.** The muted PID list is written
//!   to the store BEFORE the mute happens and cleared only after the restore
//!   succeeds, and `restore_stale_on_start` replays a leftover list at launch.
//!   Without that, a crash between mute and restore leaves the user's music
//!   silently muted with no discoverable way back.
//!
//! All COM work happens on one dedicated worker thread fed by a channel, not on
//! a Tauri command thread. That buys three things at once: COM is initialized
//! exactly once, the main thread never blocks on session enumeration (see the
//! main-thread rule in CLAUDE.md), and mute/restore are processed strictly in
//! the order they were requested - a `spawn_blocking` per call could run a
//! short dictation's restore before its own mute and strand the user in
//! silence.

use log::{error, info};
use std::sync::{mpsc, OnceLock};
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// Rust-owned state, not a user preference, so it lives in the Rust store
/// alongside autostart's opt-out rather than the dashboard's settings store.
const SETTINGS_STORE: &str = "settings.json";
const DUCKED_PIDS_KEY: &str = "audio_ducked_pids";

/// The user preference itself is written by the dashboard (generalSettings.ts).
const OVERLAY_STORE: &str = "overlay-window.json";
const GENERAL_SETTINGS_KEY: &str = "dashboard_general_settings";

enum DuckCommand {
    Mute(AppHandle),
    Restore(AppHandle),
}

fn sender() -> &'static mpsc::Sender<DuckCommand> {
    static SENDER: OnceLock<mpsc::Sender<DuckCommand>> = OnceLock::new();
    SENDER.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<DuckCommand>();
        std::thread::spawn(move || worker(rx));
        tx
    })
}

fn worker(rx: mpsc::Receiver<DuckCommand>) {
    while let Ok(command) = rx.recv() {
        match command {
            DuckCommand::Mute(app) => {
                // Read the preference here rather than at the call site so the
                // dictation hook stays a single unconditional line.
                if !enabled(&app) {
                    continue;
                }
                match platform::mute_others() {
                    Ok(pids) if pids.is_empty() => {}
                    Ok(pids) => {
                        // Written before the mute is considered done. If the
                        // process dies now, startup replays this list.
                        store_pids(&app, &pids);
                        info!("audio_ducking: muted {} session(s)", pids.len());
                    }
                    Err(e) => error!("audio_ducking: mute failed: {e}"),
                }
            }
            DuckCommand::Restore(app) => {
                let pids = load_pids(&app);
                if pids.is_empty() {
                    continue;
                }
                match platform::unmute(&pids) {
                    Ok(()) => {
                        store_pids(&app, &[]);
                        info!("audio_ducking: restored {} session(s)", pids.len());
                    }
                    // Deliberately keep the list on failure so the next launch
                    // retries it. A stale entry is harmless (its PID is gone);
                    // a dropped one means permanently muted audio.
                    Err(e) => error!("audio_ducking: restore failed, list kept: {e}"),
                }
            }
        }
    }
}

/// Dictation started. No-op unless the user enabled the preference.
pub fn mute_others(app: &AppHandle) {
    let _ = sender().send(DuckCommand::Mute(app.clone()));
}

/// Dictation ended, by any path including error. Always runs, regardless of
/// the preference: turning the setting off mid-dictation must still unmute.
pub fn restore(app: &AppHandle) {
    let _ = sender().send(DuckCommand::Restore(app.clone()));
}

/// Called once from setup(). Unmutes anything a previous run left muted when it
/// died between mute and restore.
pub fn restore_stale_on_start(app: &AppHandle) {
    if !load_pids(app).is_empty() {
        info!("audio_ducking: previous run left sessions muted, restoring");
        restore(app);
    }
}

fn enabled(app: &AppHandle) -> bool {
    let Ok(store) = app.store(OVERLAY_STORE) else {
        return false;
    };
    store
        .get(GENERAL_SETTINGS_KEY)
        .and_then(|settings| {
            settings
                .get("muteOthersWhileDictating")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false)
}

fn store_pids(app: &AppHandle, pids: &[u32]) {
    let Ok(store) = app.store(SETTINGS_STORE) else {
        error!("audio_ducking: cannot open store, restore-after-crash is unavailable");
        return;
    };
    store.set(DUCKED_PIDS_KEY, serde_json::json!(pids));
    if let Err(e) = store.save() {
        error!("audio_ducking: failed to persist muted pids: {e}");
    }
}

fn load_pids(app: &AppHandle) -> Vec<u32> {
    let Ok(store) = app.store(SETTINGS_STORE) else {
        return Vec::new();
    };
    store
        .get(DUCKED_PIDS_KEY)
        .and_then(|value| serde_json::from_value::<Vec<u32>>(value).ok())
        .unwrap_or_default()
}

#[cfg(windows)]
mod platform {
    use windows::core::Interface;
    use windows::Win32::Foundation::S_OK;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, AudioSessionStateActive, IAudioSessionControl2, IAudioSessionManager2,
        IMMDeviceEnumerator, ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// Idempotent: the worker thread is long-lived, so this runs once and every
    /// later call returns RPC_E_CHANGED_MODE or S_FALSE, both of which are fine
    /// to ignore.
    fn ensure_com() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
    }

    /// Runs `visit` for every other app's audio session on the default render
    /// endpoint. Skips our own process (muting ourselves would silence Aura's
    /// own dictation cues) and the system-sounds session (muting it kills
    /// Windows' own alert sounds app-wide, which is not what the setting says).
    fn for_each_other_session(
        mut visit: impl FnMut(u32, &IAudioSessionControl2, &ISimpleAudioVolume)
            -> windows::core::Result<()>,
    ) -> windows::core::Result<()> {
        ensure_com();
        let own_pid = std::process::id();
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
            let manager: IAudioSessionManager2 = device.Activate(CLSCTX_ALL, None)?;
            let sessions = manager.GetSessionEnumerator()?;
            for index in 0..sessions.GetCount()? {
                let control2: IAudioSessionControl2 = sessions.GetSession(index)?.cast()?;
                // Returns a bare HRESULT rather than a Result. S_FALSE ("not
                // the system sounds session") is itself a success code, so an
                // `.is_ok()` test would match both answers - compare to S_OK.
                if control2.IsSystemSoundsSession() == S_OK {
                    continue;
                }
                let pid = control2.GetProcessId()?;
                if pid == own_pid {
                    continue;
                }
                let volume: ISimpleAudioVolume = control2.cast()?;
                visit(pid, &control2, &volume)?;
            }
        }
        Ok(())
    }

    /// Mutes every other app currently rendering audio. Returns the PIDs it
    /// actually changed - a session that was already muted, or not actively
    /// playing, is skipped and never recorded, so restore can only ever undo
    /// this function's own work.
    pub fn mute_others() -> windows::core::Result<Vec<u32>> {
        let mut muted = Vec::new();
        for_each_other_session(|pid, control, volume| {
            unsafe {
                if control.GetState()? != AudioSessionStateActive || volume.GetMute()?.as_bool() {
                    return Ok(());
                }
                volume.SetMute(true, std::ptr::null())?;
            }
            muted.push(pid);
            Ok(())
        })?;
        Ok(muted)
    }

    /// Unmutes exactly the recorded PIDs. No state filter here on purpose: a
    /// session that stopped playing while muted is precisely the one that most
    /// needs unmuting. Sessions whose process has since exited no longer appear
    /// in the enumeration, so a stale PID is a no-op rather than an error.
    pub fn unmute(pids: &[u32]) -> windows::core::Result<()> {
        for_each_other_session(|pid, _control, volume| {
            if pids.contains(&pid) {
                unsafe { volume.SetMute(false, std::ptr::null())? };
            }
            Ok(())
        })
    }
}

#[cfg(not(windows))]
mod platform {
    pub fn mute_others() -> Result<Vec<u32>, String> {
        Ok(Vec::new())
    }

    pub fn unmute(_pids: &[u32]) -> Result<(), String> {
        Ok(())
    }
}
