use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

use log::error;
#[cfg(target_os = "windows")]
use log::{info, warn};
use tauri::{AppHandle, WebviewWindow};
#[cfg(target_os = "windows")]
use tauri::Manager;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{HWND, RECT};
#[cfg(target_os = "windows")]
use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VIRTUAL_KEY, VK_MENU, VK_NONAME};
#[cfg(target_os = "windows")]
use windows::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, GetForegroundWindow, GetWindowRect, SetForegroundWindow,
};

/// Monotonically increasing "which `force_foreground` call is the latest"
/// counter. Deliberately its own `.manage()`-ed newtype, NOT a field on
/// `overlay::OverlayState` - that struct's `Mutex` must never be locked from
/// a spawned thread the way this one is (see `overlay::apply`'s reentrancy
/// note), and a plain atomic sidesteps that hazard entirely since it never
/// blocks or re-enters anything.
pub struct ForegroundGeneration(pub AtomicU64);

impl Default for ForegroundGeneration {
    fn default() -> Self {
        Self(AtomicU64::new(0))
    }
}

/// Forces the overlay to the foreground - every summon fights Windows'
/// restriction that only the process the user is currently working in may
/// call `SetForegroundWindow` (see the Microsoft Learn remarks on that
/// function).
///
/// This used to attach this process's input queue to the current foreground
/// window's thread (`AttachThreadInput`) to borrow its permission, the same
/// trick the Flutter sibling's native window-effects channel used. Don't
/// reintroduce that: Microsoft's own guidance is that two threads' input
/// queues should never be attached unless they were designed to cooperate,
/// because once attached, input handling on one thread can become
/// synchronous with the other - if the foreground thread is ever slow to
/// pump its queue, the calling thread can hang waiting on it.
/// (https://devblogs.microsoft.com/oldnewthing/20080801-00/?p=21393/,
/// https://aloiskraus.wordpress.com/2018/02/19/the-mysterious-ui-hang-which-resolved-itself-after-20s/)
/// That's exactly what was freezing this window whenever it was summoned
/// over another app.
///
/// Instead, this taps (and immediately releases) Alt via `SendInput` right
/// before `SetForegroundWindow` - satisfies the documented "the calling
/// process received the last input event" exception
/// (https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)
/// without ever sharing an input queue with another process.
///
/// The Win32 calls still run on a spawned thread rather than inline: even
/// though the deadlock above is gone, `SetForegroundWindow` is still a
/// cross-process OS call with no documented time bound, so it stays off
/// whatever thread is servicing this window's own message pump.
///
/// Because that thread has no documented time bound, a call queued behind a
/// slow prior one (or just delayed by OS scheduling) can still be sitting
/// around long after a newer transition has superseded it. `ForegroundGeneration`
/// guards against that: each call claims a strictly increasing number before
/// spawning, and the spawned thread re-checks that number is still current
/// before touching any Win32 API, bailing out otherwise.
#[cfg(target_os = "windows")]
pub fn force_foreground(app: &AppHandle, window: &WebviewWindow) {
    raise(app, window, VK_MENU);
}

/// Same raise, tapping a key no application can see instead of Alt.
///
/// The first attempt at this skipped the synthetic tap entirely, on the theory
/// that a registered global hotkey already grants the process
/// foreground-activation permission. Windows disagreed - the log said
/// "OS denied foreground focus" on the very first chat summon, and the composer
/// showed a caret that swallowed every keystroke. So the tap stays; only the
/// key changes.
///
/// `VK_NONAME` (0xFC) is reserved: no application maps an accelerator to it and
/// neither of our own low-level hooks matches it (dictation's Ctrl+Win chord,
/// voice_toggle_key's Left Ctrl). It counts as the process's last input event,
/// which is all `SetForegroundWindow` checks for, without pushing the
/// newly-foreground window into the keyboard menu mode that `VK_MENU` causes -
/// the mode that swallows the next Left Ctrl double-tap (see overlay::apply).
#[cfg(target_os = "windows")]
pub fn raise_for_hotkey(app: &AppHandle, window: &WebviewWindow) {
    raise(app, window, VK_NONAME);
}

#[cfg(target_os = "windows")]
fn raise(app: &AppHandle, window: &WebviewWindow, tap: VIRTUAL_KEY) {
    let Ok(hwnd) = window.hwnd() else {
        error!("win_focus::raise: failed to get HWND");
        return;
    };
    // HWND wraps a raw pointer and so isn't Send, but it's an opaque handle
    // value the OS looks up in its own table - never dereferenced as memory
    // on our side - so carrying the bare integer across the thread boundary
    // and reconstructing HWND from it on the other side is sound.
    let raw = hwnd.0 as isize;

    // Claim this call's generation before spawning. Whichever call's
    // fetch_add executes last (all RMW ops on one AtomicU64 are totally
    // ordered) permanently invalidates every earlier caller's number, so a
    // thread that finally wakes up after being superseded can tell.
    let my_generation = app
        .try_state::<ForegroundGeneration>()
        .map(|gen_state| gen_state.0.fetch_add(1, Ordering::Relaxed) + 1)
        .unwrap_or(0);

    let app = app.clone();

    thread::spawn(move || {
        if let Some(gen_state) = app.try_state::<ForegroundGeneration>() {
            if gen_state.0.load(Ordering::Relaxed) != my_generation {
                info!(
                    "win_focus::raise: superseded by a newer call before running (generation {my_generation}); skipping"
                );
                return;
            }
        }
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        if try_set_foreground(hwnd, tap) {
            // Logged on success too: "did the overlay actually get the
            // keyboard" is otherwise only answerable by trying to type.
            info!("win_focus::raise: foreground granted");
        } else if tap == VK_MENU {
            warn!("win_focus::raise: OS denied foreground focus; Esc is inactive until the panel is clicked");
        } else {
            warn!("win_focus::raise: OS denied foreground focus; typing goes to the previous app until the overlay is clicked");
        }
    });
}

#[cfg(target_os = "windows")]
fn try_set_foreground(hwnd: HWND, tap: VIRTUAL_KEY) -> bool {
    tap_key(tap);
    unsafe {
        let _ = BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd).as_bool()
    }
}

/// Brings an arbitrary top-level window (identified by its raw HWND value, the
/// same isize-across-threads convention used throughout) to the foreground,
/// reusing the overlay's own last-input-event trick so no input queue is ever
/// shared. Used by system_control's focus_window verb. The caller MUST run
/// this off the window's message-pump thread - `SetForegroundWindow` is an
/// unbounded cross-process OS call. Returns whether the OS granted the change.
#[cfg(target_os = "windows")]
pub fn set_foreground_raw(hwnd_raw: isize) -> bool {
    let hwnd = HWND(hwnd_raw as *mut core::ffi::c_void);
    // Keeps the Alt tap: this targets someone else's window, and menu mode in
    // whatever app we are focusing is not ours to worry about.
    try_set_foreground(hwnd, VK_MENU)
}

/// Centre point of the window the user is currently working in, for picking
/// which monitor to capture. `None` when that window is our own (or there is
/// no foreground window at all), so a caller never mistakes the overlay for
/// the user's screen.
///
/// MUST be called BEFORE the overlay takes foreground. Afterwards the answer is
/// always our own window, and the cursor is no better: it is normally parked on
/// whatever the user just clicked in the overlay.
#[cfg(target_os = "windows")]
pub fn foreground_window_center(app: &AppHandle) -> Option<(i32, i32)> {
    let own_hwnd = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize);

    let foreground = unsafe { GetForegroundWindow() };
    if foreground.0.is_null() {
        return None;
    }
    if Some(foreground.0 as isize) == own_hwnd {
        return None;
    }

    let mut rect = RECT::default();
    if unsafe { GetWindowRect(foreground, &mut rect) }.is_err() {
        return None;
    }
    if rect.right <= rect.left || rect.bottom <= rect.top {
        return None;
    }
    Some((
        rect.left + (rect.right - rect.left) / 2,
        rect.top + (rect.bottom - rect.top) / 2,
    ))
}

#[cfg(not(target_os = "windows"))]
pub fn foreground_window_center(_app: &AppHandle) -> Option<(i32, i32)> {
    None
}

/// Synthesizes a key-down immediately followed by a key-up. Never forwarded
/// anywhere as a real keystroke - `SendInput` only makes it count as "the last
/// input event", which is all `SetForegroundWindow` checks for. Which key it is
/// still matters, though: see `raise_for_hotkey` on why Alt is the wrong one
/// for the notch.
#[cfg(target_os = "windows")]
fn tap_key(key: VIRTUAL_KEY) {
    let mut key_down = INPUT::default();
    key_down.r#type = INPUT_KEYBOARD;
    key_down.Anonymous.ki = KEYBDINPUT {
        wVk: key,
        wScan: 0,
        dwFlags: Default::default(),
        time: 0,
        dwExtraInfo: 0,
    };

    let mut key_up = INPUT::default();
    key_up.r#type = INPUT_KEYBOARD;
    key_up.Anonymous.ki = KEYBDINPUT {
        wVk: key,
        wScan: 0,
        dwFlags: KEYEVENTF_KEYUP,
        time: 0,
        dwExtraInfo: 0,
    };

    unsafe {
        SendInput(&[key_down, key_up], core::mem::size_of::<INPUT>() as i32);
    }
}

/// macOS equivalent of the Windows dance above. macOS has no analogue of
/// Windows' foreground-lock restriction - any process may raise its own
/// window via a direct focus call, so none of the `SendInput`/
/// `SetForegroundWindow`/generation-guard machinery above is needed here.
/// `ForegroundGeneration` stays defined and `.manage()`-ed regardless of
/// platform (see lib.rs) since it costs nothing idle; it's simply never read
/// on this path.
#[cfg(not(target_os = "windows"))]
pub fn force_foreground(_app: &AppHandle, window: &WebviewWindow) {
    if let Err(e) = window.set_focus() {
        error!("win_focus::force_foreground: failed to focus window: {e}");
    }
}

/// No Alt tap exists to skip here, so this is the same direct focus call.
#[cfg(not(target_os = "windows"))]
pub fn raise_for_hotkey(app: &AppHandle, window: &WebviewWindow) {
    force_foreground(app, window);
}
