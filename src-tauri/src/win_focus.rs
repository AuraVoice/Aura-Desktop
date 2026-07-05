use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;

use log::{error, info, warn};
use tauri::{AppHandle, Manager, WebviewWindow};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_MENU};
use windows::Win32::UI::WindowsAndMessaging::{BringWindowToTop, SetForegroundWindow};

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
pub fn force_foreground(app: &AppHandle, window: &WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else {
        error!("win_focus::force_foreground: failed to get HWND");
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
                    "win_focus::force_foreground: superseded by a newer call before running (generation {my_generation}); skipping"
                );
                return;
            }
        }
        let hwnd = HWND(raw as *mut core::ffi::c_void);
        if !try_set_foreground(hwnd) {
            warn!("win_focus::force_foreground: OS denied foreground focus; Esc is inactive until the panel is clicked");
        }
    });
}

fn try_set_foreground(hwnd: HWND) -> bool {
    tap_alt_key();
    unsafe {
        let _ = BringWindowToTop(hwnd);
        SetForegroundWindow(hwnd).as_bool()
    }
}

/// Synthesizes an Alt key-down immediately followed by a key-up. Never
/// forwarded anywhere as a real keystroke - `SendInput` only makes it count
/// as "the last input event", which is all `SetForegroundWindow` checks for.
fn tap_alt_key() {
    let mut key_down = INPUT::default();
    key_down.r#type = INPUT_KEYBOARD;
    key_down.Anonymous.ki = KEYBDINPUT {
        wVk: VK_MENU,
        wScan: 0,
        dwFlags: Default::default(),
        time: 0,
        dwExtraInfo: 0,
    };

    let mut key_up = INPUT::default();
    key_up.r#type = INPUT_KEYBOARD;
    key_up.Anonymous.ki = KEYBDINPUT {
        wVk: VK_MENU,
        wScan: 0,
        dwFlags: KEYEVENTF_KEYUP,
        time: 0,
        dwExtraInfo: 0,
    };

    unsafe {
        SendInput(&[key_down, key_up], core::mem::size_of::<INPUT>() as i32);
    }
}
