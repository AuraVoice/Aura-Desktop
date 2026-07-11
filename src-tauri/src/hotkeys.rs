use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use crate::{overlay, security};

/// Summon/hide the overlay.
pub fn summon_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyB)
}

/// Power-user shortcut (not present in the Flutter source): sign out
/// immediately, bypassing the usual confirm step.
pub fn sign_out_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::KeyD)
}

/// Arms/disarms screen-sight for the current voice session.
pub fn screen_sight_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyS)
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut) {
    if shortcut == &summon_shortcut() {
        overlay::hotkey_pressed(app);
    } else if shortcut == &sign_out_shortcut() {
        overlay::sign_out_requested(app);
    } else if shortcut == &screen_sight_shortcut() {
        // Rust owns the armed bit (security.rs). The toggle emits
        // "screen-sight-armed" with the new state; the frontend mirrors that
        // instead of flipping its own boolean off a bare hotkey event.
        security::toggle_screen_sight(app);
    }
}
