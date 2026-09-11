//! Zoom/Teams join detection - one polling thread per armed meeting window.
//!
//! React (useMeetingCapture.ts) arms a watch for each eligible meeting's time
//! window; this module polls the desktop every 5s inside that window looking
//! for an in-call Zoom/Teams window (process name is the primary signal,
//! window title the confirmation), emits `meeting-join-detected` once on
//! match, then flips to presence-watching and emits `meeting-left` when the
//! match disappears for two consecutive polls. A re-appearance inside the
//! window re-emits join (the backend claim is idempotent per device, so JS
//! treats it as a continuation). The thread self-expires at the window's end:
//! a meeting the user never joins costs nothing and emits nothing.
//!
//! Browser-hosted Google Meet, Teams, and Zoom calls are recognized from the
//! visible browser window title while the matching calendar window is live.
//!
//! `start_ambient_watch` is the second, always-on consumer of the same scan:
//! one thread for the whole process that emits `meeting-call-seen` /
//! `meeting-call-gone` for ANY call it finds, calendar or not, so the notch
//! can ask "Record this meeting?". It reports; it never captures.
//!
//! The watch loop, the polling cadence and the app-matching table are shared;
//! only `scan` at the bottom is per-platform, and it exists solely to answer
//! "which apps have visible windows, and what are they called". Nothing here
//! ever touches the OverlayState mutex.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use log::{error, info};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::app_icon::IconSource;
use super::{AmbientCallPayload, AmbientGonePayload, AmbientWatchHandle, JoinWatchHandle};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Consecutive match-free polls before the meeting counts as left - one blip
/// (window minimized to tray during a re-dock, title flicker) must not end a
/// capture.
const LEFT_AFTER_MISSES: u32 = 2;
/// The ambient scanner's "gone" threshold for browser-hosted calls. Only the
/// active tab's title is visible, so switching tabs mid-call hides the match
/// without ending the call; the per-event watch below leans on the calendar
/// end for that, but an ad-hoc call has no calendar. Five minutes is the
/// trade-off until a mic-in-use signal can say the call really ended.
const BROWSER_GONE_AFTER_MISSES: u32 = 60;

use super::JoinDetectedPayload;

/// Trailing suffixes browsers append to a tab's title. Stripped before
/// hashing so the same Meet tab keys identically across browsers. The two
/// Firefox entries are DATA copied from what Firefox actually emits, which is
/// why one of them carries an em-dash (written as an escape, never typed).
const BROWSER_TITLE_SUFFIXES: &[&str] = &[
    " - google chrome",
    " - microsoft edge",
    " - brave",
    " \u{2014} mozilla firefox",
    " - mozilla firefox",
];

/// Starts the always-on call scanner. Returns the call it is currently
/// reporting when one is already running, so a remounting webview can seed
/// its prompt state without waiting for the next `meeting-call-seen`.
pub fn start_ambient_watch(app: AppHandle) -> Result<Option<AmbientCallPayload>, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let handle = app.state::<AmbientWatchHandle>();
        let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if watch.cancel.is_some() {
            return Ok(watch.current.clone());
        }
        watch.cancel = Some(cancel.clone());
    }
    let thread_app = app.clone();
    if let Err(e) = std::thread::Builder::new()
        .name("meeting-ambient-watch".to_string())
        .spawn(move || ambient_thread(thread_app, cancel))
    {
        let handle = app.state::<AmbientWatchHandle>();
        let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        watch.cancel = None;
        return Err(e.to_string());
    }
    Ok(None)
}

pub fn stop_ambient_watch(app: &AppHandle) {
    let Some(handle) = app.try_state::<AmbientWatchHandle>() else {
        return;
    };
    let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cancel) = watch.cancel.take() {
        cancel.store(true, Ordering::Relaxed);
    }
    watch.current = None;
}

/// The scanner loop. The handle's `current` is the single source of truth for
/// "which call are we reporting", read and written under the lock each tick,
/// so a stop that clears it mid-sleep is honoured on the next tick and a
/// remount can read it directly.
fn ambient_thread(app: AppHandle, cancel: Arc<AtomicBool>) {
    info!("meeting.detect: ambient watch started");
    // The lock watcher is otherwise only started by the capture engine.
    super::session::ensure_watcher();
    let mut misses: u32 = 0;
    #[cfg(target_os = "macos")]
    let mut trust_logged = false;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        // A locked screen is not "call gone": no scan, no misses.
        if super::session::is_locked() {
            std::thread::sleep(POLL_INTERVAL);
            continue;
        }
        // Window titles come from the accessibility tree, which is empty
        // without the grant. Re-checked every tick because the grant applies
        // live; silent check only, this must never raise the system dialog.
        #[cfg(target_os = "macos")]
        {
            if !crate::macos_ax::is_trusted(false) {
                if !trust_logged {
                    info!("meeting.detect: ambient watch idle, Accessibility not granted");
                    trust_logged = true;
                }
                std::thread::sleep(POLL_INTERVAL);
                continue;
            }
            trust_logged = false;
        }

        let seen = call_signal();
        let current = ambient_current(&app);
        match (seen, current) {
            (Some((next, _)), Some(previous)) if previous.call_key == next.call_key => {
                misses = 0;
            }
            (Some((mut next, icon_source)), previous) => {
                misses = 0;
                if cancel.load(Ordering::Relaxed) {
                    break;
                }
                if let Some(previous) = previous {
                    emit_gone(&app, previous);
                }
                // Once per call, never per tick. A browser-hosted call keeps
                // None: the card shows the meeting site's own icon instead.
                if !(next.app.ends_with("web") || next.app == "google-meet") {
                    next.app_icon = super::app_icon::png_data_url(&icon_source);
                }
                info!(
                    "meeting.detect: ambient call seen ({}, icon={})",
                    next.app,
                    next.app_icon.is_some()
                );
                set_ambient_current(&app, Some(next.clone()));
                if let Err(e) = app.emit(crate::events::MEETING_CALL_SEEN, next) {
                    error!("meeting.detect: emit call seen failed: {e}");
                }
            }
            (None, Some(previous)) => {
                misses += 1;
                if misses >= gone_threshold(&previous.app) {
                    misses = 0;
                    if cancel.load(Ordering::Relaxed) {
                        break;
                    }
                    set_ambient_current(&app, None);
                    emit_gone(&app, previous);
                }
            }
            (None, None) => {
                misses = 0;
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    // Drop this thread's own registration (unless a replacement already
    // took it), same guard as watch_thread below.
    let handle = app.state::<AmbientWatchHandle>();
    let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if watch
        .cancel
        .as_ref()
        .is_some_and(|registered| Arc::ptr_eq(registered, &cancel))
    {
        watch.cancel = None;
        watch.current = None;
    }
    info!("meeting.detect: ambient watch ended");
}

fn ambient_current(app: &AppHandle) -> Option<AmbientCallPayload> {
    let handle = app.state::<AmbientWatchHandle>();
    let watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    watch.current.clone()
}

fn set_ambient_current(app: &AppHandle, current: Option<AmbientCallPayload>) {
    let handle = app.state::<AmbientWatchHandle>();
    let mut watch = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    watch.current = current;
}

fn emit_gone(app: &AppHandle, previous: AmbientCallPayload) {
    info!("meeting.detect: ambient call gone ({})", previous.app);
    let payload = AmbientGonePayload {
        call_key: previous.call_key,
        app: previous.app,
    };
    if let Err(e) = app.emit(crate::events::MEETING_CALL_GONE, payload) {
        error!("meeting.detect: emit call gone failed: {e}");
    }
}

/// The signal seam. Today the only source is a matching window; a mic-in-use
/// check joins here later with `source: "mic"` and the loop above is unchanged.
fn call_signal() -> Option<(AmbientCallPayload, IconSource)> {
    let (app, title, icon_source) = find_meeting_window_with_source()?;
    Some((
        AmbientCallPayload {
            call_key: call_key(&app, &title),
            app,
            window_title: title,
            source: "window".to_string(),
            app_icon: None,
        },
        icon_source,
    ))
}

fn gone_threshold(app: &str) -> u32 {
    if app.ends_with("web") || app == "google-meet" {
        BROWSER_GONE_AFTER_MISSES
    } else {
        LEFT_AFTER_MISSES
    }
}

/// "app:<16 hex of sha256(normalized title)>". Native Zoom always titles its
/// window "Zoom Meeting", so every Zoom call shares a key; that is fine because
/// React clears its decision on `meeting-call-gone`, and two Zoom calls always
/// pass through gone in between. Meet titles carry the meeting code, so a tab
/// switch and return resolves to the same call.
fn call_key(app: &str, title: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(normalized_title(title).as_bytes()));
    format!("{app}:{}", &digest[..16])
}

fn normalized_title(title: &str) -> String {
    let mut normalized = title.trim().to_lowercase();
    // Browsers prepend an unread badge like "(3) " to the active tab's title.
    if let Some(rest) = normalized.strip_prefix('(') {
        if let Some(close) = rest.find(") ") {
            if close > 0 && rest[..close].bytes().all(|b| b.is_ascii_digit()) {
                normalized = rest[close + 2..].to_string();
            }
        }
    }
    for suffix in BROWSER_TITLE_SUFFIXES {
        if let Some(stripped) = normalized.strip_suffix(suffix) {
            normalized = stripped.trim_end().to_string();
            break;
        }
    }
    normalized.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LeftPayload {
    event_id: String,
}

/// Arms detection for one meeting between `window_start_ms` and
/// `window_end_ms` (unix ms). Re-arming an already-watched event replaces the
/// old watch. (Plain function; the #[tauri::command] wrapper lives in mod.rs
/// so non-Windows builds still register a stub.)
pub fn start_join_watch(
    app: AppHandle,
    event_id: String,
    window_start_ms: i64,
    window_end_ms: i64,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let handle = app.state::<JoinWatchHandle>();
        let mut watches = handle.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(previous) = watches.insert(event_id.clone(), cancel.clone()) {
            previous.store(true, Ordering::Relaxed);
        }
    }
    let thread_app = app.clone();
    std::thread::Builder::new()
        .name("meeting-join-watch".to_string())
        .spawn(move || {
            watch_thread(thread_app, event_id, window_start_ms, window_end_ms, cancel)
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn stop_join_watch(app: AppHandle, event_id: String) {
    let handle = app.state::<JoinWatchHandle>();
    let mut watches = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cancel) = watches.remove(&event_id) {
        cancel.store(true, Ordering::Relaxed);
    }
}

fn watch_thread(
    app: AppHandle,
    event_id: String,
    window_start_ms: i64,
    window_end_ms: i64,
    cancel: Arc<AtomicBool>,
) {
    info!("meeting.detect: watching {event_id} until {window_end_ms}");
    let mut joined = false;
    let mut joined_in_browser = false;
    let mut misses: u32 = 0;

    loop {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let now = super::now_ms();
        // Expiry only applies while NOT joined: an overrunning meeting must
        // keep its presence watch so leaving it still stops the capture
        // (otherwise a joined window at expiry records to the 4h cap with
        // nobody watching). The capture engine's own cap bounds the overrun.
        if now >= window_end_ms && !joined {
            break;
        }
        if now >= window_end_ms && joined_in_browser {
            info!("meeting.detect: browser meeting ended for {event_id}");
            if let Err(e) = app.emit(
                crate::events::MEETING_LEFT,
                LeftPayload {
                    event_id: event_id.clone(),
                },
            ) {
                error!("meeting.detect: emit left failed: {e}");
            }
            break;
        }
        if now >= window_start_ms {
            match find_meeting_window() {
                Some((app_name, title)) => {
                    misses = 0;
                    if !joined {
                        joined = true;
                        joined_in_browser = app_name.ends_with("web") || app_name == "google-meet";
                        info!("meeting.detect: join detected for {event_id} ({app_name})");
                        if let Err(e) = app.emit(crate::events::MEETING_JOIN_DETECTED, JoinDetectedPayload {
                            event_id: event_id.clone(),
                            app: app_name,
                            window_title: title,
                        }) {
                            error!("meeting.detect: emit join failed: {e}");
                        }
                    }
                }
                None => {
                    if joined {
                        // EnumWindows exposes only a browser's active tab
                        // title. Switching tabs must not look like leaving an
                        // already detected browser meeting. The calendar end
                        // bounds these captures instead.
                        if joined_in_browser {
                            std::thread::sleep(POLL_INTERVAL);
                            continue;
                        }
                        misses += 1;
                        if misses >= LEFT_AFTER_MISSES {
                            joined = false;
                            misses = 0;
                            info!("meeting.detect: meeting left for {event_id}");
                            if let Err(e) = app.emit(crate::events::MEETING_LEFT, LeftPayload {
                                event_id: event_id.clone(),
                            }) {
                                error!("meeting.detect: emit left failed: {e}");
                            }
                        }
                    }
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }

    // Drop this watch's own map entry (unless a replacement already took it).
    let handle = app.state::<JoinWatchHandle>();
    let mut watches = handle.0.lock().unwrap_or_else(|e| e.into_inner());
    if watches
        .get(&event_id)
        .is_some_and(|current| Arc::ptr_eq(current, &cancel))
    {
        watches.remove(&event_id);
    }
    info!("meeting.detect: watch ended for {event_id}");
}

/// One desktop scan. Returns ("zoom" | "teams", window title) for the first
/// visible in-call window found.
///
/// The matching table below is shared: the platform scan is only responsible
/// for producing (app stem, window title) pairs, and it maps its own notion of
/// a process onto the SAME stems the table already knows. That is what keeps
/// the "zoom" / "google-meet" / "teams-web" app strings identical on both
/// platforms, which matters because `joined_in_browser` and the backend claim
/// both key off them.
pub(crate) fn find_meeting_window() -> Option<(String, String)> {
    find_meeting_window_with_source().map(|(app, title, _)| (app, title))
}

/// `find_meeting_window` plus where the matched app's icon can be read from.
fn find_meeting_window_with_source() -> Option<(String, String, IconSource)> {
    for (app_stem, title, icon_source) in scan::visible_windows() {
        let title_lower = title.to_lowercase();
        if let Some(app_name) = meeting_app_for_window(&app_stem, &title_lower) {
            return Some((app_name.to_string(), title, icon_source));
        }
    }
    None
}

fn meeting_app_for_window<'a>(exe_stem: &str, title_lower: &'a str) -> Option<&'a str> {
    if exe_stem == "zoom"
        && (title_lower.contains("zoom meeting") || title_lower.contains("zoom webinar"))
    {
        return Some("zoom");
    }
    if (exe_stem == "ms-teams" || exe_stem == "teams")
        && (title_lower.contains("meeting") || title_lower.contains("call"))
    {
        return Some("teams");
    }
    let browser = matches!(exe_stem, "chrome" | "msedge" | "brave" | "firefox");
    if !browser {
        return None;
    }
    if title_lower.contains("google meet") || title_lower.starts_with("meet -") {
        return Some("google-meet");
    }
    if title_lower.contains("microsoft teams")
        && (title_lower.contains("meeting") || title_lower.contains("call"))
    {
        return Some("teams-web");
    }
    if title_lower.contains("zoom meeting") || title_lower.contains("zoom webinar") {
        return Some("zoom-web");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::meeting_app_for_window;

    #[test]
    fn recognizes_native_and_browser_meeting_windows() {
        assert_eq!(
            meeting_app_for_window("zoom", "weekly sync - zoom meeting"),
            Some("zoom")
        );
        assert_eq!(
            meeting_app_for_window("chrome", "meet - abc-defg-hij - google chrome"),
            Some("google-meet")
        );
        assert_eq!(
            meeting_app_for_window("msedge", "project call | microsoft teams"),
            Some("teams-web")
        );
        assert_eq!(meeting_app_for_window("chrome", "google calendar"), None);
    }
}

/// The platform scan: every visible window as (app stem, title).
///
/// Windows walks the desktop with EnumWindows and resolves each window's exe
/// stem. Win32 discipline mirrors win_focus.rs: HWNDs are collected as raw
/// isize, consumed inside this same scan, never stored, never crossing threads.
#[cfg(windows)]
mod scan {
    use super::IconSource;
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    pub(super) fn visible_windows() -> Vec<(String, String, IconSource)> {
        let mut windows: Vec<(isize, String)> = Vec::new();
        unsafe {
            let _ = EnumWindows(
                Some(enum_callback),
                LPARAM(&mut windows as *mut Vec<(isize, String)> as isize),
            );
        }
        windows
            .into_iter()
            .filter_map(|(hwnd_raw, title)| {
                process_stem_for_window(hwnd_raw)
                    .map(|(stem, path)| (stem, title, IconSource::Exe(path)))
            })
            .collect()
    }

    unsafe extern "system" fn enum_callback(
        hwnd: HWND,
        lparam: LPARAM,
    ) -> windows::core::BOOL {
        unsafe {
            let windows = &mut *(lparam.0 as *mut Vec<(isize, String)>);
            if !IsWindowVisible(hwnd).as_bool() {
                return true.into();
            }
            let length = GetWindowTextLengthW(hwnd);
            if length <= 0 {
                return true.into();
            }
            let mut buffer = vec![0u16; length as usize + 1];
            let copied = GetWindowTextW(hwnd, &mut buffer);
            if copied > 0 {
                let title = String::from_utf16_lossy(&buffer[..copied as usize]);
                windows.push((hwnd.0 as isize, title));
            }
            true.into()
        }
    }

    /// PID -> (lowercase exe file stem like "zoom" or "ms-teams", full exe
    /// path) for one window.
    fn process_stem_for_window(hwnd_raw: isize) -> Option<(String, String)> {
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
            Some((stem, path))
        }
    }
}

/// macOS has no permission-free EnumWindows analogue, so this is assembled from
/// two sources rather than one:
///
/// - `NSWorkspace.runningApplications` gives every running app's bundle id with
///   no TCC grant at all. `bundle_stem` maps those onto the same stems the
///   Windows exe names produce, so the matching table needs no macOS branch.
/// - Window TITLES come from the accessibility tree, which needs the
///   Accessibility grant dictation already asks for.
///
/// Without that grant the titles come back empty and detection simply never
/// fires. That is the correct failure direction: a missed auto-join is a
/// nuisance, a false one would start recording a meeting the user is not in.
#[cfg(target_os = "macos")]
mod scan {
    use super::IconSource;
    use objc2_app_kit::NSWorkspace;

    pub(super) fn visible_windows() -> Vec<(String, String, IconSource)> {
        let mut found = Vec::new();
        let apps = NSWorkspace::sharedWorkspace().runningApplications();
        for app in apps.iter() {
            let Some(bundle_id) = app.bundleIdentifier() else {
                continue;
            };
            let Some(stem) = bundle_stem(&bundle_id.to_string().to_lowercase()) else {
                continue;
            };
            let pid = app.processIdentifier();
            for title in crate::macos_ax::window_titles(pid) {
                found.push((stem.to_string(), title, IconSource::Pid(pid)));
            }
        }
        found
    }

    /// Bundle id -> the same stem the Windows exe name yields, so
    /// `meeting_app_for_window`'s table is genuinely shared rather than
    /// duplicated. Anything not listed is not an app this detector cares about.
    fn bundle_stem(bundle_id: &str) -> Option<&'static str> {
        Some(match bundle_id {
            "us.zoom.xos" => "zoom",
            "com.microsoft.teams" | "com.microsoft.teams2" => "ms-teams",
            "com.google.chrome" | "com.google.chrome.beta" => "chrome",
            "com.microsoft.edgemac" => "msedge",
            "com.brave.browser" => "brave",
            "org.mozilla.firefox" => "firefox",
            _ => return None,
        })
    }
}
