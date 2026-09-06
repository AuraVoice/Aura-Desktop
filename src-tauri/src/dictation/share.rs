//! The sharing queue: which recorded dictations may be uploaded, when, and what
//! happens when the server says no.
//!
//! Rust owns the queue; JavaScript performs the HTTP. That split is not
//! arbitrary - the Firebase ID token lives in the JS SDK, which is exactly why
//! meeting segments upload the same way (`useMeetingCapture.ts` claims a lease,
//! calls `authFetch`, then resolves it). Keeping the state machine here means a
//! crash mid-request resumes correctly instead of losing the job.
//!
//! This is the retired `dictation/trace/upload.rs` state machine, rebuilt on the
//! history store rather than the trace store's own JSON index: the history row
//! already IS the record being shared, and keeping a second copy of every
//! dictation in sync is what made the old subsystem worth deleting. The rules it
//! encodes are unchanged:
//!
//! 1. **Backoff is wall-clock and persisted.** An in-memory `Instant` would
//!    reset every launch and turn a server outage into a hot loop.
//! 2. **A refusal is never shown to the user.** Sharing is a background
//!    courtesy; a server that is down is not the user's problem to action.
//! 3. **Consent is checked before a claim, never at the call site.** The backend
//!    has no consent gate of its own - it trusts the `consentVersion` this
//!    client asserts - so this module is the only thing standing between a
//!    withdrawn opt-in and an upload.

use log::{info, warn};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::history;
use super::keystore::load_or_create_key;
use crate::crypto::decrypt_with_aad;
use crate::sealed_store::unseal;
use crate::util::now_ms;

/// Attempts before a dictation is abandoned. The row stays on disk and stays
/// exportable by hand; only the automatic retry stops.
const MAX_SHARE_ATTEMPTS: i64 = 8;

/// Wall-clock backoff per attempt, in seconds. The long tail is what keeps a
/// prolonged outage cheap: by the fourth failure a client is asking twice an
/// hour, and by the sixth, twice a day.
const BACKOFF_SECONDS: [i64; 8] = [30, 60, 300, 1_800, 7_200, 21_600, 43_200, 86_400];

/// A monthly reset can be at most one long month away. A little headroom keeps
/// clock skew from turning a legitimate reset into a retry-budget failure.
const MAX_QUOTA_PAUSE_MS: i64 = 32 * 24 * 60 * 60 * 1_000;

/// Server-side limits, mirrored from the backend's services/dictation/fields.py.
/// Checked here so an oversized row is dropped once rather than 422-ing forever.
const MAX_TEXT_CHARS: usize = 32_000;
const MAX_DURATION_MS: i64 = 120_000;
const MAX_AUDIO_BYTES: i64 = 8 * 1024 * 1024;

/// FROZEN. Changing this re-derives every trace id and would orphan every
/// already-uploaded row behind a permanent server-side tombstone.
const SHARE_ID_NAMESPACE: &str = "aura-dictation-share-v1";

const STATE_INELIGIBLE: i64 = 0;
const STATE_PENDING: i64 = 1;
const STATE_UPLOADED: i64 = 2;
const STATE_FAILED: i64 = 3;

/// Everything the JS pump needs to upload one dictation, in the exact shape the
/// backend expects as its metadata body. Serialized straight through to the
/// request, so this struct IS the wire format - changing a field name here
/// changes the API. Mirrors the backend's TracePayloadV2, which is
/// `strict=True, extra="forbid"`: every field must be present and typed exactly.
///
/// Deliberately NOT `Debug`, same discipline as `credential.rs`: it carries four
/// copies of the transcript (raw, inserted, final, training), so a single
/// `{:?}` in a log line or an error context would dump the user's speech into
/// the plaintext log. `Serialize` has to stay - it is the wire format - which is
/// exactly why `Debug` must not be there to be reached for by accident.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceUploadLease {
    pub trace_id: String,
    pub schema_version: u32,
    pub recorded_at_ms: i64,
    pub duration_ms: i64,
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
    /// Always empty. The backend requires the key (TracePayloadV2 is
    /// `extra="forbid"`) but the history store records the text before and
    /// after polish, not the operations between them, so there is nothing to
    /// put in it and no typed element worth declaring.
    pub edits: Vec<serde_json::Value>,
    pub label_source: String,
    pub label_quality: String,
    pub normalization_version: u32,
    pub consent_version: u32,
}

/// What the nightly pump needs to decide whether to do anything at all. The
/// caller already knows whether sharing is on - it passed that in - so echoing
/// it back would be a field nothing could learn from.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePumpState {
    pub pending_uploads: i64,
    pub pending_deletions: i64,
}

/// The id the server knows a row by.
///
/// A row imported from the retired trace store already carries the 24-hex id the
/// server would have seen, so it keeps it and a re-upload is idempotent rather
/// than duplicating. Everything else is derived deterministically, because
/// `history::new_id` produces 16 hex and the backend requires exactly 24. Being
/// derived rather than random means the id survives losing the column, and a
/// retry after a restart re-PUTs the same id instead of burning a second one out
/// of the monthly quota.
fn trace_id_for(uid: &str, row_id: &str) -> String {
    let already_server_shaped = row_id.len() == 24
        && row_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte));
    if already_server_shaped {
        return row_id.to_string();
    }
    let mut hasher = Sha256::new();
    hasher.update(SHARE_ID_NAMESPACE.as_bytes());
    hasher.update([0]);
    hasher.update(uid.as_bytes());
    hasher.update([0]);
    hasher.update(row_id.as_bytes());
    format!("{:x}", hasher.finalize())[..24].to_string()
}

fn valid_uid(uid: &str) -> bool {
    !uid.trim().is_empty() && uid.len() <= 128
}

fn quota_blocked(conn: &Connection, uid: &str, now: i64) -> Result<bool, String> {
    let until: Option<i64> = conn
        .query_row(
            "SELECT blocked_until_ms FROM share_quota_pause WHERE uid = ?1",
            params![uid],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(until.is_some_and(|until| until > now))
}

/// Queues every stored dictation that is allowed to be shared.
///
/// Run when sharing is turned on, and again before each drain, so the backlog
/// the user just consented to is included rather than only future dictations.
/// Eligibility is deliberately narrow: audio must be present and within the
/// server's limits, because a row that would 422 is not worth a request and a
/// row with no clip cannot satisfy the digest its metadata promises.
pub fn enqueue_backlog(app: &AppHandle, uid: &str) -> Result<usize, String> {
    if !valid_uid(uid) {
        return Ok(0);
    }
    let conn = history::open(app)?;
    let queued = conn
        .execute(
            "UPDATE transcripts
                SET share_state = ?1, share_attempts = 0, share_next_attempt_ms = 0
              WHERE uid = ?2
                AND share_state = 0
                AND shareable = 1
                AND audio_path IS NOT NULL
                AND audio_bytes > 0
                AND audio_bytes <= ?3
                AND duration_ms > 0
                AND duration_ms <= ?4",
            params![STATE_PENDING, uid, MAX_AUDIO_BYTES, MAX_DURATION_MS],
        )
        .map_err(|e| e.to_string())?;
    if queued > 0 {
        info!("dictation.share: queued {queued} for upload");
    }
    Ok(queued)
}

/// Turning sharing off. Every row the server already holds becomes a deletion
/// obligation, and everything still queued simply leaves the queue.
///
/// The obligation outlives the transcript row on purpose: deleting locally must
/// not be the thing that strands a copy on the server.
pub fn revoke_all(app: &AppHandle, uid: &str) -> Result<usize, String> {
    if !valid_uid(uid) {
        return Ok(0);
    }
    let conn = history::open(app)?;
    let tombstoned = conn
        .execute(
            "INSERT OR IGNORE INTO share_deletions (uid, trace_id, requested_at_ms)
             SELECT uid, share_trace_id, ?1 FROM transcripts
              WHERE uid = ?2 AND share_state = ?3 AND share_trace_id IS NOT NULL",
            params![now_ms(), uid, STATE_UPLOADED],
        )
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE transcripts SET share_state = ?1 WHERE uid = ?2 AND share_state <> ?1",
        params![STATE_INELIGIBLE, uid],
    )
    .map_err(|e| e.to_string())?;
    info!("dictation.share: sharing off, {tombstoned} remote copies queued for deletion");
    Ok(tombstoned)
}

pub fn pump_state(app: &AppHandle, uid: &str, sharing: bool) -> Result<SharePumpState, String> {
    if !valid_uid(uid) {
        return Ok(SharePumpState::default());
    }
    let conn = history::open(app)?;
    let now = now_ms();
    // A failure here must not read as "nothing to do". It used to: both counts
    // fell back to 0 on error, so a broken database and a genuinely idle night
    // produced identical, permanently silent behaviour.
    let pending_uploads: i64 = if sharing && !quota_blocked(&conn, uid, now)? {
        conn.query_row(
            // share_state is a LITERAL here, not a parameter: SQLite resolves
            // partial-index usability at prepare time, so binding it makes
            // transcripts_share_queue unusable and this becomes a scan.
            "SELECT COUNT(*) FROM transcripts
              WHERE uid = ?1 AND share_state = 1 AND share_next_attempt_ms <= ?2",
            params![uid, now],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0)
    } else {
        0
    };
    let pending_deletions: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM share_deletions WHERE uid = ?1",
            params![uid],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    Ok(SharePumpState {
        pending_uploads,
        pending_deletions,
    })
}

/// The next dictation due for upload, or `None` when the queue is empty, every
/// entry is still waiting out a backoff, or the account is inside a quota pause.
/// `consent_version` is the version the user actually agreed to, read from the
/// frontend settings store and passed in. It is deliberately NOT a constant
/// here: the payload asserts to the backend which consent this upload was made
/// under, and a constant compiled into Rust could disagree with the record the
/// user's choice was written against. If it ever disagrees with what the
/// backend accepts, that is a 422 rather than a quiet lie.
///
/// Skips past rows that cannot be uploaded rather than returning `None` for
/// them. Returning `None` is indistinguishable from "the queue is empty", and
/// the caller stops the drain on that - so one undecryptable row at the head of
/// the queue used to end the whole night, and N bad rows meant draining one row
/// per night forever, because the query orders oldest-first and hits them again
/// every time. A per-item problem must cost one item.
///
/// `retries_only` is what the hourly sweep passes: it claims rows that have
/// already been attempted and are now due, and leaves brand new traces for the
/// nightly window. That is what makes the sub-day steps of the backoff table
/// reachable at all without turning the whole thing into an hourly uploader.
pub fn claim(
    app: &AppHandle,
    uid: &str,
    consent_version: u32,
    retries_only: bool,
) -> Result<Option<TraceUploadLease>, String> {
    // Bounded so a pathological store cannot spin here. Anything skipped is
    // marked ineligible, so the bound is only ever reached once.
    const MAX_SKIPS: usize = 64;
    for _ in 0..MAX_SKIPS {
        match claim_one(app, uid, consent_version, retries_only)? {
            ClaimStep::Ready(lease) => return Ok(Some(*lease)),
            ClaimStep::Skipped => continue,
            ClaimStep::Empty => return Ok(None),
        }
    }
    warn!("dictation.share: claim skipped {MAX_SKIPS} unusable rows, giving up this pass");
    Ok(None)
}

enum ClaimStep {
    Ready(Box<TraceUploadLease>),
    /// This row cannot be uploaded and has been taken out of the queue. The
    /// queue itself may still have work.
    Skipped,
    Empty,
}

fn claim_one(
    app: &AppHandle,
    uid: &str,
    consent_version: u32,
    retries_only: bool,
) -> Result<ClaimStep, String> {
    if !valid_uid(uid) {
        return Ok(ClaimStep::Empty);
    }
    let conn = history::open(app)?;
    let now = now_ms();
    if quota_blocked(&conn, uid, now)? {
        return Ok(ClaimStep::Empty);
    }

    type ClaimRow = (String, i64, i64, Vec<u8>, Option<Vec<u8>>, String, Option<String>);
    let row: Option<ClaimRow> = conn
        .query_row(
            // Literal share_state, same reason as pump_state above. Also selects
            // the persisted digest rather than recomputing it, which is what
            // used to force a full read and decrypt of the clip on every claim.
            "SELECT id, recorded_at_ms, duration_ms, text, raw_text, audio_path, audio_sha256
               FROM transcripts
              WHERE uid = ?1 AND share_state = 1 AND share_next_attempt_ms <= ?2
                AND audio_path IS NOT NULL
                AND (?3 = 0 OR share_attempts > 0)
              ORDER BY recorded_at_ms ASC
              LIMIT 1",
            params![uid, now, i64::from(retries_only)],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((id, recorded_at_ms, duration_ms, sealed_text, sealed_raw, relative, digest)) = row
    else {
        return Ok(ClaimStep::Empty);
    };

    let key = load_or_create_key(app)?;
    let text = unseal(&key, &sealed_text, &history::row_aad(uid, &id, "text")).ok();
    let Some(text) = text else {
        // A row that will not decrypt is skipped, never fatal - the rule the
        // rest of this store follows. It leaves the queue so it cannot block
        // everything behind it forever.
        mark_ineligible(&conn, uid, &id)?;
        warn!("dictation.share: row skipped, transcript did not decrypt id={id}");
        return Ok(ClaimStep::Skipped);
    };

    // The pre-polish transcript, stored only when polish changed the text.
    // Absent means the final text IS the raw, which is what unchanged_silver
    // records.
    let raw_text = sealed_raw
        .and_then(|sealed| unseal(&key, &sealed, &history::row_aad(uid, &id, "raw")).ok());

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_TEXT_CHARS {
        mark_ineligible(&conn, uid, &id)?;
        warn!("dictation.share: row skipped, transcript empty or oversized id={id}");
        return Ok(ClaimStep::Skipped);
    }
    let raw_transcript = raw_text
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty() && raw.chars().count() <= MAX_TEXT_CHARS)
        .unwrap_or(&trimmed)
        .to_string();

    // The digest was taken when the clip was written and stored on the row. It
    // is a property of bytes that never change, so computing it here meant
    // reading and decrypting the whole clip on every claim AND again on every
    // one of up to eight retries - sixteen decrypts of the same file for a row
    // that ultimately fails. The clip itself is read once, later, by audio_body.
    let Some(audio_sha256) = digest.filter(|d| d.len() == 64) else {
        // Written before the digest column existed, or the clip failed to save.
        // Either way this row can never satisfy the digest its metadata would
        // promise, so it leaves the queue rather than failing eight times.
        mark_ineligible(&conn, uid, &id)?;
        warn!("dictation.share: row skipped, no stored audio digest id={id}");
        return Ok(ClaimStep::Skipped);
    };
    // Cheap existence check so a claim does not hand out a lease for a clip that
    // is already gone. One stat, not a read and a decrypt.
    if !history::clip_path(app, &relative)?.exists() {
        mark_ineligible(&conn, uid, &id)?;
        warn!("dictation.share: row skipped, clip file is gone id={id}");
        return Ok(ClaimStep::Skipped);
    }

    let trace_id = trace_id_for(uid, &id);
    conn.execute(
        "UPDATE transcripts SET share_trace_id = ?1 WHERE uid = ?2 AND id = ?3",
        params![trace_id, uid, id],
    )
    .map_err(|e| e.to_string())?;

    let label_quality = if raw_transcript == trimmed {
        "unchanged_silver"
    } else {
        "corrected_silver"
    };

    Ok(ClaimStep::Ready(Box::new(TraceUploadLease {
        trace_id,
        schema_version: 2,
        recorded_at_ms,
        duration_ms,
        audio_sha256,
        sample_rate_hz: 16_000,
        channels: 1,
        language: "en-US".to_string(),
        provider: "deepgram".to_string(),
        provider_model: PROVIDER_MODEL.to_string(),
        raw_transcript,
        inserted_text: trimmed.clone(),
        final_text: trimmed.clone(),
        training_text: trimmed,
        edits: Vec::new(),
        label_source: "observed_field".to_string(),
        label_quality: label_quality.to_string(),
        normalization_version: 1,
        consent_version,
    })))
}

/// What produced the transcripts this store holds. The history row does not
/// record the model, so this is the one place the value is stated; it must
/// change whenever the dictation ASR model does, or the corpus mislabels itself.
const PROVIDER_MODEL: &str = "nova-3";

fn mark_ineligible(conn: &Connection, uid: &str, id: &str) -> Result<(), String> {
    conn.execute(
        "UPDATE transcripts SET share_state = ?1 WHERE uid = ?2 AND id = ?3",
        params![STATE_INELIGIBLE, uid, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The FLAC body for a claimed dictation, decrypted. Read rather than cached,
/// because caching it would double the disk cost of every shared utterance for
/// the sake of one request.
pub fn audio_body(app: &AppHandle, uid: &str, trace_id: &str) -> Result<Vec<u8>, String> {
    if !valid_uid(uid) {
        return Err("dictation share: invalid account".to_string());
    }
    let conn = history::open(app)?;
    let row: Option<(String, String)> = conn
        .query_row(
            "SELECT id, audio_path FROM transcripts
              WHERE uid = ?1 AND share_trace_id = ?2 AND audio_path IS NOT NULL",
            params![uid, trace_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    let Some((id, relative)) = row else {
        return Err("dictation share: unknown trace".to_string());
    };
    let key = load_or_create_key(app)?;
    let sealed =
        std::fs::read(history::clip_path(app, &relative)?).map_err(|e| e.to_string())?;
    decrypt_with_aad(
        &key,
        &sealed,
        history::row_aad(uid, &id, "audio").as_bytes(),
    )
    .map_err(|e| e.to_string())
}

/// The server has both halves.
///
/// Checks rows-affected: an UPDATE that matches nothing used to report success,
/// which left the row PENDING to be uploaded again the next night and burn a
/// second slot of the monthly quota for a trace the server already had.
pub fn resolve(app: &AppHandle, uid: &str, trace_id: &str) -> Result<(), String> {
    let conn = history::open(app)?;
    let updated = conn
        .execute(
            "UPDATE transcripts
                SET share_state = ?1, shared_at_ms = ?2, share_next_attempt_ms = 0
              WHERE uid = ?3 AND share_trace_id = ?4",
            params![STATE_UPLOADED, now_ms(), uid, trace_id],
        )
        .map_err(|e| e.to_string())?;
    if updated == 0 {
        warn!("dictation.share: resolve matched no row trace={trace_id}");
        return Err("dictation share: resolve matched no row".to_string());
    }
    Ok(())
}

/// The attempt failed. `retryable` is false for the answers that will never
/// succeed on their own - a rejected payload, a digest conflict - and true for
/// everything transient.
pub fn fail(app: &AppHandle, uid: &str, trace_id: &str, retryable: bool) -> Result<(), String> {
    let conn = history::open(app)?;
    // A missing row is NOT "zero attempts so far". Reading it that way reset the
    // counter to 1, updated nothing, and then logged attempts=1 as if the retry
    // budget were intact.
    let previous: Option<i64> = conn
        .query_row(
            "SELECT share_attempts FROM transcripts WHERE uid = ?1 AND share_trace_id = ?2",
            params![uid, trace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(previous) = previous else {
        warn!("dictation.share: fail for a row that is gone trace={trace_id}");
        return Ok(());
    };
    let attempts = previous.max(0).saturating_add(1);
    if !retryable || attempts >= MAX_SHARE_ATTEMPTS {
        conn.execute(
            "UPDATE transcripts SET share_state = ?1, share_attempts = ?2
              WHERE uid = ?3 AND share_trace_id = ?4",
            params![STATE_FAILED, attempts, uid, trace_id],
        )
        .map_err(|e| e.to_string())?;
    } else {
        let index = (attempts as usize - 1).min(BACKOFF_SECONDS.len() - 1);
        let next = now_ms() + jitter(BACKOFF_SECONDS[index] * 1_000);
        conn.execute(
            "UPDATE transcripts SET share_attempts = ?1, share_next_attempt_ms = ?2
              WHERE uid = ?3 AND share_trace_id = ?4",
            params![attempts, next, uid, trace_id],
        )
        .map_err(|e| e.to_string())?;
    }
    warn!("dictation.share: attempt failed trace={trace_id} retryable={retryable} attempts={attempts}");
    Ok(())
}

/// Spreads retries by +/-20%. Without it every install that failed in the same
/// outage comes back in lockstep and the recovery is what falls over.
fn jitter(base_ms: i64) -> i64 {
    let spread = base_ms / 5;
    if spread == 0 {
        return base_ms;
    }
    let mut bytes = [0u8; 2];
    if getrandom::fill(&mut bytes).is_err() {
        return base_ms;
    }
    let offset = (u16::from_le_bytes(bytes) as i64) % (spread * 2 + 1) - spread;
    (base_ms + offset).max(1_000)
}

/// Persists one account's monthly quota reset without touching any attempt
/// count. Invalid, expired, or implausibly distant values return false so the
/// pump uses the ordinary bounded retry path instead.
pub fn pause_for_quota(app: &AppHandle, uid: &str, blocked_until_ms: i64) -> Result<bool, String> {
    if !valid_uid(uid) {
        return Ok(false);
    }
    let now = now_ms();
    if blocked_until_ms <= now || blocked_until_ms > now.saturating_add(MAX_QUOTA_PAUSE_MS) {
        return Ok(false);
    }
    let conn = history::open(app)?;
    conn.execute(
        "INSERT INTO share_quota_pause (uid, blocked_until_ms) VALUES (?1, ?2)
         ON CONFLICT(uid) DO UPDATE SET blocked_until_ms = excluded.blocked_until_ms",
        params![uid, blocked_until_ms],
    )
    .map_err(|e| e.to_string())?;
    info!("dictation.share: uploads paused for quota");
    Ok(true)
}

/// What one drain did. Persisted so the answer survives the 200-line log tail.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainOutcome {
    pub uploaded: i64,
    pub failed_terminal: i64,
    pub failed_retryable: i64,
    pub skipped: i64,
    pub deleted: i64,
    pub duration_ms: i64,
    /// A short reason code, never a message and never any content.
    pub last_error_reason: Option<String>,
}

/// Cumulative counters plus the last drain, for the Dictation page.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStats {
    pub uploaded: i64,
    pub failed_terminal: i64,
    pub failed_retryable: i64,
    pub skipped: i64,
    pub deleted: i64,
    pub last_drain_at_ms: i64,
    pub last_drain_ms: i64,
    pub last_error_reason: Option<String>,
    pub pending_uploads: i64,
    pub pending_deletions: i64,
}

/// Folds one drain into the running totals.
pub fn record_drain(app: &AppHandle, uid: &str, outcome: &DrainOutcome) -> Result<(), String> {
    if !valid_uid(uid) {
        return Ok(());
    }
    let conn = history::open(app)?;
    conn.execute(
        "INSERT INTO share_stats (
            uid, uploaded, failed_terminal, failed_retryable, skipped, deleted,
            last_drain_at_ms, last_drain_ms, last_error_reason
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(uid) DO UPDATE SET
            uploaded = uploaded + excluded.uploaded,
            failed_terminal = failed_terminal + excluded.failed_terminal,
            failed_retryable = failed_retryable + excluded.failed_retryable,
            skipped = skipped + excluded.skipped,
            deleted = deleted + excluded.deleted,
            last_drain_at_ms = excluded.last_drain_at_ms,
            last_drain_ms = excluded.last_drain_ms,
            last_error_reason = excluded.last_error_reason",
        params![
            uid,
            outcome.uploaded,
            outcome.failed_terminal,
            outcome.failed_retryable,
            outcome.skipped,
            outcome.deleted,
            now_ms(),
            outcome.duration_ms,
            outcome.last_error_reason,
        ],
    )
    .map_err(|e| e.to_string())?;
    // One line per drain, not one per trace: the readable log tail is 200 lines,
    // so a line per upload would evict everything else that happened that day.
    info!(
        "dictation.share: drain uploaded={} skipped={} failed_terminal={}          failed_retryable={} deleted={} duration_ms={} reason={}",
        outcome.uploaded,
        outcome.skipped,
        outcome.failed_terminal,
        outcome.failed_retryable,
        outcome.deleted,
        outcome.duration_ms,
        outcome.last_error_reason.as_deref().unwrap_or("none"),
    );
    Ok(())
}

pub fn stats(app: &AppHandle, uid: &str) -> Result<ShareStats, String> {
    if !valid_uid(uid) {
        return Ok(ShareStats::default());
    }
    let conn = history::open(app)?;
    let mut out: ShareStats = conn
        .query_row(
            "SELECT uploaded, failed_terminal, failed_retryable, skipped, deleted,
                    last_drain_at_ms, last_drain_ms, last_error_reason
               FROM share_stats WHERE uid = ?1",
            params![uid],
            |row| {
                Ok(ShareStats {
                    uploaded: row.get(0)?,
                    failed_terminal: row.get(1)?,
                    failed_retryable: row.get(2)?,
                    skipped: row.get(3)?,
                    deleted: row.get(4)?,
                    last_drain_at_ms: row.get(5)?,
                    last_drain_ms: row.get(6)?,
                    last_error_reason: row.get(7)?,
                    pending_uploads: 0,
                    pending_deletions: 0,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .unwrap_or_default();
    let live = pump_state(app, uid, true)?;
    out.pending_uploads = live.pending_uploads;
    out.pending_deletions = live.pending_deletions;
    Ok(out)
}

/// The next remote copy owed a deletion and actually due, if any.
pub fn claim_deletion(app: &AppHandle, uid: &str) -> Result<Option<String>, String> {
    if !valid_uid(uid) {
        return Ok(None);
    }
    let conn = history::open(app)?;
    conn.query_row(
        "SELECT trace_id FROM share_deletions
          WHERE uid = ?1 AND next_attempt_ms <= ?2
          ORDER BY requested_at_ms ASC LIMIT 1",
        params![uid, now_ms()],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// A deletion attempt failed. Same shape as `fail`: bounded attempts and a
/// persisted wall-clock backoff. The row stays, because the obligation to
/// remove a copy the user withdrew consent for does not expire.
pub fn fail_deletion(app: &AppHandle, uid: &str, trace_id: &str) -> Result<(), String> {
    let conn = history::open(app)?;
    let previous: Option<i64> = conn
        .query_row(
            "SELECT attempts FROM share_deletions WHERE uid = ?1 AND trace_id = ?2",
            params![uid, trace_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(previous) = previous else {
        return Ok(());
    };
    let attempts = previous.max(0).saturating_add(1);
    let index = (attempts as usize)
        .saturating_sub(1)
        .min(BACKOFF_SECONDS.len() - 1);
    let next = now_ms() + jitter(BACKOFF_SECONDS[index] * 1_000);
    conn.execute(
        "UPDATE share_deletions SET attempts = ?1, next_attempt_ms = ?2
          WHERE uid = ?3 AND trace_id = ?4",
        params![attempts, next, uid, trace_id],
    )
    .map_err(|e| e.to_string())?;
    warn!("dictation.share: deletion failed trace={trace_id} attempts={attempts}");
    Ok(())
}

pub fn resolve_deletion(app: &AppHandle, uid: &str, trace_id: &str) -> Result<(), String> {
    let conn = history::open(app)?;
    let removed = conn
        .execute(
            "DELETE FROM share_deletions WHERE uid = ?1 AND trace_id = ?2",
            params![uid, trace_id],
        )
        .map_err(|e| e.to_string())?;
    if removed == 0 {
        // Not fatal: the obligation is discharged either way. But it means the
        // pump and the store disagree about what is owed, which is worth seeing.
        warn!("dictation.share: deletion resolve matched no row trace={trace_id}");
    }
    Ok(())
}

// ---------------------------------------------------------------- commands
//
// Every command is `async` (CLAUDE.md, "Main-thread blocking") and pushes its
// SQLite and crypto work onto the blocking pool: a claim decrypts a transcript
// and a whole FLAC clip, which is not work for the thread pumping the window's
// messages.

/// Whether sharing is authorized right now is passed in from React rather than
/// read here, because the consent record lives in the frontend settings store.
/// `generalSettings.dictationSharingActive` is the single place that decides
/// it, version check included.
#[tauri::command]
pub async fn dictation_share_pump_state(
    app: AppHandle,
    uid: String,
    sharing: bool,
) -> Result<SharePumpState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if sharing {
            // Cheap and idempotent: an already-queued row is not re-queued, so
            // this is what folds a newly-eligible backlog in without needing a
            // separate "sharing was just switched on" signal.
            //
            // Its failure used to be discarded, and it is the ONLY call on the
            // drain path: if it fails nothing is queued, so the pump reports an
            // empty queue forever with nothing anywhere saying why.
            if let Err(error) = enqueue_backlog(&app, &uid) {
                warn!("dictation.share: could not queue the backlog ({error})");
            }
        }
        pump_state(&app, &uid, sharing)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_claim_trace_upload(
    app: AppHandle,
    uid: String,
    consent_version: u32,
    retries_only: bool,
) -> Result<Option<TraceUploadLease>, String> {
    tauri::async_runtime::spawn_blocking(move || claim(&app, &uid, consent_version, retries_only))
        .await
        .map_err(|e| e.to_string())?
}

/// The FLAC body, raw over IPC so there is no base64 round trip, matching
/// `dictation_history_audio`.
#[tauri::command]
pub async fn dictation_trace_upload_audio(
    app: AppHandle,
    uid: String,
    trace_id: String,
) -> Result<tauri::ipc::Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        audio_body(&app, &uid, &trace_id).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_resolve_trace_upload(
    app: AppHandle,
    uid: String,
    trace_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || resolve(&app, &uid, &trace_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_fail_trace_upload(
    app: AppHandle,
    uid: String,
    trace_id: String,
    retryable: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || fail(&app, &uid, &trace_id, retryable))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_pause_trace_uploads(
    app: AppHandle,
    uid: String,
    blocked_until_ms: i64,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || pause_for_quota(&app, &uid, blocked_until_ms))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_claim_trace_deletion(
    app: AppHandle,
    uid: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || claim_deletion(&app, &uid))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_record_share_drain(
    app: AppHandle,
    uid: String,
    outcome: DrainOutcome,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || record_drain(&app, &uid, &outcome))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_share_stats(app: AppHandle, uid: String) -> Result<ShareStats, String> {
    tauri::async_runtime::spawn_blocking(move || stats(&app, &uid))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_fail_trace_deletion(
    app: AppHandle,
    uid: String,
    trace_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || fail_deletion(&app, &uid, &trace_id))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_resolve_trace_deletion(
    app: AppHandle,
    uid: String,
    trace_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || resolve_deletion(&app, &uid, &trace_id))
        .await
        .map_err(|e| e.to_string())?
}

/// Turning sharing off. Queues a server-side delete for everything already
/// uploaded and empties the queue: withdrawal has to remove what was sent, not
/// merely stop sending more.
#[tauri::command]
pub async fn dictation_revoke_trace_sharing(app: AppHandle, uid: String) -> Result<usize, String> {
    tauri::async_runtime::spawn_blocking(move || revoke_all(&app, &uid))
        .await
        .map_err(|e| e.to_string())?
}
