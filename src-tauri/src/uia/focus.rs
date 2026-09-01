//! "Can I type here?" - one bounded question about the focused element.
//!
//! Dictation types with SendInput, which delivers keystrokes to whatever holds
//! keyboard focus. That is right when a text box has focus and actively harmful
//! when one does not: a sentence of letters aimed at a web app's list view is a
//! burst of single-key shortcuts, and in Gmail `e` archives while `#` deletes.
//! So the insert path asks this module first.
//!
//! Three properties make this safe to put in front of the user's keystrokes:
//!
//! 1. **It reads no values.** `tree.rs` reads `CurrentValue` because screen
//!    context needs content. This path must never do that: the focused field is
//!    exactly where a half-written message lives. A role name and two booleans
//!    are the entire payload.
//! 2. **It fails open.** Every failure - no UI Automation on the machine, a
//!    timeout, a worker busy with a voice turn, an unfamiliar role - resolves to
//!    `Unknown`, and `Unknown` types. A wrong "not a text box" would make
//!    dictation useless in whatever app got misjudged, which is far worse than
//!    the shortcut hazard it is trying to avoid.
//! 3. **It only blocks on certainty.** The blocklist below is roles that cannot
//!    accept text under any implementation, not an allowlist of roles that can.
//!
//! Read-only, so `uia/mod.rs`'s invariant holds: no pattern here acts on the
//! user's applications.

#![cfg(windows)]

use windows::Win32::UI::Accessibility::{
    IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern, UIA_ValuePatternId,
};

use super::tree::{is_own_process, role_name};

pub use super::focus_verdict::{FocusProbe, FocusVerdict};

/// Roles that cannot accept typed text in any implementation. Everything absent
/// from this list resolves to `Unknown` and therefore types, including `Pane`,
/// `Window`, `Group` and `Custom`, which real applications use for containers
/// that DO forward keystrokes to a hidden editor.
const NEVER_TYPABLE: &[&str] = &[
    "Button",
    "CheckBox",
    "RadioButton",
    "List",
    "ListItem",
    "Tree",
    "TreeItem",
    "Menu",
    "MenuBar",
    "MenuItem",
    "Tab",
    "TabItem",
    "Slider",
    "ScrollBar",
    "ProgressBar",
    "ToolBar",
    "TitleBar",
    "Image",
    "Separator",
    "StatusBar",
    "Thumb",
    "SplitButton",
    "Hyperlink",
    "Calendar",
    "ToolTip",
    "AppBar",
];

/// Runs on the UIA worker thread only: `IUIAutomation` and its elements belong
/// to that apartment.
pub(super) fn probe(automation: &IUIAutomation) -> FocusProbe {
    // No pointer-element fallback, unlike the context walk. "What is under the
    // cursor" answers a different question than "where would a keystroke go",
    // and only the second one is relevant to typing.
    let focused = unsafe { automation.GetFocusedElement() }.ok();
    let Some(focused) = focused else {
        // Nothing at all has keyboard focus: the desktop, a game, a fullscreen
        // video. Keystrokes would go nowhere useful.
        return FocusProbe {
            verdict: FocusVerdict::NotTypable,
            role: "none",
        };
    };
    // Aura's own HUD never takes focus (WS_EX_NOACTIVATE), so seeing our own
    // process here means something unexpected happened. Do not judge it.
    if is_own_process(&focused) {
        return FocusProbe::unknown();
    }

    let role = unsafe { focused.CurrentControlType() }
        .map(|value| role_name(value.0))
        .unwrap_or("Custom");

    if unsafe { focused.CurrentIsPassword() }
        .map(|flag| flag.as_bool())
        .unwrap_or(false)
    {
        return FocusProbe {
            verdict: FocusVerdict::Password,
            role,
        };
    }

    if NEVER_TYPABLE.contains(&role) {
        return FocusProbe {
            verdict: FocusVerdict::NotTypable,
            role,
        };
    }

    let verdict = match role {
        // A plain edit field. The overwhelmingly common case, and the one that
        // must never pay for an extra cross-process pattern query.
        "Edit" | "Spinner" => FocusVerdict::Typable,
        // Ambiguous by design. A Document is a Word canvas or a Notepad body
        // (typable) or a browser page (not). A ComboBox is typable only when it
        // is the editable kind. Writability is what separates them.
        "Document" | "ComboBox" | "Text" | "DataItem" => match writability(&focused) {
            Some(true) => FocusVerdict::Typable,
            Some(false) => FocusVerdict::NotTypable,
            None => FocusVerdict::Unknown,
        },
        _ => FocusVerdict::Unknown,
    };
    FocusProbe { verdict, role }
}

/// `Some(true)` when the element exposes a writable text surface, `Some(false)`
/// when it exposes an explicitly read-only one, `None` when it says nothing
/// either way (which fails open).
///
/// Only ValuePattern is asked, because `CurrentIsReadOnly` is the one direct
/// statement in either direction. TextPattern is deliberately NOT used as a
/// substitute: a browser page and a rich text editor both expose one, the first
/// only for selection, so its presence would answer the wrong question
/// confidently.
fn writability(element: &IUIAutomationElement) -> Option<bool> {
    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .ok()?;
    let read_only = unsafe { pattern.CurrentIsReadOnly() }.ok()?;
    Some(!read_only.as_bool())
}
