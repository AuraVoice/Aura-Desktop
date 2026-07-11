//! Zoom/Teams join detection - one polling thread per armed meeting window.
//!
//! React (useMeetingCapture.ts) arms a watch for each armed meeting's time
//! window; this module polls the desktop every 5s inside that window looking
//! for an in-call Zoom/Teams window (process name is the primary signal,
//! window title the confirmation), emits `meeting-join-detected` once on
//! match, then flips to presence-watching and emits `meeting-left` when the
//! match disappears for two consecutive polls. A re-appearance inside the
//! window re-emits join (the backend claim is idempotent per device, so JS
//! treats it as a continuation). The thread self-expires at the window's end:
//! a meeting the user never joins costs nothing and emits nothing.
//!
//! Google Meet has no detector by design - it lives in a browser tab with no
//! distinct process; Meet capture is manual-arm only (KebabMenu).
//!
//! Win32 discipline mirrors win_focus.rs: HWNDs never cross threads (only
//! the data read from them does), and nothing here ever touches the
//! OverlayState mutex.

#![cfg(windows)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use log::{error, info};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::JoinWatchHandle;
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
    IsWindowVisible,
};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// Consecutive match-free polls before the meeting counts as left - one blip
/// (window minimized to tray during a re-dock, title flicker) must not end a
/// capture.
const LEFT_AFTER_MISSES: u32 = 2;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JoinPayload {
    event_id: String,
    app: String,
    window_title: String,
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
        if now >= window_start_ms {
            match find_meeting_window() {
                Some((app_name, title)) => {
                    misses = 0;
                    if !joined {
                        joined = true;
                        info!("meeting.detect: join detected for {event_id} ({app_name})");
                        if let Err(e) = app.emit("meeting-join-detected", JoinPayload {
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
                        misses += 1;
                        if misses >= LEFT_AFTER_MISSES {
                            joined = false;
                            misses = 0;
                            info!("meeting.detect: meeting left for {event_id}");
                            if let Err(e) = app.emit("meeting-left", LeftPayload {
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
fn find_meeting_window() -> Option<(String, String)> {
    let mut windows: Vec<(isize, String)> = Vec::new();
    unsafe {
        // HWNDs are collected as raw isize (win_focus.rs rule) and consumed
        // inside this same scan - never stored, never crossing threads.
        let _ = EnumWindows(
            Some(enum_callback),
            LPARAM(&mut windows as *mut Vec<(isize, String)> as isize),
        );
    }
    for (hwnd_raw, title) in windows {
        let title_lower = title.to_lowercase();
        let Some(exe_stem) = process_stem_for_window(hwnd_raw) else {
            continue;
        };
        // Zoom's in-call window titles: "Zoom Meeting", "Zoom Webinar",
        // sometimes suffixed with the meeting topic.
        if exe_stem == "zoom"
            && (title_lower.contains("zoom meeting") || title_lower.contains("zoom webinar"))
        {
            return Some(("zoom".to_string(), title));
        }
        // New Teams is ms-teams.exe, classic is teams.exe. The main window
        // titles itself "... | Microsoft Teams" all day long, so require a
        // call-ish keyword too. Known limitation: localized UI languages
        // won't match - the manual "Capture this call" path still works.
        if (exe_stem == "ms-teams" || exe_stem == "teams")
            && (title_lower.contains("meeting") || title_lower.contains("call"))
        {
            return Some(("teams".to_string(), title));
        }
    }
    None
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
