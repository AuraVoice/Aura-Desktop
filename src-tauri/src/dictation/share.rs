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
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::history;
use super::keystore::load_or_create_key;
use crate::crypto::decrypt_with_aad;
use crate::sealed_store::unseal;
use crate::util::{now_ms, sha256_hex};

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
#[derive(Clone, Debug, Serialize)]
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

fn quota_blocked(conn: &Connection, uid: &str, now: i64) -> bool {
    conn.query_row(
        "SELECT blocked_until_ms FROM share_quota_pause WHERE uid = ?1",
        params![uid],
        |row| row.get::<_, i64>(0),
    )
    .ok()
    .is_some_and(|until| until > now)
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
                AND share_state = ?3
                AND audio_path IS NOT NULL
                AND audio_bytes > 0
                AND audio_bytes <= ?4
                AND duration_ms > 0
                AND duration_ms <= ?5",
            params![
                STATE_PENDING,
                uid,
                STATE_INELIGIBLE,
                MAX_AUDIO_BYTES,
                MAX_DURATION_MS
            ],
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
    let pending_uploads: i64 = if sharing && !quota_blocked(&conn, uid, now) {
        conn.query_row(
            "SELECT COUNT(*) FROM transcripts
              WHERE uid = ?1 AND share_state = ?2 AND share_next_attempt_ms <= ?3",
            params![uid, STATE_PENDING, now],
            |row| row.get(0),
        )
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
pub fn claim(
    app: &AppHandle,
    uid: &str,
    consent_version: u32,
) -> Result<Option<TraceUploadLease>, String> {
    if !valid_uid(uid) {
        return Ok(None);
    }
    let conn = history::open(app)?;
    let now = now_ms();
    if quota_blocked(&conn, uid, now) {
        return Ok(None);
    }

    type ClaimRow = (String, i64, i64, Vec<u8>, Option<Vec<u8>>, String);
    let row: Option<ClaimRow> = conn
        .query_row(
            "SELECT id, recorded_at_ms, duration_ms, text, raw_text, audio_path
               FROM transcripts
              WHERE uid = ?1 AND share_state = ?2 AND share_next_attempt_ms <= ?3
                AND audio_path IS NOT NULL
              ORDER BY recorded_at_ms ASC
              LIMIT 1",
            params![uid, STATE_PENDING, now],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .ok();
    let Some((id, recorded_at_ms, duration_ms, sealed_text, sealed_raw, relative)) = row else {
        return Ok(None);
    };

    let key = load_or_create_key(app)?;
    let text = unseal(&key, &sealed_text, &history::row_aad(uid, &id, "text")).ok();
    let Some(text) = text else {
        // A row that will not decrypt is skipped, never fatal - the rule the
        // rest of this store follows. It leaves the queue so it cannot block
        // everything behind it forever.
        mark_ineligible(&conn, uid, &id)?;
        warn!("dictation.share: row skipped, transcript did not decrypt");
        return Ok(None);
    };

    // The pre-polish transcript, stored only when polish changed the text.
    // Absent means the final text IS the raw, which is what unchanged_silver
    // records.
    let raw_text = sealed_raw
        .and_then(|sealed| unseal(&key, &sealed, &history::row_aad(uid, &id, "raw")).ok());

    let trimmed = text.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().count() > MAX_TEXT_CHARS {
        mark_ineligible(&conn, uid, &id)?;
        return Ok(None);
    }
    let raw_transcript = raw_text
        .as_deref()
        .map(str::trim)
        .filter(|raw| !raw.is_empty() && raw.chars().count() <= MAX_TEXT_CHARS)
        .unwrap_or(&trimmed)
        .to_string();

    // The clip is read now rather than cached, so a dictation deleted before it
    // is ever shared costs nothing.
    let path = history::clip_path(app, &relative)?;
    let Ok(sealed_clip) = std::fs::read(&path) else {
        // The clip went while the row survived (audio eviction, or a manual
        // wipe). Not retryable and not worth surfacing: the metadata promises a
        // digest this row can no longer produce.
        mark_ineligible(&conn, uid, &id)?;
        return Ok(None);
    };
    let Ok(flac) = decrypt_with_aad(
        &key,
        &sealed_clip,
        history::row_aad(uid, &id, "audio").as_bytes(),
    ) else {
        mark_ineligible(&conn, uid, &id)?;
        warn!("dictation.share: row skipped, clip did not decrypt");
        return Ok(None);
    };

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

    Ok(Some(TraceUploadLease {
        trace_id,
        schema_version: 2,
        recorded_at_ms,
        duration_ms,
        audio_sha256: sha256_hex(&flac),
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
    }))
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
pub fn resolve(app: &AppHandle, uid: &str, trace_id: &str) -> Result<(), String> {
    let conn = history::open(app)?;
    conn.execute(
        "UPDATE transcripts
            SET share_state = ?1, shared_at_ms = ?2, share_next_attempt_ms = 0
          WHERE uid = ?3 AND share_trace_id = ?4",
        params![STATE_UPLOADED, now_ms(), uid, trace_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The attempt failed. `retryable` is false for the answers that will never
/// succeed on their own - a rejected payload, a digest conflict - and true for
/// everything transient.
pub fn fail(app: &AppHandle, uid: &str, trace_id: &str, retryable: bool) -> Result<(), String> {
    let conn = history::open(app)?;
    let attempts: i64 = conn
        .query_row(
            "SELECT share_attempts FROM transcripts WHERE uid = ?1 AND share_trace_id = ?2",
            params![uid, trace_id],
            |row| row.get(0),
        )
        .unwrap_or(0_i64)
        .saturating_add(1);
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
    info!("dictation.share: attempt failed retryable={retryable} attempts={attempts}");
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

/// The next remote copy owed a deletion, if any.
pub fn claim_deletion(app: &AppHandle, uid: &str) -> Result<Option<String>, String> {
    if !valid_uid(uid) {
        return Ok(None);
    }
    let conn = history::open(app)?;
    Ok(conn
        .query_row(
            "SELECT trace_id FROM share_deletions WHERE uid = ?1
              ORDER BY requested_at_ms ASC LIMIT 1",
            params![uid],
            |row| row.get(0),
        )
        .ok())
}

pub fn resolve_deletion(app: &AppHandle, uid: &str, trace_id: &str) -> Result<(), String> {
    let conn = history::open(app)?;
    conn.execute(
        "DELETE FROM share_deletions WHERE uid = ?1 AND trace_id = ?2",
        params![uid, trace_id],
    )
    .map_err(|e| e.to_string())?;
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
            let _ = enqueue_backlog(&app, &uid);
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
) -> Result<Option<TraceUploadLease>, String> {
    tauri::async_runtime::spawn_blocking(move || claim(&app, &uid, consent_version))
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
