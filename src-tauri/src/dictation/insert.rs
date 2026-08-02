//! Typing the finished text into whatever window had focus when the chord was
//! armed.
//!
//! SendInput with KEYEVENTF_UNICODE, following the FFI pattern already in
//! system_control.rs's media_control and win_focus.rs's Alt tap.
//!
//! Deliberately NOT used here:
//!   - the clipboard, which would clobber whatever the user had copied
//!   - UIA ValuePattern::SetValue, which replaces a field's whole contents
//!     (erasing a half-written email), fires the wrong events for
//!     React-controlled inputs, and would break uia/mod.rs's documented
//!     invariant that the module never acts on user applications
//!   - anything that could reach win_focus::force_foreground, whose lone Alt
//!     tap drops the target window into keyboard menu mode and eats the text

#![cfg(windows)]

use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_LMENU, VK_LWIN, VK_RMENU, VK_RWIN,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

/// UTF-16 code units per SendInput call. One giant array is silently dropped by
/// Electron apps, RDP sessions and Windows Terminal; small chunks with a gap
/// land everywhere.
const CHUNK_UNITS: usize = 20;
const CHUNK_GAP: Duration = Duration::from_millis(2);
/// How long insertion waits for the modifier keys to actually come up before
/// giving up. Past this the text is held rather than typed, because typing it
/// while Win is logically down turns every character into a Win chord.
const KEY_RELEASE_TIMEOUT: Duration = Duration::from_millis(50);
const KEY_RELEASE_POLL: Duration = Duration::from_millis(2);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InsertOutcome {
    Inserted,
    /// Focus moved between arming and release; the text was not typed.
    FocusChanged,
    /// The chord is still physically down past the timeout.
    KeysHeld,
    /// The target window belongs to a higher integrity level process, so
    /// Windows drops our input with no error at all (UIPI). Task Manager,
    /// regedit, an elevated terminal, most installers.
    Blocked,
}

pub fn foreground_window() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

/// Types `text` into `target` after the guards pass. HWNDs are carried as raw
/// isize (win_focus.rs's rule) and never stored across threads.
pub fn insert_text(text: &str, target: isize) -> InsertOutcome {
    if foreground_window() != target {
        return InsertOutcome::FocusChanged;
    }
    if !release_modifiers() {
        return InsertOutcome::KeysHeld;
    }
    // Re-read after the guard: waiting for a keyup is a window in which the
    // user can alt-tab away, and typing into the wrong app is worse than
    // typing nothing.
    if foreground_window() != target {
        return InsertOutcome::FocusChanged;
    }
    if is_protected_target(target) {
        return InsertOutcome::Blocked;
    }
    send_unicode(text)
}

/// The Win guard (and, for an Alt chord, the menu guard). Both are driven off
/// DICTATION_CHORD, so a chord without those keys skips them entirely.
fn release_modifiers() -> bool {
    let chord = super::chord::DICTATION_CHORD;
    if chord.needs_win_guard() && !wait_for_keys_up(&[VK_LWIN, VK_RWIN]) {
        return false;
    }
    if chord.needs_menu_guard() && !wait_for_keys_up(&[VK_LMENU, VK_RMENU]) {
        return false;
    }
    if chord.needs_win_guard() {
        // Idempotent: harmless when the key is already up, and it clears the
        // case where Windows still holds the logical state after the physical
        // key came up.
        send_keyup(&[VK_LWIN, VK_RWIN]);
    }
    if chord.needs_menu_guard() {
        send_keyup(&[VK_LMENU, VK_RMENU]);
        // A bare Alt release activates the foreground app's menu bar, which
        // then swallows the injected text. A lone Ctrl tap cancels menu mode
        // without doing anything else.
        send_tap(VK_CONTROL);
    }
    true
}

fn wait_for_keys_up(keys: &[VIRTUAL_KEY]) -> bool {
    let deadline = Instant::now() + KEY_RELEASE_TIMEOUT;
    loop {
        let any_down = keys
            .iter()
            .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } as u16 & 0x8000 != 0);
        if !any_down {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(KEY_RELEASE_POLL);
    }
}

fn send_keyup(keys: &[VIRTUAL_KEY]) {
    let events: Vec<INPUT> = keys.iter().map(|key| key_event(*key, true)).collect();
    if !events.is_empty() {
        unsafe { SendInput(&events, core::mem::size_of::<INPUT>() as i32) };
    }
}

fn send_tap(key: VIRTUAL_KEY) {
    let events = [key_event(key, false), key_event(key, true)];
    unsafe { SendInput(&events, core::mem::size_of::<INPUT>() as i32) };
}

fn key_event(key: VIRTUAL_KEY, up: bool) -> INPUT {
    let mut input = INPUT::default();
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki = KEYBDINPUT {
        wVk: key,
        wScan: 0,
        dwFlags: if up {
            KEYEVENTF_KEYUP
        } else {
            Default::default()
        },
        time: 0,
        dwExtraInfo: 0,
    };
    input
}

fn unicode_event(unit: u16, up: bool) -> INPUT {
    let mut input = INPUT::default();
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki = KEYBDINPUT {
        wVk: VIRTUAL_KEY(0),
        wScan: unit,
        dwFlags: if up {
            KEYEVENTF_UNICODE | KEYEVENTF_KEYUP
        } else {
            KEYEVENTF_UNICODE
        },
        time: 0,
        dwExtraInfo: 0,
    };
    input
}

fn send_unicode(text: &str) -> InsertOutcome {
    // Surrogate pairs are two down events with no keyup between the halves, so
    // chunk boundaries are chosen on whole characters rather than code units.
    let mut chunk: Vec<INPUT> = Vec::with_capacity(CHUNK_UNITS * 2);
    let mut pending_units = 0usize;
    let mut first = true;
    for character in text.chars() {
        let mut buffer = [0u16; 2];
        let units = character.encode_utf16(&mut buffer);
        for unit in units.iter() {
            chunk.push(unicode_event(*unit, false));
        }
        for unit in units.iter() {
            chunk.push(unicode_event(*unit, true));
        }
        pending_units += units.len();
        if pending_units >= CHUNK_UNITS {
            if !flush(&chunk, &mut first) {
                return InsertOutcome::Blocked;
            }
            chunk.clear();
            pending_units = 0;
        }
    }
    if !chunk.is_empty() && !flush(&chunk, &mut first) {
        return InsertOutcome::Blocked;
    }
    InsertOutcome::Inserted
}

/// Returns false when Windows accepted none of the events. That is what UIPI
/// looks like from here, and the caller must say so rather than let the user
/// think the mic failed.
fn flush(chunk: &[INPUT], first: &mut bool) -> bool {
    if !*first {
        std::thread::sleep(CHUNK_GAP);
    }
    *first = false;
    let sent = unsafe { SendInput(chunk, core::mem::size_of::<INPUT>() as i32) };
    sent != 0
}

/// True when the target window's process cannot even be opened for a limited
/// query, which from a non-elevated process means it is running at a higher
/// integrity level. SendInput into such a window is dropped with no error, so
/// this check exists purely to turn a silent failure into a visible message.
fn is_protected_target(target: isize) -> bool {
    unsafe {
        let hwnd = HWND(target as *mut core::ffi::c_void);
        let mut pid: u32 = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return false;
        }
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(handle) => {
                let _ = CloseHandle(handle);
                false
            }
            Err(_) => true,
        }
    }
}
