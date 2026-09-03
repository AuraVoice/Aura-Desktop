//! Typing the finished text into whatever window had focus when the chord was
//! armed.
//!
//! Synthetic keystrokes carrying the text as Unicode rather than as keycodes,
//! so no keyboard layout can change what gets typed. `backend` below is the
//! platform seam; `InsertOutcome` and the ORDER of the guards that produce it
//! are shared, and that order is load-bearing on both platforms:
//!
//! ```text
//! foreground == target -> modifiers released -> foreground == target again
//!   -> OS will accept synthetic input -> verdict -> type
//! ```
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
//! The accessibility tree IS read, read-only, to ask one question first: would
//! these keystrokes land in a text box at all (`uia::focus` on Windows,
//! `uia::focus_ax` on macOS)? Typing is aimed at whatever holds focus, so
//! without that question a sentence delivered to a web app's list view is a
//! burst of its single-key shortcuts. Reading the answer stays inside the
//! invariant above; only SetValue would not.

#[cfg(any(windows, target_os = "macos"))]
pub use backend::{foreground_window, insert_text, insert_text_here};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum InsertOutcome {
    Inserted,
    /// Focus moved between arming and release; the text was not typed.
    FocusChanged,
    /// The chord is still physically down past the timeout.
    KeysHeld,
    /// The OS silently discards our synthetic input, so the user would
    /// otherwise think the microphone failed.
    ///
    /// On Windows that is UIPI: the target window belongs to a higher
    /// integrity level process (Task Manager, regedit, an elevated terminal,
    /// most installers). On macOS it is Secure Input, which any application can
    /// turn on system-wide (a focused password field, a locked password
    /// manager, a terminal running `sudo`).
    Blocked,
    /// No text field has focus, so the keystrokes would have landed on
    /// whatever else was there. The caller holds the text instead of typing it.
    NoTextField,
    /// A password field has focus. Never typed into, and never held for later.
    PasswordField,
}

/// SendInput with KEYEVENTF_UNICODE, following the FFI pattern already in
/// system_control.rs's media_control and win_focus.rs's Alt tap.
#[cfg(windows)]
mod backend {
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

    use super::InsertOutcome;
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
        let chord = crate::dictation::chord::DICTATION_CHORD;

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
}

/// CGEvent insertion. Same guard order, same outcomes, same chunking as the
/// Windows backend; every difference below is a property of the platform.
///
/// - The target token is a **pid**, not a window handle. macOS has no
///   process-agnostic "foreground window" identity that is cheap to read, and
///   the caller only ever compares this value for equality, so the frontmost
///   application's pid satisfies the contract exactly.
/// - There is no Win guard and no menu guard. Neither hazard exists here:
///   Command does not open a menu bar on release the way Alt does, so the whole
///   `send_keyup`/`send_tap(VK_CONTROL)` dance has no macOS counterpart and its
///   absence is correct rather than missing. Waiting for the chord keys to come
///   up still matters for the same reason it does on Windows: injecting
///   characters while Control or Command is held turns every one of them into a
///   shortcut.
/// - `Blocked` means Secure Input rather than a higher integrity level. Both
///   are "the OS silently discards our keystrokes", which is the only thing the
///   caller does anything with.
#[cfg(target_os = "macos")]
mod backend {
    use std::time::{Duration, Instant};

    use objc2_core_graphics::{
        CGEvent, CGEventField, CGEventFlags, CGEventSource, CGEventSourceStateID,
        CGEventTapLocation,
    };

    use super::InsertOutcome;
    use crate::macos_input::{is_secure_input_enabled, keycode_for_vk, INJECTED_EVENT_MARKER};
    use crate::uia::FocusVerdict;

    /// UTF-16 code units per posted burst. Kept at the Windows value for the
    /// same reason: Electron apps and remote sessions drop a long synthetic
    /// string, and small bursts with a gap land everywhere.
    const CHUNK_UNITS: usize = 20;
    const CHUNK_GAP: Duration = Duration::from_millis(2);
    /// How long insertion waits for EVERY chord key to come up before giving
    /// up. The chord reports its release as soon as the first key rises, so
    /// this covers a deliberate stagger between the two.
    const CHORD_RELEASE_TIMEOUT: Duration = Duration::from_millis(900);
    const KEY_RELEASE_POLL: Duration = Duration::from_millis(2);
    /// kVK_Return. A newline posted as a raw Unicode LF is ignored by most text
    /// views; a real Return press is what they all understand.
    const KEYCODE_RETURN: u16 = 0x24;

    pub fn foreground_window() -> isize {
        use objc2_app_kit::NSWorkspace;
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier() as isize)
            .unwrap_or(0)
    }

    /// Types `text` into `target` after the guards pass.
    ///
    /// `verdict` answers "would these keystrokes land in a text box", and is
    /// checked LAST, immediately before typing, because it is the guard most
    /// sensitive to time: the user can click somewhere else during the keyup
    /// wait above, and a verdict read before that wait would describe the wrong
    /// control.
    pub fn insert_text(text: &str, target: isize, verdict: FocusVerdict) -> InsertOutcome {
        if foreground_window() != target {
            return InsertOutcome::FocusChanged;
        }
        if !release_modifiers() {
            return InsertOutcome::KeysHeld;
        }
        // Re-read after the guard: waiting for a keyup is a window in which the
        // user can switch away, and typing into the wrong app is worse than
        // typing nothing.
        if foreground_window() != target {
            return InsertOutcome::FocusChanged;
        }
        if is_secure_input_enabled() {
            return InsertOutcome::Blocked;
        }
        match verdict {
            FocusVerdict::Password => return InsertOutcome::PasswordField,
            FocusVerdict::NotTypable => return InsertOutcome::NoTextField,
            // Unknown types. See uia/focus_ax.rs: refusing on an uncertain
            // verdict would break dictation in whatever application was
            // misjudged, which is worse than the shortcut hazard the check
            // exists to avoid.
            FocusVerdict::Typable | FocusVerdict::Unknown => {}
        }
        send_unicode(text)
    }

    /// The deferred write: types text that was held because no text box had
    /// focus when the chord came up, into whatever has focus NOW.
    ///
    /// It deliberately does not compare against the original target. Focus
    /// moving is the whole reason this path exists.
    pub fn insert_text_here(text: &str) -> InsertOutcome {
        let target = foreground_window();
        if target == 0 {
            return InsertOutcome::FocusChanged;
        }
        // The chord is long gone by now, but the user may be mid-shortcut in
        // the app they just clicked into. Posting characters while Command is
        // down turns the whole insert into shortcuts, so this tick is skipped
        // and the caller tries again on the next one.
        if !modifiers_idle() {
            return InsertOutcome::KeysHeld;
        }
        if is_secure_input_enabled() {
            return InsertOutcome::Blocked;
        }
        send_unicode(text)
    }

    /// No modifier currently down, read from the combined session state (the
    /// analogue of GetAsyncKeyState's physical read). Non-blocking, because the
    /// deferred path can simply wait for a better moment.
    fn modifiers_idle() -> bool {
        const BUSY: CGEventFlags = CGEventFlags::MaskControl
            .union(CGEventFlags::MaskCommand)
            .union(CGEventFlags::MaskAlternate)
            .union(CGEventFlags::MaskShift);
        let flags = CGEventSource::flags_state(CGEventSourceStateID::CombinedSessionState);
        !flags.intersects(BUSY)
    }

    /// Waits for the chord to be fully off the keyboard.
    ///
    /// EVERY key of the chord, not just one: the chord signals its release when
    /// the FIRST key rises, so the other is routinely still down here, and a
    /// held Control or Command turns the whole insert into shortcuts. Waiting
    /// on the full set is also what makes both release orders behave
    /// identically. Driven off DICTATION_CHORD, so changing the chord needs no
    /// edit here.
    fn release_modifiers() -> bool {
        let (anchor, partner) = crate::dictation::chord::DICTATION_CHORD.vk_sets();
        let keycodes: Vec<u16> = anchor
            .iter()
            .chain(partner.iter())
            .filter_map(|vk| keycode_for_vk(*vk))
            .collect();
        wait_for_keys_up(&keycodes, CHORD_RELEASE_TIMEOUT)
    }

    fn wait_for_keys_up(keycodes: &[u16], timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            let any_down = keycodes.iter().any(|keycode| {
                CGEventSource::key_state(CGEventSourceStateID::CombinedSessionState, *keycode)
            });
            if !any_down {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(KEY_RELEASE_POLL);
        }
    }

    /// Posts one keyboard event, stamped so the chord tap can tell it apart
    /// from a real keypress.
    fn post(event: &CGEvent) {
        CGEvent::set_integer_value_field(
            Some(event),
            CGEventField::EventSourceUserData,
            INJECTED_EVENT_MARKER,
        );
        // Explicitly clear the modifier flags the window server would otherwise
        // attach from the current keyboard state. Without this a still-settling
        // Command would ride along on the first characters.
        CGEvent::set_flags(Some(event), CGEventFlags::empty());
        CGEvent::post(CGEventTapLocation::SessionEventTap, Some(event));
    }

    /// One character as a down/up pair carrying its UTF-16 units. `wVk`'s
    /// analogue is keycode 0: the unicode string, not the keycode, is what the
    /// receiving app reads.
    fn post_unicode_char(source: Option<&CGEventSource>, units: &[u16]) -> bool {
        for down in [true, false] {
            let Some(event) = CGEvent::new_keyboard_event(source, 0, down) else {
                return false;
            };
            unsafe {
                CGEvent::keyboard_set_unicode_string(
                    Some(&event),
                    units.len() as std::ffi::c_ulong,
                    units.as_ptr(),
                );
            }
            post(&event);
        }
        true
    }

    fn post_keycode(source: Option<&CGEventSource>, keycode: u16) -> bool {
        for down in [true, false] {
            let Some(event) = CGEvent::new_keyboard_event(source, keycode, down) else {
                return false;
            };
            post(&event);
        }
        true
    }

    fn send_unicode(text: &str) -> InsertOutcome {
        let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState);
        if source.is_none() {
            // Without an event source nothing can be posted at all, and the
            // usual cause is a missing Accessibility grant.
            return InsertOutcome::Blocked;
        }
        let source = source.as_deref();

        let mut pending_units = 0usize;
        let mut first = true;
        let gap = |first: &mut bool| {
            if !*first {
                std::thread::sleep(CHUNK_GAP);
            }
            *first = false;
        };

        for character in text.chars() {
            if character == '\n' {
                gap(&mut first);
                if !post_keycode(source, KEYCODE_RETURN) {
                    return InsertOutcome::Blocked;
                }
                pending_units = 0;
                continue;
            }
            let mut buffer = [0u16; 2];
            // Surrogate pairs go in one call, so a chunk boundary never splits
            // a character in half.
            let units = character.encode_utf16(&mut buffer);
            if pending_units == 0 {
                gap(&mut first);
            }
            if !post_unicode_char(source, units) {
                return InsertOutcome::Blocked;
            }
            pending_units += units.len();
            if pending_units >= CHUNK_UNITS {
                pending_units = 0;
            }
        }
        InsertOutcome::Inserted
    }
}
