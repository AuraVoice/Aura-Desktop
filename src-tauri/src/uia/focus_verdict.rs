//! The focus-probe answer, shared by both platforms' probes.
//!
//! Lives apart from `focus.rs` only because `focus_ax.rs` needs the same two
//! types: dictation's insert path takes a `FocusVerdict` whichever OS produced
//! it, so the vocabulary has to be one definition rather than two that happen
//! to agree. The judgement itself is per-platform; this is just its shape.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FocusVerdict {
    /// A text field has focus. Type.
    Typable,
    /// Certainly not a text field. Hold the text and wait for one.
    NotTypable,
    /// A password field has focus. Never typed into, never held.
    Password,
    /// Could not tell. Type, because refusing is the worse mistake.
    Unknown,
}

/// The verdict, plus the role that produced it. The role is logged (it is a
/// control type, not content) so a misjudged application can be identified from
/// a user's log without ever asking what they were typing.
pub struct FocusProbe {
    pub verdict: FocusVerdict,
    pub role: &'static str,
}

impl FocusProbe {
    pub fn unknown() -> Self {
        Self {
            verdict: FocusVerdict::Unknown,
            role: "unknown",
        }
    }
}
