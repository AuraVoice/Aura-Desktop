use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use crate::{dashboard, guide, overlay, security};

/// Summon/hide the overlay.
pub fn summon_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyB)
}

/// Summons the notch with the text chat slot open below it.
pub fn chat_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

/// Opens (or focuses) the in-app dashboard window. Ctrl+Alt+D is free;
/// Ctrl+Shift+D is the sign-out shortcut, a different modifier set.
pub fn open_dashboard_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD)
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

/// Mutes/unmutes Aura's spoken output. Text and captions keep flowing.
pub fn output_mute_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyM)
}

/// Arms or disarms Guide Mode for the pinned cursor monitor.
pub fn guide_mode_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyG)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_dashboard_is_ctrl_alt_d() {
        assert_eq!(
            open_dashboard_shortcut(),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD)
        );
    }

    #[test]
    fn open_dashboard_is_distinct_from_sign_out() {
        // Ctrl+Alt+D vs Ctrl+Shift+D: same key, different modifiers.
        assert_ne!(open_dashboard_shortcut(), sign_out_shortcut());
    }

    #[test]
    fn guide_mode_is_ctrl_alt_g_and_distinct() {
        assert_eq!(
            guide_mode_shortcut(),
            Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyG)
        );
        assert_ne!(guide_mode_shortcut(), screen_sight_shortcut());
    }
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut) {
    if shortcut == &summon_shortcut() {
        overlay::hotkey_pressed(app);
    } else if shortcut == &chat_shortcut() {
        if let Err(e) = overlay::summon_chat(app) {
            log::error!("hotkeys: summon chat failed: {e}");
        }
    } else if shortcut == &open_dashboard_shortcut() {
        if let Err(e) = dashboard::open_dashboard_window(app) {
            log::error!("hotkeys: open dashboard failed: {e}");
        }
    } else if shortcut == &sign_out_shortcut() {
        overlay::sign_out_requested(app);
    } else if shortcut == &screen_sight_shortcut() {
        // Rust owns the armed bit (security.rs). The toggle emits
        // "screen-sight-armed" with the new state; the frontend mirrors that
        // instead of flipping its own boolean off a bare hotkey event.
        security::toggle_screen_sight(app);
    } else if shortcut == &guide_mode_shortcut() {
        guide::toggle(app);
    } else if shortcut == &output_mute_shortcut() {
        // React owns this bit (it persists it, publishes it to the worker, and
        // mutes the live audio elements), so Rust only forwards the press.
        overlay::request_output_mute_toggle(app);
    }
}
