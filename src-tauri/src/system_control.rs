//! Native executor for voice-driven desktop control.
//!
//! The Buddy agent sends a single `desktop.run` LiveKit data message; the
//! webview validates it (agentData.ts + desktopCapabilities.ts) and forwards
//! the verb here through the one `run_desktop_capability` command. This module
//! is the real trust boundary: every verb re-validates its arguments against a
//! Rust-owned allowlist before anything reaches an OS resource, because the
//! webview is not a security boundary (see security.rs). The agent never
//! supplies a raw command line, path, or window handle - only a verb id and
//! structured args - so there is no arbitrary-execution surface to abuse.
//!
//! Authorization (a signed-in session with a live voice call) is checked once
//! up front via `security::authorize(Operation::DesktopControl)`. Verbs whose
//! work is quick and non-blocking (open_url, media_control) run inline; verbs
//! that make unbounded cross-process OS calls (focus_window's EnumWindows +
//! SetForegroundWindow) move to `spawn_blocking` so the window's message pump
//! never stalls (the main-thread-blocking rule in CLAUDE.md).

use log::{info, warn};
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::security::{self, Operation};

#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowThreadProcessId, IsWindowVisible,
};

/// The one desktop-control command. `id` is the verb (see
/// desktopCapabilities.ts); `args` is its already-shape-checked payload, still
/// re-validated per verb below.
#[tauri::command]
pub async fn run_desktop_capability(app: AppHandle, id: String, args: Value) -> Result<(), String> {
    // Whole-surface gate: signed in + live voice. Verb-level allowlisting is
    // separate and happens inside each handler. The ticket carries the auth
    // epoch so launch_app can re-check it right before it spawns a process.
    let ticket = security::authorize(&app, Operation::DesktopControl)?;

    match id.as_str() {
        "open_url" => open_url(&app, &args),
        "media_control" => media_control(&args),
        "focus_window" => focus_window(&args).await,
        "launch_app" => launch_app(&app, &args, &ticket).await,
        other => {
            warn!("system_control: unknown capability id={other}");
            Err(format!("unknown capability: {other}"))
        }
    }
}

/// open_url: open a web link in the user's default browser. Rust owns the
/// scheme allowlist - only http/https ever reach the OS shell, so a file:,
/// javascript:, or UNC target the webview somehow let through still dies here.
fn open_url(app: &AppHandle, args: &Value) -> Result<(), String> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if url.is_empty() {
        return Err("open_url: missing url".to_string());
    }
    let lowered = url.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        warn!("system_control: open_url rejected non-http scheme");
        return Err("open_url: only http/https URLs are allowed".to_string());
    }
    info!("system_control: open_url (host-only elided)");
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("open_url failed: {e}"))
}

// ── media_control ────────────────────────────────────────────────────────────

/// media_control: synthesize a single media/volume key via SendInput, the same
/// mechanism win_focus uses for its foreground Alt-tap. The action set is a
/// closed allowlist; anything else is rejected before any key is injected.
#[cfg(target_os = "windows")]
fn media_control(args: &Value) -> Result<(), String> {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY,
        VK_MEDIA_NEXT_TRACK, VK_MEDIA_PLAY_PAUSE, VK_MEDIA_PREV_TRACK, VK_MEDIA_STOP,
        VK_VOLUME_DOWN, VK_VOLUME_MUTE, VK_VOLUME_UP,
    };

    let action = args.get("action").and_then(Value::as_str).unwrap_or_default();
    let vk: VIRTUAL_KEY = match action {
        "play_pause" => VK_MEDIA_PLAY_PAUSE,
        "next" => VK_MEDIA_NEXT_TRACK,
        "previous" => VK_MEDIA_PREV_TRACK,
        "stop" => VK_MEDIA_STOP,
        "volume_up" => VK_VOLUME_UP,
        "volume_down" => VK_VOLUME_DOWN,
        "mute" => VK_VOLUME_MUTE,
        other => {
            warn!("system_control: media_control unknown action={other}");
            return Err(format!("media_control: unknown action: {other}"));
        }
    };
    info!("system_control: media_control action={action}");

    let mut down = INPUT::default();
    down.r#type = INPUT_KEYBOARD;
    down.Anonymous.ki = KEYBDINPUT {
        wVk: vk,
        wScan: 0,
        dwFlags: Default::default(),
        time: 0,
        dwExtraInfo: 0,
    };
    let mut up = INPUT::default();
    up.r#type = INPUT_KEYBOARD;
    up.Anonymous.ki = KEYBDINPUT {
        wVk: vk,
        wScan: 0,
        dwFlags: KEYEVENTF_KEYUP,
        time: 0,
        dwExtraInfo: 0,
    };
    let sent = unsafe { SendInput(&[down, up], core::mem::size_of::<INPUT>() as i32) };
    if sent == 0 {
        return Err("media_control: SendInput injected no events".to_string());
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn media_control(_args: &Value) -> Result<(), String> {
    Err("media_control is only supported on Windows".to_string())
}

// ── focus_window ─────────────────────────────────────────────────────────────

/// Maps an app key from the agent to the set of acceptable executable stems.
/// Rust owns this allowlist; the agent can only ever name a key, never a path.
#[cfg(target_os = "windows")]
fn app_exe_stems(app: &str) -> Option<&'static [&'static str]> {
    Some(match app {
        "chrome" => &["chrome"],
        "edge" => &["msedge"],
        "firefox" => &["firefox"],
        "spotify" => &["spotify"],
        "slack" => &["slack"],
        "discord" => &["discord"],
        "notion" => &["notion"],
        "vscode" | "code" => &["code"],
        "explorer" | "files" => &["explorer"],
        _ => return None,
    })
}

#[cfg(target_os = "windows")]
enum FocusOutcome {
    Focused,
    NotRunning,
    Denied,
}

/// focus_window: bring an already-running app to the foreground. Resolves the
/// app key to an allowlisted set of exe stems, then finds and raises the first
/// matching visible top-level window.
#[cfg(target_os = "windows")]
async fn focus_window(args: &Value) -> Result<(), String> {
    let app_key = args
        .get("app")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let Some(stems) = app_exe_stems(&app_key) else {
        warn!("system_control: focus_window unknown app key");
        return Err(format!("focus_window: unknown app: {app_key}"));
    };
    info!("system_control: focus_window app={app_key}");

    // EnumWindows and SetForegroundWindow are unbounded cross-process calls -
    // keep them off the thread that pumps this window's messages.
    let outcome = tauri::async_runtime::spawn_blocking(move || focus_app_window(stems))
        .await
        .map_err(|e| format!("focus_window: task join failed: {e}"))?;
    match outcome {
        FocusOutcome::Focused => Ok(()),
        FocusOutcome::NotRunning => Err(format!("focus_window: no window found for {app_key}")),
        FocusOutcome::Denied => Err("focus_window: OS denied foreground focus".to_string()),
    }
}

#[cfg(target_os = "windows")]
fn focus_app_window(stems: &'static [&'static str]) -> FocusOutcome {
    let mut hwnds: Vec<isize> = Vec::new();
    unsafe {
        // HWNDs collected as raw isize (win_focus.rs rule) and consumed inside
        // this same scan - never stored, never crossing threads.
        let _ = EnumWindows(
            Some(collect_visible_windows),
            LPARAM(&mut hwnds as *mut Vec<isize> as isize),
        );
    }
    for hwnd_raw in hwnds {
        let Some(stem) = process_stem_for_window(hwnd_raw) else {
            continue;
        };
        if stems.contains(&stem.as_str()) {
            return if crate::win_focus::set_foreground_raw(hwnd_raw) {
                FocusOutcome::Focused
            } else {
                FocusOutcome::Denied
            };
        }
    }
    FocusOutcome::NotRunning
}

/// Collects visible, titled top-level windows as raw HWND values. Mirrors the
/// join detector's enum_callback (detect.rs) but keeps only the handle - the
/// title filter is just a cheap way to skip invisible tool/host windows.
#[cfg(target_os = "windows")]
unsafe extern "system" fn collect_visible_windows(
    hwnd: HWND,
    lparam: LPARAM,
) -> windows::core::BOOL {
    unsafe {
        let hwnds = &mut *(lparam.0 as *mut Vec<isize>);
        if !IsWindowVisible(hwnd).as_bool() {
            return true.into();
        }
        if GetWindowTextLengthW(hwnd) <= 0 {
            return true.into();
        }
        hwnds.push(hwnd.0 as isize);
        true.into()
    }
}

/// PID -> lowercase exe file stem ("chrome", "spotify") for one window. Local
/// mirror of detect.rs's private helper of the same name, kept here so this
/// module stays self-contained rather than reaching into the meeting module.
#[cfg(target_os = "windows")]
fn process_stem_for_window(hwnd_raw: isize) -> Option<String> {
    unsafe {
        let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = vec![0u16; 1024];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_FORMAT(0),
            windows::core::PWSTR(buffer.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(process);
        result.ok()?;
        let path = String::from_utf16_lossy(&buffer[..size as usize]);
        let stem = std::path::Path::new(&path)
            .file_stem()?
            .to_string_lossy()
            .to_lowercase();
        Some(stem)
    }
}

#[cfg(not(target_os = "windows"))]
async fn focus_window(_args: &Value) -> Result<(), String> {
    Err("focus_window is only supported on Windows".to_string())
}

// ── launch_app ───────────────────────────────────────────────────────────────

/// Minimum gap between launches. A hostile or looping `desktop.run` stream
/// must not be able to spawn a flood of processes; anything faster is dropped.
#[cfg(target_os = "windows")]
const LAUNCH_COOLDOWN: std::time::Duration = std::time::Duration::from_millis(1500);

/// When the last launch actually happened. `Mutex::new(None)` is const, so this
/// needs no managed state or lazy init. Process-wide (not per voice session):
/// the rate limit is about total spawn pressure, and the auth gate + epoch
/// recheck already bind each launch to a live, unchanged session.
#[cfg(target_os = "windows")]
static LAST_LAUNCH_AT: std::sync::Mutex<Option<std::time::Instant>> =
    std::sync::Mutex::new(None);

/// Returns true and records "now" if a launch is allowed; false if still inside
/// the cooldown from the previous one.
#[cfg(target_os = "windows")]
fn claim_launch_slot() -> bool {
    let mut guard = LAST_LAUNCH_AT.lock().unwrap_or_else(|e| e.into_inner());
    let now = std::time::Instant::now();
    if let Some(prev) = *guard {
        if now.duration_since(prev) < LAUNCH_COOLDOWN {
            return false;
        }
    }
    *guard = Some(now);
    true
}

/// Maps an app key from the agent to the exact shell token Rust will launch.
/// The agent never supplies a path or command - only a key resolved here, so a
/// classic exe ("chrome" via App Paths) and a URI-launched app ("spotify:")
/// both go through one vetted table.
#[cfg(target_os = "windows")]
fn launch_target(app: &str) -> Option<&'static str> {
    Some(match app {
        "chrome" => "chrome",
        "edge" => "msedge",
        "firefox" => "firefox",
        "spotify" => "spotify:",
        "explorer" | "files" => "explorer",
        "notepad" => "notepad",
        "calculator" | "calc" => "calc",
        _ => return None,
    })
}

/// launch_app: start an allowlisted app. Order matters: resolve (cheap) and
/// rate-limit before doing anything, then re-check authorization right before
/// the side effect so a sign-out or account switch since `authorize()` aborts
/// the launch, then spawn off the message-pump thread (CreateProcess can block
/// on a cold binary).
#[cfg(target_os = "windows")]
async fn launch_app(
    app: &AppHandle,
    args: &Value,
    ticket: &security::Ticket,
) -> Result<(), String> {
    let app_key = args
        .get("app")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let Some(target) = launch_target(&app_key) else {
        warn!("system_control: launch_app unknown app key");
        return Err(format!("launch_app: unknown app: {app_key}"));
    };
    if !claim_launch_slot() {
        warn!("system_control: launch_app rate limited");
        return Err("launch_app: rate limited".to_string());
    }
    // The confused-deputy guard: authorization must still hold now, under the
    // same account it was issued to (security.rs epoch), or the launch dies.
    security::recheck(app, Operation::DesktopControl, ticket)?;
    info!("system_control: launch_app app={app_key}");

    tauri::async_runtime::spawn_blocking(move || spawn_launch(target))
        .await
        .map_err(|e| format!("launch_app: task join failed: {e}"))?
        .map_err(|e| format!("launch_app failed: {e}"))
}

/// Launches `target` via the shell so App Paths (chrome) and URI protocols
/// (spotify:) resolve uniformly. `target` is always a Rust-owned allowlist
/// token, never agent input, so cmd's parsing is not an injection surface. The
/// empty "" is start's title argument; CREATE_NO_WINDOW suppresses the console
/// flash. We do not wait on the child - cmd runs `start` and exits on its own.
#[cfg(target_os = "windows")]
fn spawn_launch(target: &str) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("cmd")
        .args(["/C", "start", "", target])
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_child| ())
}

#[cfg(not(target_os = "windows"))]
async fn launch_app(
    _app: &AppHandle,
    _args: &Value,
    _ticket: &security::Ticket,
) -> Result<(), String> {
    Err("launch_app is only supported on Windows".to_string())
}
