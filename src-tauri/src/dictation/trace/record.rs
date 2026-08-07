//! The shape of one training trace.
//!
//! One record is one utterance: the audio, what the recognizer produced, what
//! was actually typed, and - once the field has been watched long enough - what
//! the user turned it into and how that difference is classified.
//!
//! These structs are both the on-disk format (encrypted, see `store.rs`) and
//! the shape the review UI renders, so every field name here is also a wire
//! name. `camelCase` throughout to match the rest of the IPC surface.

#![cfg(windows)]

use serde::{Deserialize, Serialize};

/// Bumped when a field changes meaning rather than merely being added. The
/// store discards an index it cannot understand rather than guessing, because
/// a misread trace becomes a wrong training label.
pub const TRACE_SCHEMA_VERSION: u32 = 1;

/// How far a trace has got through its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TraceState {
    /// Anchored to a real text span and still being watched for edits.
    Watching,
    /// No anchor could be established: the app transformed what was typed, the
    /// field was too large to verify, or UI Automation could not answer. The
    /// audio and the transcript are still here and still usable; only the
    /// "what did the user change" half is missing.
    Unanchored,
    /// Watched to the end of its window. `finalText` is what the user settled
    /// on, and `edits` explains the difference.
    Finalized,
    /// The user deleted the dictated words outright. Deliberately NOT a
    /// correction: there is no replacement text, so there is nothing the
    /// recognizer could have produced that would have been right.
    Discarded,
    /// The span could not be re-found. Nothing about the user's edits is
    /// recorded, because a guess here becomes a training label.
    AnchorLost,
}

impl TraceState {
    /// Whether this trace is done changing, and so is safe to export.
    pub fn is_settled(&self) -> bool {
        !matches!(self, TraceState::Watching)
    }
}

/// How one difference between what was typed and what the user ended up with
/// should be read.
///
/// The split that matters: the first three describe the recognizer getting the
/// audio wrong, and belong in a training label. The last two describe the user
/// changing their mind about their own sentence, and must never be folded in -
/// applying them would produce a transcript that does not match the audio.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum EditClass {
    /// A real recognition error: a different word that sounds alike, or a near
    /// miss on spelling. "there" -> "their", "sarah" -> "sara".
    Verbatim,
    /// The same word, capitalized differently. "iphone" -> "iPhone".
    Casing,
    /// The same words, punctuated differently.
    Punctuation,
    /// Filler the speaker actually said and the user removed. Recorded but
    /// never applied: the audio does contain it, so a label without it is only
    /// correct for a model trained not to emit disfluencies.
    Disfluency,
    /// The user rewriting their own sentence. Never a training label.
    Style,
}

impl EditClass {
    /// Whether this class belongs in the ground-truth transcript exported to
    /// NeMo. Verbatim, casing and punctuation all describe the recognizer
    /// mis-rendering audio it heard correctly or incorrectly; the other two
    /// describe the user changing what they wanted to say.
    pub fn is_ground_truth(&self) -> bool {
        matches!(
            self,
            EditClass::Verbatim | EditClass::Casing | EditClass::Punctuation
        )
    }
}

/// One classified difference.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditOp {
    pub class: EditClass,
    /// What Aura typed. Empty for a pure insertion.
    pub from: String,
    /// What the user has there now. Empty for a pure deletion.
    pub to: String,
    /// Word offset into the inserted text, so the review UI can show the edit
    /// in place rather than as a bare pair.
    pub word_index: usize,
}

/// One decoded token and when it starts.
///
/// ALWAYS EMPTY since dictation moved to the cloud recognizer. The on-device
/// decoder handed these back for free alongside a result it had already
/// computed; asking a provider for word timings would mean transmitting and
/// storing more speech-derived data than the transcript itself, on a path whose
/// whole point is to send as little as possible. The type and the wire field
/// are kept so traces recorded by the previous build still deserialize.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenTiming {
    pub token: String,
    pub at_seconds: f32,
}

/// One utterance, start to finish.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRecord {
    pub trace_id: String,
    pub recorded_at_ms: i64,
    /// Which recognizer produced `rawTranscript`. A corpus is worthless without
    /// knowing which model it is evidence about.
    pub model_id: String,
    /// Executable stem of the app dictated into, lowercased. A control name is
    /// never stored - see `uia::anchor::FieldIdentity`.
    pub app: String,
    pub field_id: String,
    pub role: String,

    pub audio_ms: u32,
    /// False when the user asked for text-only traces, or when the audio blob
    /// was pruned by retention while the record itself was kept.
    pub has_audio: bool,

    /// Exactly what the decoder emitted, before the local correction pass.
    pub raw_transcript: String,
    /// What was actually typed: `rawTranscript` after `vocab::apply_corrections`.
    pub inserted_text: String,
    /// True when the local correction pass changed something, so a reader can
    /// tell an untouched decode from a locally repaired one.
    pub locally_corrected: bool,
    #[serde(default)]
    pub tokens: Vec<TokenTiming>,

    pub state: TraceState,
    #[serde(default)]
    pub observations: u32,
    #[serde(default)]
    pub last_observed_at_ms: i64,
    /// What the watched span held when the trace settled.
    #[serde(default)]
    pub final_text: Option<String>,
    #[serde(default)]
    pub edits: Vec<EditOp>,
    /// `insertedText` with the ground-truth classes applied: the transcript
    /// that best matches the audio. This is what the NeMo manifest exports.
    #[serde(default)]
    pub ground_truth: Option<String>,
    /// Why no anchor was established, when none was. A short machine token
    /// ("insert_not_verbatim", "field_too_large"), never user content.
    #[serde(default)]
    pub anchor_note: Option<String>,

    // --- Sharing. Every field below describes what left this machine, and is
    // the only reason the review UI can honestly say "shared" or "not shared".
    #[serde(default)]
    pub share_state: ShareState,
    /// Firebase UID that owned the first attempted upload. Once set, this trace
    /// may only be uploaded or resolved while that same account is current.
    #[serde(default)]
    pub upload_owner_uid: Option<String>,
    #[serde(default)]
    pub share_attempts: u32,
    /// Wall-clock time before which no upload attempt may be made. Wall clock
    /// rather than a monotonic instant on purpose: the backoff has to survive a
    /// restart, and an `Instant` does not.
    #[serde(default)]
    pub share_next_attempt_ms: i64,
    #[serde(default)]
    pub shared_at_ms: Option<i64>,
    /// Which version of the consent text authorised the upload. Stored per
    /// record, not just per user, so a corpus can always be traced back to the
    /// wording someone actually agreed to.
    #[serde(default)]
    pub consent_version: Option<u32>,
}

/// Where one trace stands with the server.
///
/// `Tombstoned` is the load-bearing one: the local record is deleted the moment
/// the user asks, but the id has to outlive it until the server confirms the
/// delete, or "delete my data" is only true locally. See `store::tombstones`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareState {
    /// Not shareable: sharing is off, the trace never settled, or its audio is
    /// gone. The resting state, and the default for every record written before
    /// sharing existed.
    #[default]
    Ineligible,
    /// Queued. Waiting for the pump, or for `shareNextAttemptMs` to pass.
    Pending,
    /// The server has both the metadata and the audio.
    Uploaded,
    /// Gave up after `MAX_SHARE_ATTEMPTS`. Never retried automatically; the
    /// trace stays locally and is still exportable by hand.
    Failed,
}

impl TraceRecord {
    /// The transcript to train against: the ground truth when the user's edits
    /// were seen, and what was typed when they were not. Never `finalText`
    /// directly, because that still carries style edits.
    pub fn training_text(&self) -> &str {
        self.ground_truth.as_deref().unwrap_or(&self.inserted_text)
    }

    /// Whether the user's edits were actually observed, as opposed to assumed
    /// absent. Only these traces carry a verified label, and the export defaults
    /// to them alone.
    pub fn is_verified(&self) -> bool {
        matches!(self.state, TraceState::Finalized)
    }

    pub fn duration_seconds(&self) -> f64 {
        self.audio_ms as f64 / 1000.0
    }

    /// Whether this trace may be uploaded at all.
    ///
    /// `Finalized` is non-negotiable: any earlier state carries the text as it
    /// was BEFORE the user corrected it, and uploading that would teach the
    /// model that its own mistake was the right answer. Audio is required
    /// because a manifest line without it is not a training pair.
    pub fn is_shareable(&self) -> bool {
        self.is_verified() && self.has_audio
    }
}

/// What the store reports about itself, for the settings page's storage line.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceSummary {
    pub total: usize,
    pub verified: usize,
    pub watching: usize,
    /// Verified traces with at least one recognition-relevant correction.
    /// Manual additions and other writing-style edits are excluded.
    pub with_edits: usize,
    pub audio_bytes: u64,
    pub oldest_recorded_at_ms: Option<i64>,
    /// Reached the server.
    pub shared: usize,
    /// Queued to be shared, or waiting out a backoff.
    pub pending_share: usize,
    /// Deletes still owed to the server. Non-zero here means the machine has
    /// promised something it has not yet delivered, which the settings page
    /// says out loud rather than hiding.
    pub pending_deletions: usize,
}
