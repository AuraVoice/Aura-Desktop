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
/// A monthly reset can be at most one long month away. A little headroom keeps
/// clock skew from turning a legitimate reset into a retry-budget failure.
const MAX_QUOTA_PAUSE_MS: i64 = 32 * 24 * 60 * 60 * 1_000;

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
    pub duration_ms: u32,
    /// SHA-256 of the FLAC body the pump will send, so the server can reject a
    /// mismatched pair rather than storing audio that does not match the label.
    pub audio_sha256: String,
    pub sample_rate_hz: u32,
    pub channels: u8,
    pub language: String,
    pub provider: String,
    pub provider_model: String,
    pub raw_transcript: String,
    pub inserted_text: String,
    pub final_text: String,
    pub training_text: String,
    pub edits: Vec<super::record::EditOp>,
    pub label_source: String,
    pub label_quality: String,
    pub normalization_version: u32,
    pub consent_version: u32,
}

/// Marks a settled trace as queued, if it is allowed to be.
///
/// Called from `settle()` at the moment a trace reaches `Finalized`, so there is
/// exactly one place a trace can enter the queue and no path that could queue an
/// unsettled one.
pub fn mark_eligible(record: &mut TraceRecord, settings: &TraceSettings) {
    if !settings.shares()
        || !record.is_shareable()
        || record.consent_version != Some(settings.consent_version)
    {
        return;
    }
    if record.share_state != ShareState::Ineligible {
        return;
    }
    record.share_state = ShareState::Pending;
    record.share_attempts = 0;
    record.share_next_attempt_ms = 0;
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
pub fn claim(
    app: &AppHandle,
    settings: &TraceSettings,
    owner_uid: &str,
) -> Result<Option<TraceUploadLease>, String> {
    if !settings.shares() || !valid_owner_uid(owner_uid) {
        return Ok(None);
    }
    let now = store::now_ms();

    // The record is read here, but the FLAC body is produced separately by
    // `audio_body` - the pump asks for it in a second call, so a large body
    // never rides through the lease payload.
    let record = store::claim_upload(app, owner_uid, now)?;

    let Some(record) = record else {
        return Ok(None);
    };
    // Encoding happens now rather than at capture so a trace the user deletes
    // before it is ever shared costs nothing.
    let Ok(wav) = store::read_audio(app, &record.trace_id) else {
        // The blob went while the record survived (retention, or a manual
        // wipe). Not retryable, and not an error worth surfacing.
        store::update_owned(app, &record.trace_id, owner_uid, |stored| {
            stored.share_state = ShareState::Ineligible;
            stored.has_audio = false;
        })?;
        return Ok(None);
    };
    let flac = super::flac::from_wav(&wav)?;
    let digest = sha256_hex(&flac);

    Ok(Some(TraceUploadLease {
        trace_id: record.trace_id.clone(),
        schema_version: 2,
        recorded_at_ms: record.recorded_at_ms,
        duration_ms: record.audio_ms,
        audio_sha256: digest,
        sample_rate_hz: 16_000,
        channels: 1,
        language: "en-US".to_string(),
        provider: "deepgram".to_string(),
        provider_model: record.model_id.clone(),
        raw_transcript: record.raw_transcript.clone(),
        inserted_text: record.inserted_text.clone(),
        final_text: record
            .final_text
            .clone()
            .unwrap_or_else(|| record.inserted_text.clone()),
        training_text: record.training_text().to_string(),
        edits: record.edits.clone(),
        label_source: "observed_field".to_string(),
        // Only a Finalized trace reaches this point, so the field really was
        // observed. What varies is how much the user's own text proves.
        label_quality: record.label_quality().as_wire().to_string(),
        normalization_version: 1,
        consent_version: settings.consent_version,
    }))
}

/// The FLAC body for a claimed trace. Re-encoded rather than cached, because
/// caching it would double the disk cost of every shared utterance for the sake
/// of one request.
pub fn audio_body(app: &AppHandle, trace_id: &str, owner_uid: &str) -> Result<Vec<u8>, String> {
    if !valid_owner_uid(owner_uid) || !store::upload_owner_matches(app, trace_id, owner_uid)? {
        return Err("trace upload owner mismatch".to_string());
    }
    let wav = store::read_audio(app, trace_id)?;
    super::flac::from_wav(&wav)
}

/// The server has both halves.
pub fn resolve(app: &AppHandle, trace_id: &str, owner_uid: &str) -> Result<(), String> {
    store::update_owned(app, trace_id, owner_uid, |record| {
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
pub fn fail(
    app: &AppHandle,
    trace_id: &str,
    owner_uid: &str,
    retryable: bool,
) -> Result<(), String> {
    let now = store::now_ms();
    store::update_owned(app, trace_id, owner_uid, |record| {
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

/// Persists one account's monthly quota reset without touching any trace's
/// attempt count. Invalid, expired, or implausibly distant values return false
/// so JavaScript can use the ordinary bounded retry path instead.
pub fn pause_for_quota(
    app: &AppHandle,
    owner_uid: &str,
    blocked_until_ms: i64,
) -> Result<bool, String> {
    if !valid_owner_uid(owner_uid) {
        return Ok(false);
    }
    let now = store::now_ms();
    if blocked_until_ms <= now || blocked_until_ms > now.saturating_add(MAX_QUOTA_PAUSE_MS) {
        return Ok(false);
    }
    store::pause_uploads(app, owner_uid, blocked_until_ms)?;
    Ok(true)
}

fn valid_owner_uid(owner_uid: &str) -> bool {
    !owner_uid.trim().is_empty() && owner_uid.len() <= 128
}

/// Lowercase hex SHA-256, matching what the backend contract expects in
/// `X-Audio-Sha256`.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}
