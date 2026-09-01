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

use super::JoinWatchHandle;

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Consecutive match-free polls before the meeting counts as left - one blip
/// (window minimized to tray during a re-dock, title flicker) must not end a
/// capture.
const LEFT_AFTER_MISSES: u32 = 2;

use super::JoinDetectedPayload;

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
    for (app_stem, title) in scan::visible_windows() {
        let title_lower = title.to_lowercase();
        if let Some(app_name) = meeting_app_for_window(&app_stem, &title_lower) {
            return Some((app_name.to_string(), title));
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
    use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
        IsWindowVisible,
    };

    pub(super) fn visible_windows() -> Vec<(String, String)> {
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
                process_stem_for_window(hwnd_raw).map(|stem| (stem, title))
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

    /// PID -> lowercase exe file stem ("zoom", "ms-teams") for one window.
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
    use objc2_app_kit::NSWorkspace;

    pub(super) fn visible_windows() -> Vec<(String, String)> {
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
                found.push((stem.to_string(), title));
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
