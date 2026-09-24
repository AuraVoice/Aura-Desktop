//! The gates a page cannot talk to (entry section 4 and 5.3). The prompt asks
//! the model to avoid these; this file is what actually stops them, in code,
//! before any action reaches the browser:
//!
//! - A click or a type may only target a ref that exists in the LAST
//!   snapshot. An invented ref, or one from an earlier page, is refused.
//! - A click on, or an Enter into, anything whose role or name reads as
//!   submit / buy / pay / apply / send / post / sign up pauses the task for
//!   the user's explicit yes. No answer means no.
//! - Navigation is http(s) only. Typed text is bounded.
//!
//! Nothing here is a heuristic on page CONTENT: the decision reads the
//! element's accessible role and name, which the page controls, but the
//! outcome of a match is a pause the user resolves, never an action.

use std::collections::HashMap;
use std::sync::OnceLock;

use regex::Regex;

use super::snapshot::RefTarget;

/// One action as the backend returned it, already shape-checked there.
#[derive(Clone, Debug)]
pub struct Action {
    pub kind: String,
    pub why: String,
    pub ref_id: String,
    pub text: String,
    pub submit: bool,
    pub direction: String,
    pub url: String,
    pub ms: u64,
    pub answer: String,
    pub sources: Vec<String>,
    pub reason: String,
    pub detail: String,
}

pub const MAX_TEXT_CHARS: usize = 2000;

pub enum Gate {
    /// Run it.
    Allow,
    /// Pause and ask. Carries what the card says.
    NeedsApproval { description: String },
    /// Refuse, and feed the reason back to the model as the step result.
    Refuse(&'static str),
}

fn risky() -> &'static Regex {
    static RISKY: OnceLock<Regex> = OnceLock::new();
    RISKY.get_or_init(|| {
        Regex::new(
            r"(?i)\b(submit|buy|pay|order|checkout|subscribe|sign ?up|register|apply|send|post|book|reserve|place order|purchase|confirm|donate|add to cart|add to bag)\b",
        )
        .expect("risky-target regex")
    })
}

pub fn check(action: &Action, refs: &HashMap<String, RefTarget>) -> Gate {
    match action.kind.as_str() {
        "click" | "type" => {
            let Some(target) = refs.get(&action.ref_id) else {
                return Gate::Refuse("ref_not_found");
            };
            if action.kind == "type" && action.text.chars().count() > MAX_TEXT_CHARS {
                return Gate::Refuse("text_too_long");
            }
            // Typing without Enter cannot submit anything; only the Enter
            // (or a click) is a commit.
            let commits = action.kind == "click" || action.submit;
            if commits {
                let haystack = format!("{} {}", target.role, target.name);
                if risky().is_match(&haystack) {
                    let what = if target.name.is_empty() {
                        target.role.clone()
                    } else {
                        format!("{} \"{}\"", target.role, target.name)
                    };
                    return Gate::NeedsApproval {
                        description: format!("Allow {} {what}?", if action.kind == "click" { "clicking" } else { "submitting" }),
                    };
                }
            }
            Gate::Allow
        }
        "scroll" => {
            if !action.ref_id.is_empty() && !refs.contains_key(&action.ref_id) {
                return Gate::Refuse("ref_not_found");
            }
            Gate::Allow
        }
        "navigate" => {
            let url = action.url.trim();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Gate::Refuse("url_not_allowed");
            }
            Gate::Allow
        }
        "back" | "read_more" | "wait" | "done" | "blocked" => Gate::Allow,
        _ => Gate::Refuse("unknown_action"),
    }
}
