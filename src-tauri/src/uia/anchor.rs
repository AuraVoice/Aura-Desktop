//! Live text-span anchors: the COM half of "what did the user change about
//! what Aura typed".
//!
//! `span.rs` decides where a span moved to. This module is what actually holds
//! the field, reads it, and keeps the bookkeeping. It exists as a separate
//! module because everything here is apartment-bound: an `IUIAutomationElement`
//! is a COM proxy into another process, it is not `Send`, and it can block for
//! as long as that process feels like. So every value in `AnchorStore` lives on
//! the one worker thread in `worker.rs` and is reached only through that
//! worker's request channel, exactly like the tree walk and the focus probe.
//!
//! Four rules, and each one is load-bearing:
//!
//! 1. **Nothing is read unless training-trace capture is switched on.** The
//!    caller passes that decision in; this module never assumes.
//! 2. **Protected and sensitive fields are never read at all.** A password
//!    element, an element whose automation id or class name reads like a
//!    credential, or a window belonging to a password manager is refused before
//!    any text call is made. Same ordering `tree.rs::build_node` uses: check the
//!    flag, then decide whether to fetch, never fetch and then filter.
//! 3. **Field text never leaves this thread and never reaches disk.** The
//!    baseline document sits in `LiveAnchor::baseline` for the anchor's life and
//!    is dropped with it. What crosses the channel is only the span's own text
//!    plus its outcome, which is what the trace store is allowed to keep.
//! 4. **Every read is bounded.** Character caps on the text, a cap on live
//!    anchors, and a TTL, because an app that stops responding must cost one
//!    slow call and not a growing pile of them.

#![cfg(windows)]

use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use windows::core::BSTR;
use windows::Win32::UI::Accessibility::{
    IUIAutomation, IUIAutomationElement, IUIAutomationTextPattern, IUIAutomationValuePattern,
    TextPatternRangeEndpoint_End, TextPatternRangeEndpoint_Start, TextUnit_Character,
    UIA_TextPatternId, UIA_ValuePatternId,
};

use super::span::{self, Relocation, Span};
use super::tree::{is_own_process, role_name};

/// Hard cap on how much of a field is ever pulled across the process boundary.
/// A dictation target is a message box, a subject line, a comment: tens to
/// hundreds of characters. This is generous enough to cover a long email and
/// small enough that landing in a 200-page document costs one bounded marshal.
pub const MAX_FIELD_CHARS: usize = 20_000;
/// How many fields are watched at once. Past this the oldest is retired, which
/// costs one trace its edit tracking and nothing else.
const MAX_LIVE_ANCHORS: usize = 8;
/// How many spans one field tracks. A user dictating twenty times into the same
/// box is real; tracking every one of them forever is not.
const MAX_SPANS_PER_ANCHOR: usize = 12;
/// A baseline captured on the focus probe is only usable for the insert that
/// immediately follows it. Past this the field has had time to change underneath
/// us and the "before" no longer describes what was typed into.
const PENDING_BASELINE_TTL: Duration = Duration::from_secs(5);

/// Automation ids, class names and control names that mean "this field holds a
/// credential". Matched case-insensitively as substrings, because the naming is
/// never consistent across frameworks and a false positive here only costs one
/// trace while a false negative costs a secret.
const SENSITIVE_FIELD_HINTS: &[&str] = &[
    "password", "passwd", "pwd", "passphrase", "pass phrase", "pin", "otp", "2fa", "mfa",
    "totp", "onetime", "one-time", "verification code", "securitycode", "security code", "cvv",
    "cvc", "csc", "cardnumber", "card number", "creditcard", "credit card", "debitcard",
    "expiry", "expiration", "ssn", "socialsecurity", "social security", "taxid", "nationalid",
    "passport", "iban", "swift", "routing", "accountnumber", "account number", "sortcode",
    "secret", "apikey", "api key", "token", "privatekey", "private key", "seedphrase",
    "seed phrase", "mnemonic", "recoverykey", "recovery key", "licensekey", "license key",
    "securityanswer", "security answer", "securityquestion",
];

/// Executables whose windows are never traced regardless of what the focused
/// control claims to be. Password managers and authenticators put real
/// credentials into ordinary-looking Edit controls, and a search field in one of
/// them is a search across a vault.
const SENSITIVE_APPS: &[&str] = &[
    "1password", "1password-cli", "agilebits", "keepass", "keepass2", "keepassxc", "bitwarden",
    "lastpass", "dashlane", "nordpass", "enpass", "roboform", "protonpass", "keeper",
    "keeperpasswordmanager", "authy", "winauth", "gpg", "gpg2", "kleopatra", "seahorse",
    "credentialuibroker", "logonui", "consent", "lsass",
];

/// Opaque handle to one watched field. Only ever a number outside this module,
/// so the COM reference it stands for cannot escape the worker thread.
pub type AnchorId = u64;

/// The structural identity of a field, safe to persist.
///
/// Deliberately carries no `Name`: a control's name is frequently content (a
/// chat row is named after the message in it), whereas the automation id and
/// class name are structural. Same reason `tree.rs::synthesized_id` refuses to
/// persist RuntimeId - this has to survive being written down.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldIdentity {
    /// Stable hash of app + automation id + class name + role.
    pub field_id: String,
    /// Executable stem of the owning process, lowercased. Shown in the review
    /// UI as "where this was dictated".
    pub app: String,
    pub role: String,
}

/// One field's text as it was read, plus everything needed to judge it.
struct FieldText {
    chars: Vec<char>,
    truncated: bool,
}

/// What a focus probe parked for the insert that is about to happen.
struct PendingBaseline {
    element: IUIAutomationElement,
    identity: FieldIdentity,
    text: FieldText,
    captured_at: Instant,
}

/// One span of one utterance, in the coordinates of its anchor's current
/// baseline.
struct LiveSpan {
    trace_id: String,
    span: Span,
    /// Set once the span has been reported as gone, so a removed or lost span
    /// is reported exactly once and then stops being carried.
    resolved: bool,
}

/// One watched field.
struct LiveAnchor {
    id: AnchorId,
    element: IUIAutomationElement,
    /// The field's full text as of the last successful read. Memory only: this
    /// is the value that must never be written down, and it dies with the
    /// anchor.
    baseline: Vec<char>,
    spans: Vec<LiveSpan>,
    created_at: Instant,
}

/// What one span looked like on one observation. This is the entire payload
/// that crosses back to the trace worker, and therefore the entire set of field
/// content that is allowed to be persisted.
#[derive(Clone, Debug)]
pub struct SpanObservation {
    pub trace_id: String,
    pub outcome: SpanOutcome,
}

#[derive(Clone, Debug)]
pub enum SpanOutcome {
    /// The span was re-found. `text` is what the field holds there now.
    Located { text: String, exact: bool },
    /// The surrounding text survived but the dictated words are gone: the user
    /// deleted them. Not a correction, and never a training label.
    Removed,
    /// The field could not be re-found or could not be read. Nothing is
    /// recorded, because a guess here becomes a training label.
    Lost,
}

/// What `anchor_insert` managed to establish about a freshly typed string.
#[derive(Clone, Debug)]
pub struct AnchorOutcome {
    pub anchor_id: Option<AnchorId>,
    pub identity: FieldIdentity,
    /// Why no anchor was created, when none was. Logged, never shown.
    pub refusal: Option<&'static str>,
}

/// Every live anchor, plus the one pending baseline. Owned by the UIA worker
/// thread and touched from nowhere else.
#[derive(Default)]
pub struct AnchorStore {
    pending: Option<PendingBaseline>,
    anchors: Vec<LiveAnchor>,
    next_id: AnchorId,
}

impl AnchorStore {
    /// Called from the focus probe, on the same round trip that decides whether
    /// dictation may type. Reads the field's "before" text so the insert that
    /// follows can be verified rather than assumed.
    ///
    /// Refusing is always safe here: a missing baseline costs the utterance its
    /// edit tracking, and the audio and transcript are still captured.
    pub fn park_baseline(&mut self, element: &IUIAutomationElement) {
        self.pending = None;
        if is_sensitive_element(element) {
            return;
        }
        let Some(identity) = identity_of(element) else {
            return;
        };
        if SENSITIVE_APPS.contains(&identity.app.as_str()) {
            return;
        }
        let Some(text) = read_field_text(element) else {
            return;
        };
        self.pending = Some(PendingBaseline {
            element: element.clone(),
            identity,
            text,
            captured_at: Instant::now(),
        });
    }

    /// Called after the keystrokes have landed, off the latency path.
    ///
    /// The span is accepted ONLY when the field's new text is the parked
    /// baseline with exactly `inserted` spliced into it at one contiguous
    /// position. An application that autocorrected, autocompleted, reformatted
    /// or reordered what was typed fails that check and gets no anchor, so its
    /// transformed text can never be attributed to the recognizer.
    pub fn confirm_insert(
        &mut self,
        automation: &IUIAutomation,
        trace_id: &str,
        inserted: &str,
    ) -> AnchorOutcome {
        let Some(pending) = self.pending.take() else {
            return AnchorOutcome {
                anchor_id: None,
                identity: FieldIdentity::default(),
                refusal: Some("no_baseline"),
            };
        };
        let identity = pending.identity.clone();
        let refuse = |refusal: &'static str| AnchorOutcome {
            anchor_id: None,
            identity: identity.clone(),
            refusal: Some(refusal),
        };

        if pending.captured_at.elapsed() > PENDING_BASELINE_TTL {
            return refuse("baseline_stale");
        }
        // The field may have been re-read as protected in the meantime, and the
        // "before" text is worthless if the element itself is gone.
        if is_sensitive_element(&pending.element) {
            return refuse("field_sensitive");
        }
        let Some(after) = read_field_text(&pending.element) else {
            return refuse("read_failed");
        };
        // A truncated read cannot support `locate_insertion`, whose whole
        // guarantee is that the two texts differ by exactly the insertion.
        if pending.text.truncated || after.truncated {
            return refuse("field_too_large");
        }
        let inserted_chars: Vec<char> = inserted.chars().collect();
        let Some(span) = span::locate_insertion(&pending.text.chars, &after.chars, &inserted_chars)
        else {
            return refuse("insert_not_verbatim");
        };

        // Same element as an anchor already being watched? Then this is a second
        // dictation into the same box, and it joins that anchor so both spans
        // are relocated together and clipped against each other.
        let existing = self.anchors.iter().position(|anchor| {
            unsafe { automation.CompareElements(&anchor.element, &pending.element) }
                .map(|same| same.as_bool())
                .unwrap_or(false)
        });

        let new_span = LiveSpan {
            trace_id: trace_id.to_string(),
            span,
            resolved: false,
        };

        if let Some(index) = existing {
            let anchor = &mut self.anchors[index];
            // Re-derive every existing span against the text that now includes
            // the new insertion, so their contexts are never more than one
            // observation old. Without this, two back-to-back dictations with
            // no separator leave the first one's right context empty and stale,
            // and it would report the second dictation as its own edit.
            remap_spans(anchor, &after.chars);
            anchor.baseline = after.chars;
            if anchor.spans.len() >= MAX_SPANS_PER_ANCHOR {
                anchor.spans.remove(0);
            }
            anchor.spans.push(new_span);
            clip(anchor);
            return AnchorOutcome {
                anchor_id: Some(anchor.id),
                identity,
                refusal: None,
            };
        }

        if self.anchors.len() >= MAX_LIVE_ANCHORS {
            self.anchors.remove(0);
        }
        self.next_id = self.next_id.wrapping_add(1);
        let id = self.next_id;
        self.anchors.push(LiveAnchor {
            id,
            element: pending.element,
            baseline: after.chars,
            spans: vec![new_span],
            created_at: Instant::now(),
        });
        AnchorOutcome {
            anchor_id: Some(id),
            identity,
            refusal: None,
        }
    }

    /// Re-reads the named anchors and reports where each of their spans went.
    /// `retire` is applied first so a caller can drop and read in one round
    /// trip, which is what keeps the observation schedule to a single request.
    pub fn observe(&mut self, read: &[AnchorId], retire: &[AnchorId]) -> Vec<SpanObservation> {
        self.anchors.retain(|anchor| !retire.contains(&anchor.id));

        let mut observations = Vec::new();
        let mut dead: Vec<AnchorId> = Vec::new();
        for anchor in self.anchors.iter_mut().filter(|a| read.contains(&a.id)) {
            // A field that turned protected since it was anchored stops being
            // read immediately, and its spans are dropped rather than reported.
            if is_sensitive_element(&anchor.element) {
                dead.push(anchor.id);
                for live in anchor.spans.iter_mut().filter(|s| !s.resolved) {
                    live.resolved = true;
                    observations.push(SpanObservation {
                        trace_id: live.trace_id.clone(),
                        outcome: SpanOutcome::Lost,
                    });
                }
                continue;
            }
            let Some(current) = read_field_text(&anchor.element) else {
                // The window closed, the control was destroyed, or the app
                // stopped answering. All three mean the same thing: stop
                // guessing about this field.
                dead.push(anchor.id);
                for live in anchor.spans.iter_mut().filter(|s| !s.resolved) {
                    live.resolved = true;
                    observations.push(SpanObservation {
                        trace_id: live.trace_id.clone(),
                        outcome: SpanOutcome::Lost,
                    });
                }
                continue;
            };

            for live in anchor.spans.iter_mut() {
                if live.resolved {
                    continue;
                }
                match span::relocate(&anchor.baseline, live.span, &current.chars) {
                    Relocation::Located { span, exact } => {
                        let text: String = current.chars[span.start..span.end].iter().collect();
                        live.span = span;
                        observations.push(SpanObservation {
                            trace_id: live.trace_id.clone(),
                            outcome: SpanOutcome::Located { text, exact },
                        });
                    }
                    Relocation::Removed { at } => {
                        live.span = Span { start: at, end: at };
                        live.resolved = true;
                        observations.push(SpanObservation {
                            trace_id: live.trace_id.clone(),
                            outcome: SpanOutcome::Removed,
                        });
                    }
                    Relocation::Lost => {
                        live.resolved = true;
                        observations.push(SpanObservation {
                            trace_id: live.trace_id.clone(),
                            outcome: SpanOutcome::Lost,
                        });
                    }
                }
            }
            anchor.baseline = current.chars;
            clip(anchor);
        }

        self.anchors
            .retain(|anchor| !dead.contains(&anchor.id) && anchor.spans.iter().any(|s| !s.resolved));
        self.anchors.sort_by_key(|anchor| anchor.created_at);
        observations
    }

}

/// Re-derives every span's offsets against a newer version of the field.
/// Unresolvable spans are marked resolved so they stop being carried forever.
fn remap_spans(anchor: &mut LiveAnchor, current: &[char]) {
    for live in anchor.spans.iter_mut() {
        if live.resolved {
            continue;
        }
        match span::relocate(&anchor.baseline, live.span, current) {
            Relocation::Located { span, .. } => live.span = span,
            Relocation::Removed { at } => {
                live.span = Span { start: at, end: at };
                live.resolved = true;
            }
            Relocation::Lost => live.resolved = true,
        }
    }
}

/// Stops one span from being relocated across its neighbour and reporting that
/// neighbour's dictation as its own edit.
fn clip(anchor: &mut LiveAnchor) {
    let mut ordered: Vec<(usize, Span)> = anchor
        .spans
        .iter()
        .enumerate()
        .filter(|(_, live)| !live.resolved)
        .map(|(index, live)| (index, live.span))
        .collect();
    span::clip_overlaps(&mut ordered);
    for (index, span) in ordered {
        anchor.spans[index].span = span;
    }
}

/// The structural identity of an element, or `None` when it cannot be
/// established well enough to be worth watching.
fn identity_of(element: &IUIAutomationElement) -> Option<FieldIdentity> {
    if is_own_process(element) {
        return None;
    }
    let role = unsafe { element.CurrentControlType() }
        .map(|value| role_name(value.0))
        .unwrap_or("Custom");
    let automation_id = bstr(unsafe { element.CurrentAutomationId() }.ok());
    let class_name = bstr(unsafe { element.CurrentClassName() }.ok());
    let app = app_stem(element)?;

    let mut hasher = Sha256::new();
    hasher.update(app.as_bytes());
    hasher.update(b"|");
    hasher.update(automation_id.as_bytes());
    hasher.update(b"|");
    hasher.update(class_name.as_bytes());
    hasher.update(b"|");
    hasher.update(role.as_bytes());
    let digest = hasher.finalize();

    Some(FieldIdentity {
        field_id: digest[..8].iter().map(|byte| format!("{byte:02x}")).collect(),
        app,
        role: role.to_string(),
    })
}

fn app_stem(element: &IUIAutomationElement) -> Option<String> {
    let pid = unsafe { element.CurrentProcessId() }.ok()? as u32;
    crate::system_control::process_stem_for_pid(pid)
        .map(|stem| stem.to_ascii_lowercase())
}

/// True when this element must never be read. Checked before every text call,
/// not once at anchor time: a control can become a password field (a site
/// swapping an input type) long after it was first seen.
fn is_sensitive_element(element: &IUIAutomationElement) -> bool {
    // An element we cannot even ask about is treated as sensitive. This is the
    // one place in the UIA layer that fails CLOSED rather than open, and the
    // asymmetry is deliberate: `focus.rs` fails open because refusing to type
    // would break dictation in whatever app was misjudged, while refusing to
    // record only ever costs one training sample.
    let Ok(is_password) = (unsafe { element.CurrentIsPassword() }) else {
        return true;
    };
    if is_password.as_bool() {
        return true;
    }
    let haystacks = [
        bstr(unsafe { element.CurrentAutomationId() }.ok()),
        bstr(unsafe { element.CurrentClassName() }.ok()),
        bstr(unsafe { element.CurrentName() }.ok()),
    ];
    haystacks.iter().any(|value| {
        let lowered = value.to_ascii_lowercase();
        SENSITIVE_FIELD_HINTS
            .iter()
            .any(|hint| lowered.contains(hint))
    })
}

/// Reads the focused field's text, bounded.
///
/// ValuePattern first: it is what a plain edit box, a browser `<input>` and a
/// `<textarea>` all expose, it returns the whole value in one call, and it is
/// the cheapest of the two. TextPattern second, for the rich surfaces
/// (a Word canvas, a contenteditable) that expose no value at all.
fn read_field_text(element: &IUIAutomationElement) -> Option<FieldText> {
    if let Some(value) = read_value_pattern(element) {
        return Some(value);
    }
    read_text_pattern(element)
}

fn read_value_pattern(element: &IUIAutomationElement) -> Option<FieldText> {
    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId) }
            .ok()?;
    let raw = unsafe { pattern.CurrentValue() }.ok()?.to_string();
    let chars: Vec<char> = raw.chars().collect();
    let truncated = chars.len() > MAX_FIELD_CHARS;
    Some(FieldText {
        chars: if truncated {
            chars[..MAX_FIELD_CHARS].to_vec()
        } else {
            chars
        },
        truncated,
    })
}

/// The document path. A whole-document read is tried first and, when the
/// document turns out to be larger than the cap, a window centred on the caret
/// is taken instead - a 200-page document's first 20,000 characters say nothing
/// about a sentence dictated on page 140, whereas the text around the caret is
/// exactly the neighbourhood the span lives in.
fn read_text_pattern(element: &IUIAutomationElement) -> Option<FieldText> {
    let pattern =
        unsafe { element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId) }
            .ok()?;

    // `GetText` takes a maximum length, so asking for one more than the cap is
    // how the truncation is detected without ever marshalling the whole thing.
    let probe = MAX_FIELD_CHARS + 1;
    if let Ok(range) = unsafe { pattern.DocumentRange() } {
        if let Ok(text) = unsafe { range.GetText(probe as i32) } {
            let chars: Vec<char> = text.to_string().chars().collect();
            if chars.len() <= MAX_FIELD_CHARS {
                return Some(FieldText {
                    chars,
                    truncated: false,
                });
            }
        }
    }

    caret_window(&pattern)
}

/// A bounded window of text either side of the caret.
///
/// `MoveEndpointByUnit` is asked to walk backwards then forwards by characters
/// from the selection, which is what turns "somewhere in a huge document" into
/// a readable neighbourhood. Marked truncated on the way out, because a windowed
/// read cannot support `locate_insertion` - that check needs to see the whole
/// before and after.
fn caret_window(pattern: &IUIAutomationTextPattern) -> Option<FieldText> {
    let half = (MAX_FIELD_CHARS / 2) as i32;
    let selection = unsafe { pattern.GetSelection() }.ok()?;
    if unsafe { selection.Length() }.unwrap_or(0) < 1 {
        return None;
    }
    let range = unsafe { selection.GetElement(0) }.ok()?;
    let window = unsafe { range.Clone() }.ok()?;
    let _ = unsafe {
        window.MoveEndpointByUnit(TextPatternRangeEndpoint_Start, TextUnit_Character, -half)
    };
    let _ = unsafe {
        window.MoveEndpointByUnit(TextPatternRangeEndpoint_End, TextUnit_Character, half)
    };
    let text = unsafe { window.GetText(MAX_FIELD_CHARS as i32) }.ok()?;
    Some(FieldText {
        chars: text.to_string().chars().collect(),
        truncated: true,
    })
}

fn bstr(value: Option<BSTR>) -> String {
    value.map(|raw| raw.to_string()).unwrap_or_default()
}
