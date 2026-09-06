import { invoke } from "@tauri-apps/api/core";
import { authFetch, AuthRequiredError } from "./api";
import { auth } from "./firebase";
import { IMPROVEMENT_CONSENT_VERSION } from "./generalSettings";

/**
 * The transport half of dictation sharing.
 *
 * Rust owns the queue and the retry state; this module only performs the HTTP,
 * because the Firebase ID token lives in the JS SDK. Meeting segments upload
 * exactly the same way (`useMeetingCapture.ts` claims a lease, calls
 * `authFetch`, resolves it), and this follows that split rather than inventing
 * a second one.
 */

/** Exactly the metadata body the backend expects. Mirrors Rust's
 * `TraceUploadLease`, which is serialized straight into the request, and the
 * backend's `TracePayloadV2`, which is strict and forbids extra keys. */
interface TraceUploadLease {
  traceId: string;
  schemaVersion: number;
  recordedAtMs: number;
  durationMs: number;
  audioSha256: string;
  sampleRateHz: number;
  channels: number;
  language: string;
  provider: string;
  providerModel: string;
  rawTranscript: string;
  insertedText: string;
  finalText: string;
  trainingText: string;
  /** Always empty. Required by the backend, which forbids both extra and
   * missing keys, but nothing records edit operations. */
  edits: never[];
  labelSource: "observed_field";
  /** The only two labels a client can produce. "human_gold" is reviewer-only,
   * written server-side, so no client can assert its own data is gold. */
  labelQuality: "unchanged_silver" | "corrected_silver";
  normalizationVersion: number;
  consentVersion: number;
}

interface SharePumpState {
  pendingUploads: number;
  pendingDeletions: number;
}

/** A failed attempt, already classified into "try again later" vs "never". */
class TraceUploadError extends Error {
  retryable: boolean;
  quotaResetAtMs: number | null;
  /** The account is gone or changed. Systemic, and not attributable to the row
   * being uploaded, so it must never consume that row's retry budget. */
  signedOut: boolean;

  constructor(
    message: string,
    retryable: boolean,
    quotaResetAtMs: number | null = null,
    signedOut = false,
  ) {
    super(message);
    this.retryable = retryable;
    this.quotaResetAtMs = quotaResetAtMs;
    this.signedOut = signedOut;
  }
}

/**
 * Decides whether an attempt is worth repeating.
 *
 * 409 is terminal on purpose: it means the server already holds this trace id
 * with a different fingerprint, or the id was tombstoned by a deletion. Neither
 * can be fixed by re-sending, and the id is burned permanently either way.
 * 422 is terminal because the payload itself was rejected.
 */
function classifyStatus(status: number): TraceUploadError {
  if (status === 409) {
    return new TraceUploadError(`Trace conflict (${status})`, false);
  }
  if (status === 413 || status === 400 || status === 422) {
    return new TraceUploadError(`Trace rejected (${status})`, false);
  }
  // 404 (metadata not yet accepted), malformed 429, and 5xx all wait.
  return new TraceUploadError(`Upload failed (${status})`, true);
}

async function classifyResponse(response: Response): Promise<TraceUploadError> {
  if (response.status === 429) {
    try {
      const body = (await response.json()) as { resetsAtMs?: unknown };
      if (typeof body.resetsAtMs === "number" && Number.isFinite(body.resetsAtMs)) {
        return new TraceUploadError("Monthly upload quota reached", true, body.resetsAtMs);
      }
    } catch {
      // Missing or malformed quota data uses the normal bounded retry path.
    }
  }
  return classifyStatus(response.status);
}

function authFetchForUid(ownerUid: string, path: string, init?: RequestInit): Promise<Response> {
  // The account can change between claiming a lease and sending it. Uploading
  // one account's dictation under another's token would be the worst possible
  // outcome of a race that is otherwise harmless.
  if (auth.currentUser?.uid !== ownerUid) {
    return Promise.reject(new AuthRequiredError("Signed-in account changed"));
  }
  return authFetch(path, init);
}

/** Anything thrown that is not an HTTP status: offline, DNS, TLS, aborted. */
export function classifyUploadFailure(error: unknown): TraceUploadError {
  if (error instanceof TraceUploadError) return error;
  // A missing session is not a queue failure. The pump stops entirely rather
  // than burning an attempt on every queued dictation.
  if (error instanceof AuthRequiredError) {
    return new TraceUploadError("Not signed in", true, null, true);
  }
  return new TraceUploadError(
    error instanceof Error ? error.message : "Network unavailable",
    true,
  );
}

/** Step 1: the metadata. Creates the record server-side and consumes quota. */
async function putMetadata(lease: TraceUploadLease, ownerUid: string): Promise<void> {
  const response = await authFetchForUid(ownerUid, `/dictation/traces/${lease.traceId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lease),
  });
  if (!response.ok) throw await classifyResponse(response);
}

/** Step 2: the audio. Split from the metadata so an `edits[]` array never has
 * to be squeezed into an HTTP header, and so a text-only tier stays possible
 * later by simply skipping this call. */
async function putAudio(
  traceId: string,
  ownerUid: string,
  digest: string,
  bytes: Uint8Array,
): Promise<void> {
  const response = await authFetchForUid(ownerUid, `/dictation/traces/${traceId}/audio`, {
    method: "PUT",
    headers: {
      "Content-Type": "audio/flac",
      "X-Audio-Sha256": digest,
    },
    body: new Uint8Array(bytes).buffer as ArrayBuffer,
  });
  if (!response.ok) throw await classifyResponse(response);
}

/**
 * Uploads one claimed dictation, metadata then audio.
 *
 * Ordered that way so a half-completed upload leaves a record with no audio
 * rather than audio with no label. The retry re-`PUT`s both under the same
 * trace id, and the server treats a byte-identical body as idempotent without
 * consuming a second slot of the monthly quota.
 */
export async function uploadTrace(lease: TraceUploadLease, ownerUid: string): Promise<void> {
  await putMetadata(lease, ownerUid);
  const raw = await invoke<ArrayBuffer>("dictation_trace_upload_audio", {
    uid: ownerUid,
    traceId: lease.traceId,
  });
  await putAudio(lease.traceId, ownerUid, lease.audioSha256, new Uint8Array(raw));
}

/** Deletes the server's copy of a dictation the user withdrew or removed. */
export async function deleteRemoteTrace(traceId: string, ownerUid: string): Promise<void> {
  const response = await authFetchForUid(ownerUid, `/dictation/traces/${traceId}`, {
    method: "DELETE",
  });
  // A 404 means the server never had it, or already dropped it. Either way the
  // obligation is discharged, so this is a success, not a retry.
  if (!response.ok && response.status !== 404) {
    throw classifyStatus(response.status);
  }
}

export function sharePumpState(uid: string, sharing: boolean): Promise<SharePumpState> {
  return invoke<SharePumpState>("dictation_share_pump_state", { uid, sharing });
}

export function claimTraceUpload(uid: string): Promise<TraceUploadLease | null> {
  // The asserted consent version is the one the settings store records, so the
  // payload cannot claim a consent the user did not give.
  return invoke<TraceUploadLease | null>("dictation_claim_trace_upload", {
    uid,
    consentVersion: IMPROVEMENT_CONSENT_VERSION,
  });
}

export function resolveTraceUpload(uid: string, traceId: string): Promise<void> {
  return invoke("dictation_resolve_trace_upload", { uid, traceId });
}

export function failTraceUpload(
  uid: string,
  traceId: string,
  retryable: boolean,
): Promise<void> {
  return invoke("dictation_fail_trace_upload", { uid, traceId, retryable });
}

export function claimTraceDeletion(uid: string): Promise<string | null> {
  return invoke<string | null>("dictation_claim_trace_deletion", { uid });
}

export function resolveTraceDeletion(uid: string, traceId: string): Promise<void> {
  return invoke("dictation_resolve_trace_deletion", { uid, traceId });
}

export function pauseTraceUploads(uid: string, blockedUntilMs: number): Promise<boolean> {
  return invoke<boolean>("dictation_pause_trace_uploads", { uid, blockedUntilMs });
}

/** Turning sharing off: queue a server-side delete for everything sent. */
export function revokeTraceSharing(uid: string): Promise<number> {
  return invoke<number>("dictation_revoke_trace_sharing", { uid });
}
