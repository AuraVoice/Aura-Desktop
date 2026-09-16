//! How long since the user last touched the keyboard or mouse.
//!
//! One question, asked by the dictation share pump so a multi-megabyte FLAC
//! upload never competes with someone actually working. Fails open: when the
//! answer is not available (an unsupported platform, an API failure) the
//! caller treats the machine as idle enough, because the worst outcome of that
//! is an upload during work, whereas the worst outcome of failing closed is the
//! 03:00 window all over again: a queue that never drains.

/// Milliseconds since the last input event, or `None` when unknown.
#[cfg(windows)]
pub fn idle_ms() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    // SAFETY: `info` is a correctly sized, writable struct for the whole call.
    let ok = unsafe { GetLastInputInfo(&mut info) }.as_bool();
    if !ok {
        return None;
    }
    // Both values are 32-bit tick counts that wrap every 49.7 days; wrapping
    // subtraction gives the right answer across that boundary.
    let now = unsafe { GetTickCount() };
    Some(u64::from(now.wrapping_sub(info.dwTime)))
}

/// Not measured off Windows yet: `CGEventSourceSecondsSinceLastEventType` is
/// the macOS answer and lands with the macOS half of the read-back work.
/// Returning `None` reads as "no objection" in the pump.
#[cfg(not(windows))]
pub fn idle_ms() -> Option<u64> {
    None
}

/// Tauri command wrapper. Cheap enough to run inline: two kernel calls, no
/// blocking.
#[tauri::command]
pub fn system_idle_ms() -> Option<u64> {
    idle_ms()
}
