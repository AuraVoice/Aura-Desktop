//! Reading and acting on OTHER applications' windows, for the desktop Operator
//! (`agent_operator/`, future-features.txt "OPERATOR HANDS + DYNAMIC STEPPING",
//! section 3).
//!
//! This is the one module in Aura that acts on another application's UI. It is
//! deliberately separate from `uia/`, which reads only and promises never to
//! invoke a pattern: dictation's focus probe runs on that worker with a 120 ms
//! budget, and a slow whole-window walk here must never sit in front of it.
//!
//! Nothing in here decides WHETHER to act. `agent_operator::guard` does, and
//! only a task the user started reaches this module at all
//! (`Operation::OperatorTask`).
//!
//! Platform seam: Windows is real (UI Automation plus SendInput). macOS has no
//! backend yet (phase P5 in the plan); every call there reports that plainly
//! instead of pretending to work.

use std::collections::HashMap;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use self::windows::*;

#[cfg(not(windows))]
mod unsupported;
#[cfg(not(windows))]
pub use self::unsupported::*;

/// One top-level window the model can choose to work in.
#[derive(Clone, Debug)]
pub struct WindowEntry {
    pub hwnd: isize,
    pub app: String,
    pub title: String,
}

/// What the guard needs to know about a ref, without the live element.
#[derive(Clone, Debug)]
pub struct RefInfo {
    pub role: String,
    pub name: String,
    pub password: bool,
}

/// A rendered, bounded view of one window. `text` is what the model reads;
/// `refs` maps every `[eN]` in it to what the guard checks.
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub text: String,
    pub refs: HashMap<String, RefInfo>,
    pub nodes: usize,
    /// The walk hit its node, depth or time bound before finishing.
    pub cut_short: bool,
}

/// One action on the current target window, already approved by the guard.
#[derive(Clone, Debug)]
pub enum UiAction {
    Click { ref_id: String },
    Type { ref_id: String, text: String, submit: bool },
    Key { chord: String },
    Scroll { ref_id: Option<String>, down: bool },
}
