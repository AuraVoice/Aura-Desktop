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
//!
//! UI Automation IS used, read-only, to ask one question first: would these
//! keystrokes land in a text box at all (`uia::focus`)? Typing is aimed at
//! whatever holds focus, so without that question a sentence delivered to a web
//! app's list view is a burst of its single-key shortcuts. Reading the answer
//! stays inside the invariant above; only SetValue would not.

#![cfg(windows)]

use std::time::{Duration, Instant};

use windows::Win32::Foundation::{CloseHandle, HWND};
use windows::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_LMENU, VK_LWIN, VK_MENU, VK_RETURN, VK_RMENU,
    VK_RWIN, VK_SHIFT,
};
use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use crate::uia::FocusVerdict;

/// UTF-16 code units per SendInput call. One giant array is silently dropped by
/// Electron apps, RDP sessions and Windows Terminal; small chunks with a gap
/// land everywhere.
const CHUNK_UNITS: usize = 20;
const CHUNK_GAP: Duration = Duration::from_millis(2);
/// How long insertion waits for EVERY chord key to come up before giving up.
/// The chord reports its release as soon as the first key rises, so this covers
/// a deliberate stagger between the two: 900ms is comfortably past the 100 to
/// 300ms a human takes to let go of the second one. Past it the text is held
/// rather than typed.
const CHORD_RELEASE_TIMEOUT: Duration = Duration::from_millis(900);
/// Tighter budget for the logical-state wait that follows, once the keys are
/// already known to be physically up.
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
    /// No text field has focus, so the keystrokes would have landed on
    /// whatever else was there. The caller holds the text instead of typing it.
    NoTextField,
    /// A password field has focus. Never typed into, and never held for later.
    PasswordField,
}

pub fn foreground_window() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

/// Types `text` into `target` after the guards pass. HWNDs are carried as raw
/// isize (win_focus.rs's rule) and never stored across threads.
///
/// `verdict` answers "would these keystrokes land in a text box", and is
/// checked LAST, immediately before typing, because it is the guard most
/// sensitive to time: the user can click somewhere else during the keyup wait
/// above, and a verdict read before that wait would describe the wrong control.
pub fn insert_text(text: &str, target: isize, verdict: FocusVerdict) -> InsertOutcome {
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
    match verdict {
        FocusVerdict::Password => return InsertOutcome::PasswordField,
        FocusVerdict::NotTypable => return InsertOutcome::NoTextField,
        // Unknown types. See uia/focus.rs: refusing on an uncertain verdict
        // would break dictation in whatever application was misjudged, which is
        // worse than the shortcut hazard the check exists to avoid.
        FocusVerdict::Typable | FocusVerdict::Unknown => {}
    }
    send_unicode(text)
}

/// The deferred write: types text that was held because no text box had focus
/// when the chord came up, into whatever has focus NOW.
///
/// It deliberately does not compare against the original target. Focus moving
/// is the whole reason this path exists; the user clicking into a reply box, in
/// this app or another one, is the event it is waiting for. Every other guard
/// still applies, and the caller has already confirmed the verdict.
pub fn insert_text_here(text: &str) -> InsertOutcome {
    let target = foreground_window();
    if target == 0 {
        return InsertOutcome::FocusChanged;
    }
    // The chord is long gone by now, but the user may be mid-shortcut in the
    // app they just clicked into. Injecting Unicode while Ctrl is down turns
    // the whole insert into control chords, so this tick is skipped and the
    // caller tries again on the next one.
    if !modifiers_idle() {
        return InsertOutcome::KeysHeld;
    }
    if is_protected_target(target) {
        return InsertOutcome::Blocked;
    }
    send_unicode(text)
}

/// No modifier physically down. Cheaper than `wait_for_keys_up` and
/// non-blocking, because the deferred path can simply wait for a better moment.
fn modifiers_idle() -> bool {
    const MODIFIERS: [VIRTUAL_KEY; 5] = [VK_CONTROL, VK_MENU, VK_SHIFT, VK_LWIN, VK_RWIN];
    !MODIFIERS
        .iter()
        .any(|key| unsafe { GetAsyncKeyState(key.0 as i32) } as u16 & 0x8000 != 0)
}

/// Waits for the chord to be fully off the keyboard, then runs the Win guard
/// (and, for an Alt chord, the menu guard). All of it is driven off
/// DICTATION_CHORD, so a chord without those keys skips the guards entirely.
fn release_modifiers() -> bool {
    let chord = super::chord::DICTATION_CHORD;

    // EVERY key of the chord, not just the ones with a guard. The chord signals
    // its release when the FIRST key rises, so the other one is routinely still
    // down here, and Microsoft's SendInput documentation is explicit that keys
    // already held interfere with injected input: a held Ctrl turns the whole
    // insert into control chords. Waiting on the full set is also what makes
    // both release orders behave identically.
    let (anchor, partner) = chord.vk_sets();
    let chord_keys: Vec<VIRTUAL_KEY> = anchor
        .iter()
        .chain(partner.iter())
        .map(|vk| VIRTUAL_KEY(*vk as u16))
        .collect();
    if !wait_for_keys_up(&chord_keys, CHORD_RELEASE_TIMEOUT) {
        return false;
    }

    if chord.needs_win_guard() && !wait_for_keys_up(&[VK_LWIN, VK_RWIN], KEY_RELEASE_TIMEOUT) {
        return false;
    }
    if chord.needs_menu_guard() && !wait_for_keys_up(&[VK_LMENU, VK_RMENU], KEY_RELEASE_TIMEOUT) {
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

fn wait_for_keys_up(keys: &[VIRTUAL_KEY], timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
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
    let mut input = INPUT {
        r#type: INPUT_KEYBOARD,
        ..Default::default()
    };
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
    let mut input = INPUT {
        r#type: INPUT_KEYBOARD,
        ..Default::default()
    };
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
        // A newline typed as a raw Unicode LF unit is ignored by most edit
        // controls; a real Enter press is what they all understand. Flush
        // whatever is pending first so ordering is preserved.
        if character == '\n' {
            if !chunk.is_empty() {
                if !flush(&chunk, &mut first) {
                    return InsertOutcome::Blocked;
                }
                chunk.clear();
                pending_units = 0;
            }
            let tap = [key_event(VK_RETURN, false), key_event(VK_RETURN, true)];
            if !flush(&tap, &mut first) {
                return InsertOutcome::Blocked;
            }
            continue;
        }
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
