use log::{error, warn};
use tauri::WebviewWindow;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
};

/// Windows denies a plain `SetForegroundWindow` call while another process
/// currently owns the foreground - exactly the case every time this overlay
/// is summoned by a global hotkey. The fix (the same one the Flutter app's
/// own native window-effects channel uses) is to briefly attach this
/// process's input queue to the current foreground window's thread, which
/// grants the foreground-change permission for the duration of the call.
pub fn force_foreground(window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        error!("win_focus::force_foreground: failed to get HWND");
        return;
    };

    if try_set_foreground(hwnd) {
        return;
    }

    // One retry: the foreground window can change between our first read and
    // the attach/detach pair below, so a single immediate retry is cheap
    // insurance rather than assuming the first failure is final.
    if !try_set_foreground(hwnd) {
        warn!("win_focus::force_foreground: OS denied foreground focus; Esc is inactive until the panel is clicked");
    }
}

fn try_set_foreground(hwnd: HWND) -> bool {
    unsafe {
        let foreground = GetForegroundWindow();
        let current_thread = GetCurrentThreadId();
        let foreground_thread = GetWindowThreadProcessId(foreground, None);

        let attached = if !foreground.is_invalid() && foreground.0 != hwnd.0 {
            AttachThreadInput(current_thread, foreground_thread, true).as_bool()
        } else {
            false
        };

        let _ = BringWindowToTop(hwnd);
        let result = SetForegroundWindow(hwnd);

        if attached {
            let _ = AttachThreadInput(current_thread, foreground_thread, false);
        }

        result.as_bool()
    }
}
