//! macOS keyboard plumbing shared by dictation's insert path and its chord tap.
//!
//! Two things live here because both sides need to agree on them:
//!
//! - **The keycode table.** `dictation/chord.rs` speaks Win32 virtual-key codes
//!   and says so in its header: "This module is platform-independent on
//!   purpose: the virtual key codes are plain integers." That stays true. This
//!   table is the translation at the platform boundary, so the chord state
//!   machine and all of its tests keep working unmodified on both platforms.
//! - **The injected-event marker.** The Windows hook drops events carrying
//!   `LLKHF_INJECTED`, or the Win guard's own synthetic keyup would read as the
//!   user releasing the chord mid-insert. macOS has no such flag, so the insert
//!   path stamps every event it posts with a private user-data value and the
//!   tap drops anything carrying it. Same guarantee, explicit rather than
//!   ambient.

#![cfg(target_os = "macos")]

/// Stamped into `kCGEventSourceUserData` on every event this app posts, and
/// checked by the chord tap. Any value works as long as both sides use the same
/// one; this is "AURA" in ASCII, which makes it recognisable in a trace.
pub const INJECTED_EVENT_MARKER: i64 = 0x4155_5241;

/// Win32 virtual-key code paired with the macOS virtual keycode for the same
/// physical key. Only the keys `chord.rs` and `voice_toggle_key.rs` can name
/// are here; anything else is not a chord or trigger key and needs no mapping.
///
/// The Win/Command equivalence is the interesting one: `DICTATION_CHORD` is
/// `CtrlWin`, and the Windows key's counterpart on an Apple keyboard is
/// Command, which is why the chord reads as Control+Command there and why
/// `chord.rs::label` renders it as the two symbols.
const KEY_MAP: &[(u32, u16)] = &[
    // (VK_LSHIFT, kVK_Shift)
    (0xA0, 0x38),
    // (VK_RSHIFT, kVK_RightShift)
    (0xA1, 0x3C),
    // (VK_LCONTROL, kVK_Control)
    (0xA2, 0x3B),
    // (VK_RCONTROL, kVK_RightControl)
    (0xA3, 0x3E),
    // (VK_LMENU, kVK_Option)
    (0xA4, 0x3A),
    // (VK_RMENU, kVK_RightOption)
    (0xA5, 0x3D),
    // (VK_LWIN, kVK_Command)
    (0x5B, 0x37),
    // (VK_RWIN, kVK_RightCommand)
    (0x5C, 0x36),
    // (VK_ESCAPE, kVK_Escape)
    (0x1B, 0x35),
];

/// The macOS keycode for a Win32 virtual-key code, if this key has one.
pub fn keycode_for_vk(vk: u32) -> Option<u16> {
    KEY_MAP
        .iter()
        .find(|(candidate, _)| *candidate == vk)
        .map(|(_, keycode)| *keycode)
}

/// The Win32 virtual-key code for a macOS keycode, if this key has one. `None`
/// for every ordinary character key, which the chord machine does not care
/// about.
pub fn vk_for_keycode(keycode: u16) -> Option<u32> {
    KEY_MAP
        .iter()
        .find(|(_, candidate)| *candidate == keycode)
        .map(|(vk, _)| *vk)
}

/// Whether some application has turned on Secure Input, which makes the window
/// server refuse every synthetic keystroke system-wide with no error to the
/// sender.
///
/// This is the macOS analogue of Windows' UIPI drop, and it exists for the same
/// reason `is_protected_target` does over there: to turn a silent failure into a
/// visible message rather than let the user think the microphone died. It is
/// what a focused password field, a locked 1Password, or a terminal running
/// `sudo` puts the system into.
///
/// Declared by hand because it lives in HIToolbox, which the objc2 framework
/// crates do not currently generate.
pub fn is_secure_input_enabled() -> bool {
    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        fn IsSecureEventInputEnabled() -> bool;
    }
    unsafe { IsSecureEventInputEnabled() }
}
