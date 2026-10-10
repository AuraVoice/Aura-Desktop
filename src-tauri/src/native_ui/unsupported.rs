//! No backend yet off Windows (plan phase P5, the macOS AX seam). Every call
//! answers with the same reason, so a desktop task on a Mac ends with a clear
//! message instead of a silent no-op.

use super::{Snapshot, UiAction, WindowEntry};

const UNSUPPORTED: &str = "unsupported_platform";

pub struct NativeUi;

impl NativeUi {
    pub fn start() -> Self {
        Self
    }

    pub fn snapshot(&self, _hwnd: isize) -> Result<Snapshot, String> {
        Err(UNSUPPORTED.to_string())
    }

    pub fn act(&self, _hwnd: isize, _action: UiAction) -> Result<String, String> {
        Err(UNSUPPORTED.to_string())
    }
}

pub fn window_exists(_hwnd: isize) -> bool {
    false
}

pub fn window_title(_hwnd: isize) -> String {
    String::new()
}

pub fn window_pid(_hwnd: isize) -> u32 {
    0
}

pub fn app_stem(_hwnd: isize) -> String {
    String::new()
}

pub fn window_rect(_hwnd: isize) -> Option<(i32, i32, u32, u32)> {
    None
}

pub fn is_protected(_hwnd: isize) -> bool {
    false
}

pub fn foreground_window() -> isize {
    0
}

pub fn bring_to_front(_hwnd: isize) -> bool {
    false
}

pub fn last_input_tick() -> u32 {
    0
}

pub fn list_windows() -> Vec<WindowEntry> {
    Vec::new()
}

pub fn list_windows_with_owned(_pid: u32) -> Vec<WindowEntry> {
    Vec::new()
}

pub fn parse_chord(_chord: &str) -> Result<Vec<()>, String> {
    Err(UNSUPPORTED.to_string())
}
