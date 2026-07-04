use tauri::AppHandle;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

use crate::window_mode::{self, WindowMode};

/// Smart toggle: avatar mode if a session is cached, else dashboard/pairing.
pub fn smart_toggle_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyB)
}

/// Always opens dashboard mode, for deliberate sign-out/re-pair/settings access.
pub fn open_dashboard_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyD)
}

pub fn handle(app: &AppHandle, shortcut: &Shortcut) {
    if shortcut == &smart_toggle_shortcut() {
        let mode = window_mode::resolve_smart_toggle_mode(app);
        window_mode::apply_mode(app, mode);
    } else if shortcut == &open_dashboard_shortcut() {
        window_mode::apply_mode(app, WindowMode::Dashboard);
    }
}
