//! "Can I type here?" on macOS - the Accessibility twin of `focus.rs`.
//!
//! Same question, same three safety properties, same failure direction. Read
//! `focus.rs`'s header for why they matter; only the API underneath differs.
//! The one shape change is that AX reports roles as strings the application
//! supplies rather than as an enum, so `normalize_role` folds them onto the
//! same `&'static str` the Windows side logs. That is deliberately not a
//! passthrough: it keeps an app-chosen string out of the log, and it keeps
//! `FocusProbe::role` a fixed vocabulary on both platforms.

#![cfg(target_os = "macos")]

use crate::macos_ax;

pub use super::focus_verdict::{FocusProbe, FocusVerdict};

/// AX roles that cannot accept typed text in any implementation. Mirrors
/// `focus.rs`'s NEVER_TYPABLE role for role; anything absent resolves to
/// `Unknown` and therefore types, including AXGroup, AXWindow and AXUnknown,
/// which real applications use for containers that DO forward keystrokes.
const NEVER_TYPABLE: &[&str] = &[
    "AXButton",
    "AXCheckBox",
    "AXRadioButton",
    "AXPopUpButton",
    "AXMenuButton",
    "AXList",
    "AXOutline",
    "AXRow",
    "AXCell",
    "AXMenu",
    "AXMenuBar",
    "AXMenuItem",
    "AXMenuBarItem",
    "AXTabGroup",
    "AXSlider",
    "AXScrollBar",
    "AXProgressIndicator",
    "AXToolbar",
    "AXImage",
    "AXSplitter",
    "AXDisclosureTriangle",
    "AXLink",
    "AXIncrementor",
    "AXColorWell",
    "AXHelpTag",
];

/// Every role this module will ever name in a log line. An unrecognized role
/// becomes "AXUnknown" rather than being echoed, so nothing an application
/// chose to call its own control reaches the log.
const KNOWN_ROLES: &[&str] = &[
    "AXTextField",
    "AXTextArea",
    "AXComboBox",
    "AXSearchField",
    "AXStaticText",
    "AXWebArea",
    "AXGroup",
    "AXWindow",
    "AXScrollArea",
    "AXTable",
    "AXSheet",
    "AXApplication",
];

fn normalize_role(role: &str) -> &'static str {
    if let Some(known) = NEVER_TYPABLE.iter().find(|candidate| **candidate == role) {
        return known;
    }
    if let Some(known) = KNOWN_ROLES.iter().find(|candidate| **candidate == role) {
        return known;
    }
    "AXUnknown"
}

/// Reads the system-wide focused element and judges it. Blocking, bounded by
/// `macos_ax`'s messaging timeout; call from a worker thread.
pub(super) fn probe() -> FocusProbe {
    let Some(focused) = macos_ax::focused_element() else {
        // Nothing has keyboard focus, or Accessibility is not granted. Both
        // mean keystrokes would go nowhere useful. This is the one place the
        // answer is NotTypable rather than Unknown, matching focus.rs's
        // treatment of a missing focused element.
        return FocusProbe {
            verdict: FocusVerdict::NotTypable,
            role: "none",
        };
    };

    // Aura's own overlay is a non-activating panel and should never hold focus
    // during an insert, so seeing our own process here means something
    // unexpected happened. Do not judge it.
    if focused.pid != 0 && focused.pid as u32 == std::process::id() {
        return FocusProbe::unknown();
    }

    let role = normalize_role(&focused.role);

    // A password field is an AXTextField carrying the AXSecureTextField
    // subrole; there is no separate role for it, and no boolean like UIA's
    // CurrentIsPassword. The subrole IS the signal.
    if focused.subrole == "AXSecureTextField" {
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
        // The unambiguous text surfaces. Overwhelmingly the common case, and
        // the one that must not pay for a second cross-process AX round trip.
        "AXTextField" | "AXTextArea" | "AXSearchField" => FocusVerdict::Typable,
        // Ambiguous by design, exactly like UIA's Document/ComboBox/Text. A
        // web area is a browser page (not typable) or a contenteditable
        // (typable); a combo box is typable only when it is the editable kind;
        // static text is a label unless the app made it writable. Whether
        // AXValue can be SET is the one direct statement in either direction,
        // and it is a property of the control, never its content.
        "AXComboBox" | "AXWebArea" | "AXStaticText" => match focused.value_settable {
            Some(true) => FocusVerdict::Typable,
            Some(false) => FocusVerdict::NotTypable,
            None => FocusVerdict::Unknown,
        },
        _ => FocusVerdict::Unknown,
    };
    FocusProbe { verdict, role }
}
