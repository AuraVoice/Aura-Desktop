import { invoke } from "@tauri-apps/api/core";
import { authFetch, AuthRequiredError } from "./api";
import { auth } from "./firebase";
import type { EditOp } from "./dictationTraces";

/**
 * The transport half of dictation trace sharing.
 *
 * Rust owns the queue and the retry state; this module only performs the HTTP,
 * because the Firebase ID token lives in the JS SDK. Meeting segments upload
 * exactly the same way (`useMeetingCapture.ts` claims a lease, calls
 * `authFetch`, resolves it), and this follows that split rather than inventing
 * a second one.
 *
 * NOTE: none of these endpoints exist yet. Until the backend session ships
 * them, every call 404s, which `classifyUploadFailure` deliberately treats as
 * retryable-but-slow so the queue backs off to hours rather than spinning.
 */

/** Exactly the metadata body the backend contract expects. Mirrors Rust's
 * `TraceUploadLease`, which is serialized straight into the request. */
export interface TraceUploadLease {
  traceId: string;
  schemaVersion: number;
  recordedAtMs: number;
  modelId: string;
  sherpaVersion: string;
  appVersion: string;
  durationMs: number;
  audioSha256: string;
  audioBytes: number;
  asrText: string;
  insertedText: string;
  finalText: string | null;
  groundTruth: string | null;
  edits: EditOp[];
  locallyCorrected: boolean;
  observations: number;
  app: string;
  fieldRole: string;
  consentVersion: number;
}

export interface SharePumpState {
  sharing: boolean;
  pendingUploads: number;
  pendingDeletions: number;
}

/** A failed attempt, already classified into "try again later" vs "never". */
export class TraceUploadError extends Error {
  retryable: boolean;
  quotaResetAtMs: number | null;

  constructor(message: string, retryable: boolean, quotaResetAtMs: number | null = null) {
    super(message);
    this.retryable = retryable;
    this.quotaResetAtMs = quotaResetAtMs;
  }
}

/**
 * Decides whether an attempt is worth repeating.
 *
 * The important line is 404: today it means "the backend has not shipped this
 * endpoint yet", which is emphatically retryable — just not soon. Rust's
 * backoff stretches to a day, so an undeployed endpoint costs a handful of
 * requests, not a loop.
 *
 * 409 is terminal on purpose: it means the server already holds this trace id
 * with different bytes, and re-sending cannot fix that.
 */
function classifyStatus(status: number): TraceUploadError {
  if (status === 409) {
    return new TraceUploadError(`Trace conflict (${status})`, false);
  }
  if (status === 413 || status === 400 || status === 422) {
    return new TraceUploadError(`Trace rejected (${status})`, false);
  }
  // 404 (not deployed), malformed 429, and 5xx (transient) all wait.
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

function authFetchForUid(
  ownerUid: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  if (auth.currentUser?.uid !== ownerUid) {
    return Promise.reject(new AuthRequiredError("Signed-in account changed"));
  }
  return authFetch(path, init);
}

/** Anything thrown that is not an HTTP status: offline, DNS, TLS, aborted. */
export function classifyUploadFailure(error: unknown): TraceUploadError {
  if (error instanceof TraceUploadError) return error;
  // A missing session is not a queue failure. The pump stops entirely rather
  // than burning an attempt on every queued trace.
  if (error instanceof AuthRequiredError) {
    return new TraceUploadError("Not signed in", true);
  }
  return new TraceUploadError(
    error instanceof Error ? error.message : "Network unavailable",
    true,
  );
}

/** Step 1: the metadata. Creates the record server-side. */
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
 * Uploads one claimed trace, metadata then audio.
 *
 * Ordered that way so a half-completed upload leaves a record with no audio
 * rather than audio with no label. The retry re-`PUT`s both under the same
 * trace id, and the server treats a byte-identical body as a no-op.
 */
export async function uploadTrace(lease: TraceUploadLease, ownerUid: string): Promise<void> {
  await putMetadata(lease, ownerUid);
  const raw = await invoke<ArrayBuffer>("dictation_trace_upload_audio", {
    traceId: lease.traceId,
    ownerUid,
  });
  await putAudio(lease.traceId, ownerUid, lease.audioSha256, new Uint8Array(raw));
}

/** Deletes the server's copy of a trace the user removed locally. */
export async function deleteRemoteTrace(traceId: string, ownerUid: string): Promise<void> {
  const response = await authFetchForUid(ownerUid, `/dictation/traces/${traceId}`, {
    method: "DELETE",
  });
  // A 404 here means the server never had it, or already dropped it. Either
  // way the obligation is discharged, so this is a success, not a retry.
  if (!response.ok && response.status !== 404) {
    throw classifyStatus(response.status);
  }
}

export function sharePumpState(): Promise<SharePumpState> {
  return invoke<SharePumpState>("dictation_share_pump_state");
}

export function claimTraceUpload(ownerUid: string): Promise<TraceUploadLease | null> {
  return invoke<TraceUploadLease | null>("dictation_claim_trace_upload", { ownerUid });
}

export function resolveTraceUpload(traceId: string, ownerUid: string): Promise<void> {
  return invoke("dictation_resolve_trace_upload", { traceId, ownerUid });
}

export function failTraceUpload(
  traceId: string,
  ownerUid: string,
  retryable: boolean,
): Promise<void> {
  return invoke("dictation_fail_trace_upload", { traceId, ownerUid, retryable });
}

export function claimTraceDeletion(ownerUid: string): Promise<string | null> {
  return invoke<string | null>("dictation_claim_trace_deletion", { ownerUid });
}

export function resolveTraceDeletion(traceId: string, ownerUid: string): Promise<void> {
  return invoke("dictation_resolve_trace_deletion", { traceId, ownerUid });
}

export function pauseTraceUploads(ownerUid: string, blockedUntilMs: number): Promise<boolean> {
  return invoke<boolean>("dictation_pause_trace_uploads", { ownerUid, blockedUntilMs });
}
