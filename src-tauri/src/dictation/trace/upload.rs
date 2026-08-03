//! The sharing queue: which settled traces may be uploaded, when, and what
//! happens when the server says no.
//!
//! Rust owns the queue; JavaScript performs the HTTP. That split is not
//! arbitrary - the Firebase ID token lives in the JS SDK, which is exactly why
//! meeting segments upload the same way (`useMeetingCapture.ts` claims a lease,
//! calls `authFetch`, then resolves it). Keeping the state machine here means a
//! crash mid-request resumes correctly instead of losing the job.
//!
//! Three rules:
//!
//! 1. **Only a `Finalized` trace is ever eligible.** Any earlier state carries
//!    the text as it was BEFORE the user corrected it. Uploading that would
//!    teach the model its own mistake was the right answer, which is the exact
//!    inversion of what this feature is for.
//! 2. **Backoff is wall-clock and persisted.** The backend does not exist yet,
//!    so on day one every attempt 404s. That has to cost one request every
//!    couple of hours, not a hot loop, and it has to still be true after a
//!    restart - which rules out an in-memory `Instant`.
//! 3. **A refusal is never shown to the user.** Sharing is a background
//!    courtesy; a server that is down is not the user's problem to action.

#![cfg(windows)]

use log::info;
use serde::Serialize;
use tauri::AppHandle;

use super::record::{ShareState, TraceRecord};
use super::settings::TraceSettings;
use super::store;

/// Attempts before a trace is abandoned. It stays on disk and stays exportable
/// by hand; only the automatic retry stops.
const MAX_SHARE_ATTEMPTS: u32 = 8;

/// Wall-clock backoff per attempt, in seconds. The long tail is what makes
/// shipping this before the backend exists harmless: by the fourth failure a
/// client is asking twice an hour, and by the sixth, twice a day.
const BACKOFF_SECONDS: [i64; 8] = [30, 60, 300, 1_800, 7_200, 21_600, 43_200, 86_400];

/// Everything the JS pump needs to upload one trace, in the exact shape the
/// backend contract expects as its metadata body. Serialized straight through
/// to the request, so this struct IS the wire format - changing a field name
/// here changes the API.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceUploadLease {
    pub trace_id: String,
    pub schema_version: u32,
    pub recorded_at_ms: i64,
    pub model_id: String,
    pub sherpa_version: String,
    pub app_version: String,
    pub duration_ms: u32,
    /// SHA-256 of the FLAC body the pump will send, so the server can reject a
    /// mismatched pair rather than storing audio that does not match the label.
    pub audio_sha256: String,
    pub audio_bytes: usize,
    /// Raw recognizer output.
    pub asr_text: String,
    /// What was typed, after the local correction pass.
    pub inserted_text: String,
    /// What the user settled on.
    pub final_text: Option<String>,
    /// The training label: `insertedText` with only recognition fixes applied.
    pub ground_truth: Option<String>,
    pub edits: Vec<super::record::EditOp>,
    pub locally_corrected: bool,
    pub observations: u32,
    pub app: String,
    pub field_role: String,
    pub consent_version: u32,
}

/// Marks a settled trace as queued, if it is allowed to be.
///
/// Called from `settle()` at the moment a trace reaches `Finalized`, so there is
/// exactly one place a trace can enter the queue and no path that could queue an
/// unsettled one.
pub fn mark_eligible(record: &mut TraceRecord, settings: &TraceSettings) {
    if !settings.shares() || !record.is_shareable() {
        return;
    }
    if record.share_state != ShareState::Ineligible {
        return;
    }
    record.share_state = ShareState::Pending;
    record.share_attempts = 0;
    record.share_next_attempt_ms = 0;
    record.consent_version = Some(settings.consent_version);
}

/// Queues every already-settled trace that became eligible when the user turned
/// sharing on. Without this, switching the toggle on would only ever share
/// FUTURE dictations and the backlog the user just consented to would sit there.
pub fn enqueue_backlog(app: &AppHandle, settings: &TraceSettings) -> Result<usize, String> {
    if !settings.shares() {
        return Ok(0);
    }
    store::with_records(app, |records| {
        let mut queued = 0usize;
        for record in records.iter_mut() {
            let before = record.share_state;
            mark_eligible(record, settings);
            if before != record.share_state {
                queued += 1;
            }
        }
        (queued > 0, queued)
    })
}

/// The next trace due for upload, or `None` when the queue is empty or
/// everything in it is still waiting out a backoff.
pub fn claim(app: &AppHandle, settings: &TraceSettings) -> Result<Option<TraceUploadLease>, String> {
    if !settings.shares() {
        return Ok(None);
    }
    let now = store::now_ms();
    let app_version = env!("CARGO_PKG_VERSION").to_string();

    // The record is read here, but the FLAC body is produced separately by
    // `audio_body` - the pump asks for it in a second call, so a large body
    // never rides through the lease payload.
    let record = store::with_records(app, |records| {
        let found = records
            .iter()
            .filter(|record| {
                record.share_state == ShareState::Pending
                    && record.share_next_attempt_ms <= now
                    && record.is_shareable()
            })
            // Oldest first, so a backlog drains in the order it happened.
            .min_by_key(|record| record.recorded_at_ms)
            .cloned();
        (false, found)
    })?;

    let Some(record) = record else {
        return Ok(None);
    };
    // Encoding happens now rather than at capture so a trace the user deletes
    // before it is ever shared costs nothing.
    let Ok(wav) = store::read_audio(app, &record.trace_id) else {
        // The blob went while the record survived (retention, or a manual
        // wipe). Not retryable, and not an error worth surfacing.
        store::update(app, &record.trace_id, |stored| {
            stored.share_state = ShareState::Ineligible;
            stored.has_audio = false;
        })?;
        return Ok(None);
    };
    let flac = super::flac::from_wav(&wav)?;
    let digest = sha256_hex(&flac);

    Ok(Some(TraceUploadLease {
        trace_id: record.trace_id.clone(),
        schema_version: super::record::TRACE_SCHEMA_VERSION,
        recorded_at_ms: record.recorded_at_ms,
        model_id: record.model_id.clone(),
        sherpa_version: super::super::stt::SHERPA_VERSION.to_string(),
        app_version,
        duration_ms: record.audio_ms,
        audio_sha256: digest,
        audio_bytes: flac.len(),
        asr_text: record.raw_transcript.clone(),
        inserted_text: record.inserted_text.clone(),
        final_text: record.final_text.clone(),
        ground_truth: record.ground_truth.clone(),
        edits: record.edits.clone(),
        locally_corrected: record.locally_corrected,
        observations: record.observations,
        app: record.app.clone(),
        field_role: record.role.clone(),
        consent_version: record.consent_version.unwrap_or(settings.consent_version),
    }))
}

/// The FLAC body for a claimed trace. Re-encoded rather than cached, because
/// caching it would double the disk cost of every shared utterance for the sake
/// of one request.
pub fn audio_body(app: &AppHandle, trace_id: &str) -> Result<Vec<u8>, String> {
    let wav = store::read_audio(app, trace_id)?;
    super::flac::from_wav(&wav)
}

/// The server has both halves.
pub fn resolve(app: &AppHandle, trace_id: &str) -> Result<(), String> {
    store::update(app, trace_id, |record| {
        record.share_state = ShareState::Uploaded;
        record.shared_at_ms = Some(store::now_ms());
        record.share_next_attempt_ms = 0;
    })?;
    Ok(())
}

/// The attempt failed. `retryable` is false for the answers that will never
/// succeed on their own - a rejected payload, a digest conflict - and true for
/// everything transient, including the 404 that every attempt gets until the
/// backend ships.
pub fn fail(app: &AppHandle, trace_id: &str, retryable: bool) -> Result<(), String> {
    let now = store::now_ms();
    store::update(app, trace_id, |record| {
        record.share_attempts = record.share_attempts.saturating_add(1);
        if !retryable || record.share_attempts >= MAX_SHARE_ATTEMPTS {
            record.share_state = ShareState::Failed;
            return;
        }
        let index = (record.share_attempts as usize - 1).min(BACKOFF_SECONDS.len() - 1);
        record.share_next_attempt_ms = now + BACKOFF_SECONDS[index] * 1_000;
    })?;
    info!("dictation.trace: share attempt failed retryable={retryable}");
    Ok(())
}

/// Lowercase hex SHA-256, matching what the backend contract expects in
/// `X-Audio-Sha256`.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
