//! The physical chord that arms local dictation, and the hook-side state
//! machine that tracks it.
//!
//! `DICTATION_CHORD` is the ONE value anyone edits to change the chord.
//! Everything downstream (virtual key codes, the user-facing label, whether
//! insertion runs the Win guard, whether the voice-toggle tap classifier has
//! to be suppressed, whether the Alt menu guard runs) is derived from it, so
//! flipping it to `RightCtrlOnly` produces a working single-key build with no
//! other edit anywhere and turns both guards off by itself.
//!
//! Mirrors the VOICE_TOGGLE_KEY pattern at voice_toggle_key.rs:14-15.
//!
//! This module is platform-independent on purpose: the virtual key codes are
//! plain integers, so the chord table and its state machine compile (and the
//! label renders) on every target even though capture and insertion are
//! Windows-only.

/// Change this ONE value to switch the physical chord. Everything else
/// (vk codes, label, Win guard, voice-toggle suppression) derives from it.
pub const DICTATION_CHORD: DictationChord = DictationChord::CtrlWin;

// Win32 virtual key codes. Written out rather than imported from the windows
// crate so this table stays target-independent.
const VK_LSHIFT: u32 = 0xA0;
const VK_RSHIFT: u32 = 0xA1;
const VK_LCONTROL: u32 = 0xA2;
const VK_RCONTROL: u32 = 0xA3;
const VK_LMENU: u32 = 0xA4;
const VK_RMENU: u32 = 0xA5;
const VK_LWIN: u32 = 0x5B;
const VK_RWIN: u32 = 0x5C;

/// Ctrl + Win is the default because it exists on 100% of Windows keyboards,
/// is comfortable one-handed in the bottom-left corner, and does nothing in
/// Windows when held without a third key. The alternatives all lose on a
/// concrete conflict: Ctrl+Alt is what AltGr emits on international layouts,
/// Ctrl+Shift is the layout-cycle hotkey, Win+Shift (as Shift+Alt's cousin)
/// and Win+Alt are kept only as escape hatches, and Right Ctrl is missing from
/// most compact laptops.
#[allow(dead_code)]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DictationChord {
    CtrlWin,
    CtrlShift,
    CtrlAlt,
    WinShift,
    WinAlt,
    RightCtrlOnly,
}

impl DictationChord {
    /// (anchor vk set, partner vk set). The chord is engaged when at least one
    /// anchor key is down and, unless the partner set is empty, at least one
    /// partner key is down. An empty partner set means a single-key chord.
    pub fn vk_sets(self) -> (&'static [u32], &'static [u32]) {
        match self {
            DictationChord::CtrlWin => (&[VK_LCONTROL, VK_RCONTROL], &[VK_LWIN, VK_RWIN]),
            DictationChord::CtrlShift => (&[VK_LCONTROL], &[VK_LSHIFT, VK_RSHIFT]),
            DictationChord::CtrlAlt => (&[VK_LCONTROL], &[VK_LMENU, VK_RMENU]),
            DictationChord::WinShift => (&[VK_LWIN], &[VK_LSHIFT, VK_RSHIFT]),
            DictationChord::WinAlt => (&[VK_LWIN], &[VK_LMENU, VK_RMENU]),
            DictationChord::RightCtrlOnly => (&[VK_RCONTROL], &[]),
        }
    }

    /// Rendered verbatim in the HUD and any other user-facing copy. Nothing
    /// anywhere may hardcode a chord string.
    ///
    /// The keys are the same physical ones on both platforms - `vk_sets` above
    /// does not branch - but their NAMES are not, so this is the one place in
    /// the module that knows which OS it is on. macOS users read Control and
    /// Command as symbols, and the Windows key's counterpart on an Apple
    /// keyboard is Command. `src/lib/dictationStatus.ts` carries the same
    /// strings as its pre-reply fallback; keep the two in agreement.
    #[cfg(not(target_os = "macos"))]
    pub fn label(self) -> &'static str {
        match self {
            DictationChord::CtrlWin => "Ctrl + Win",
            DictationChord::CtrlShift => "Ctrl + Shift",
            DictationChord::CtrlAlt => "Ctrl + Alt",
            DictationChord::WinShift => "Win + Shift",
            DictationChord::WinAlt => "Win + Alt",
            DictationChord::RightCtrlOnly => "Right Ctrl",
        }
    }

    #[cfg(target_os = "macos")]
    pub fn label(self) -> &'static str {
        match self {
            DictationChord::CtrlWin => "\u{2303} + \u{2318}",
            DictationChord::CtrlShift => "\u{2303} + \u{21e7}",
            DictationChord::CtrlAlt => "\u{2303} + \u{2325}",
            DictationChord::WinShift => "\u{2318} + \u{21e7}",
            DictationChord::WinAlt => "\u{2318} + \u{2325}",
            DictationChord::RightCtrlOnly => "Right \u{2303}",
        }
    }

    /// True when the chord contains a Win key, so insertion must make sure
    /// Windows no longer considers Win logically down. Injecting characters
    /// while it is turns every one of them into a Win chord: "and the
    /// document" would fire Win+D, Win+E and Win+R.
    pub fn needs_win_guard(self) -> bool {
        let (anchor, partner) = self.vk_sets();
        anchor.contains(&VK_LWIN)
            || anchor.contains(&VK_RWIN)
            || partner.contains(&VK_LWIN)
            || partner.contains(&VK_RWIN)
    }

    /// True when the chord's partner is Alt. A bare Alt release activates the
    /// foreground app's menu bar, which then eats the injected text.
    pub fn needs_menu_guard(self) -> bool {
        let (_, partner) = self.vk_sets();
        partner.contains(&VK_LMENU) || partner.contains(&VK_RMENU)
    }

    /// True when any key in the chord is also the configured voice toggle key,
    /// so the tap classifier in voice_toggle_key.rs has to be suppressed for
    /// the duration of the hold. Derived from BOTH constants rather than
    /// hardcoded, so changing either one keeps the guard correct.
    pub fn suppresses_voice_toggle(self) -> bool {
        let (anchor, partner) = self.vk_sets();
        anchor
            .iter()
            .chain(partner.iter())
            .any(|vk| crate::voice_toggle_key::is_voice_toggle_vk(*vk))
    }

    fn is_chord_key(self, vk: u32) -> bool {
        let (anchor, partner) = self.vk_sets();
        anchor.contains(&vk) || partner.contains(&vk)
    }
}

/// What the keyboard hook asks the dictation worker to do next.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ChordSignal {
    /// First key of the chord went down. Warms the MODEL only, never the
    /// microphone: this is an ordinary Ctrl or Win press until proven
    /// otherwise, and the hook cannot see mouse input, so a Ctrl-click is
    /// indistinguishable from a long deliberate hold.
    Prewarm,
    /// Every key of the chord is down. Open the microphone and start decoding.
    Arm,
    /// A chord key came up. Flush the decoder and insert.
    Release,
    /// The chord was abandoned before it ever completed. Drop the warm client.
    Cancel,
    /// Escape was pressed while a finished transcript was being held for a text
    /// box that never got focus. Drop it. Emitted only while something is
    /// actually held, so an ordinary Escape costs nothing.
    CancelPending,
}

/// One edge of the chord as seen by the hook.
pub struct ChordOutcome {
    pub signal: Option<ChordSignal>,
    /// True when the chord is fully engaged after this event. The voice toggle
    /// classifier uses this to refuse to emit for the rest of the hold.
    pub engaged: bool,
}

/// Hook-thread state for the chord. Lives in a thread_local inside
/// voice_toggle_key's hook thread; never shared, never locked.
#[derive(Default)]
pub struct ChordState {
    anchor_held: u8,
    partner_held: u8,
    prewarmed: bool,
    armed: bool,
}

impl ChordState {
    /// Feeds one PHYSICAL key event (callers must drop injected events first:
    /// the Win guard's own synthetic VK_LWIN keyup would otherwise read as the
    /// user releasing the chord).
    pub fn observe(&mut self, vk: u32, is_down: bool, is_up: bool) -> ChordOutcome {
        let chord = DICTATION_CHORD;
        if !chord.is_chord_key(vk) {
            // A non-chord key while one chord key is down but the chord is not
            // complete means this was an ordinary shortcut, not a dictation:
            // Ctrl+C, Ctrl+V, Ctrl-click, Win+E. Abandon the prewarm on the
            // spot so the microphone is never opened for it. Deliberately NOT
            // done once armed, where a stray keypress must not kill a hold the
            // user is actively speaking into.
            if is_down && self.prewarmed && !self.armed {
                self.prewarmed = false;
                return ChordOutcome {
                    signal: Some(ChordSignal::Cancel),
                    engaged: false,
                };
            }
            return ChordOutcome {
                signal: None,
                engaged: self.engaged(),
            };
        }
        let (anchor, partner) = chord.vk_sets();
        if is_down {
            self.anchor_held |= key_mask(anchor, vk);
            self.partner_held |= key_mask(partner, vk);
        } else if is_up {
            self.anchor_held &= !key_mask(anchor, vk);
            self.partner_held &= !key_mask(partner, vk);
        }

        let engaged = self.engaged();
        let any_held = self.anchor_held != 0 || self.partner_held != 0;
        let signal = if engaged && !self.armed {
            self.armed = true;
            self.prewarmed = true;
            Some(ChordSignal::Arm)
        } else if !engaged && self.armed {
            self.armed = false;
            self.prewarmed = false;
            Some(ChordSignal::Release)
        } else if any_held && !self.prewarmed {
            self.prewarmed = true;
            Some(ChordSignal::Prewarm)
        } else if !any_held && self.prewarmed {
            self.prewarmed = false;
            Some(ChordSignal::Cancel)
        } else {
            None
        };
        ChordOutcome { signal, engaged }
    }

    fn engaged(&self) -> bool {
        let (_, partner) = DICTATION_CHORD.vk_sets();
        self.anchor_held != 0 && (partner.is_empty() || self.partner_held != 0)
    }
}

fn key_mask(keys: &[u32], vk: u32) -> u8 {
    keys.iter()
        .position(|key| *key == vk)
        .map(|index| 1 << index)
        .unwrap_or(0)
}
