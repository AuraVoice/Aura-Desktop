import { authFetch, AuthRequiredError } from "./api";
import { logError } from "./log";

/** Machine code the backend returns on a 402 claim denial - the exact
 * voice-cap contract shape (voice.ts), so the parsers mirror each other. */
export const meetingCapReachedCode = "meeting_cap_reached";
export const meetingConflictCode = "meeting_already_claimed";

export type MeetingJobFailureClassification =
  | "transient"
  | "auth"
  | "paused"
  | "terminal";

export class MeetingTransportError extends Error {
  status: number;
  code: string;
  classification: MeetingJobFailureClassification;
  /** The server's own capture fence, present on a `stale_capture_fence` 409.
   * Lets the caller tell "we are simply behind" (adopt it and carry on) from
   * "we have forked" (unrecoverable). */
  serverCaptureFence: number | null;

  constructor(
    message: string,
    status: number,
    code: string,
    classification: MeetingJobFailureClassification,
    serverCaptureFence: number | null = null,
  ) {
    super(message);
    this.name = "MeetingTransportError";
    this.status = status;
    this.code = code;
    this.classification = classification;
    this.serverCaptureFence = serverCaptureFence;
  }
}

export class MeetingCapError extends Error {
  secondsUntilReset: number | null;

  constructor(secondsUntilReset: number | null) {
    super("Meeting claim denied: monthly cap reached");
    this.name = "MeetingCapError";
    this.secondsUntilReset = secondsUntilReset;
  }
}

/** Another device holds this meeting's active claim - skip capture silently,
 * that device is recording it. */
export class MeetingClaimConflictError extends Error {
  constructor() {
    super("Meeting already claimed by another device");
    this.name = "MeetingClaimConflictError";
  }
}

/** The backend did not resolve this meeting. The upload pump retains the local
 * encrypted queue because a generic 404 is not a destructive-delete contract. */
export class MeetingGoneError extends Error {
  constructor() {
    super("Meeting no longer exists on the backend");
    this.name = "MeetingGoneError";
  }
}

export interface MeetingClaim {
  meetingId: string;
  captureRunId: string;
  captureFence: number;
  leaseExpiresAt: string | null;
  capMinutes: number;
  maxCaptureMinutes: number;
  rejoined: boolean;
}

export interface TranscriptTurn {
  speaker: string;
  text: string;
}

export interface MeetingNote {
  summary: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  transcript: TranscriptTurn[];
  language: string;
  oneSided: boolean;
  /** Some captured segments carried gaps (device change mid-segment). */
  partial: boolean;
}

export type MeetingStatus =
  | "capturing"
  | "uploaded"
  | "synthesizing"
  | "needs_attention"
  | "ready"
  | "excluded"
  | "failed";

export type MeetingProcessingStage =
  | "capturing"
  | "uploading"
  | "queued"
  | "transcribing"
  | "building_insights"
  | "quality_check"
  | "needs_attention"
  | "ready";

export interface MeetingDoc {
  meetingId: string;
  eventId: string;
  title: string;
  status: MeetingStatus;
  processingStage: MeetingProcessingStage | null;
  failureCode: string | null;
  failureMessage: string | null;
  retryable: boolean;
  attemptCount: number;
  lastErrorAt: string | null;
  statusRevision: number;
  artifactRevision: number;
  qualityOutcome: string | null;
  qualityPolicyVersion: string | null;
  transcriptArtifact: {
    object: string;
    generation: string;
    sha256: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  note: MeetingNote | null;
}

/** Reads a 402 body defensively, same discipline as voice.ts's parseCapDenial:
 * only the machine code counts, anything else stays a generic failure. */
async function parseCapDenial(response: Response): Promise<MeetingCapError | null> {
  try {
    const body = (await response.json()) as {
      detail?: { code?: unknown; seconds_until_reset?: unknown };
    };
    if (body?.detail?.code !== meetingCapReachedCode) return null;
    const seconds = body.detail.seconds_until_reset;
    return new MeetingCapError(typeof seconds === "number" ? seconds : null);
  } catch {
    return null;
  }
}

export async function claimMeeting(args: {
  eventId: string;
  title: string;
  startTime: string;
  endTime: string;
  installationId: string;
  runtimeInstanceId: string;
}): Promise<MeetingClaim> {
  const response = await authFetch("/meetings/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: args.eventId,
      title: args.title,
      start_time: args.startTime,
      end_time: args.endTime,
      installation_id: args.installationId,
      runtime_instance_id: args.runtimeInstanceId,
    }),
  });
  if (response.status === 402) {
    const capError = await parseCapDenial(response);
    if (capError) throw capError;
  }
  if (response.status === 409) {
    throw new MeetingClaimConflictError();
  }
  if (!response.ok) {
    throw new Error(`Meeting claim failed (${response.status})`);
  }
  const data = (await response.json()) as {
    meeting_id?: unknown;
    cap_minutes?: unknown;
    max_capture_minutes?: unknown;
    rejoined?: unknown;
    capture_run_id?: unknown;
    capture_fence?: unknown;
    lease_expires_at?: unknown;
    protocol_version?: unknown;
  };
  if (typeof data.meeting_id !== "string" || !data.meeting_id) {
    throw new Error("Meeting claim response missing meeting_id");
  }
  if (
    typeof data.capture_run_id !== "string"
    || !data.capture_run_id
    || typeof data.capture_fence !== "number"
    || !Number.isSafeInteger(data.capture_fence)
    || data.capture_fence < 0
    || data.protocol_version !== 2
  ) {
    throw new Error("Meeting claim response is not protocol V2");
  }
  return {
    meetingId: data.meeting_id,
    captureRunId: data.capture_run_id,
    captureFence: data.capture_fence,
    leaseExpiresAt:
      typeof data.lease_expires_at === "string" ? data.lease_expires_at : null,
    capMinutes: typeof data.cap_minutes === "number" ? data.cap_minutes : 60,
    maxCaptureMinutes:
      typeof data.max_capture_minutes === "number" ? data.max_capture_minutes : 240,
    rejoined: data.rejoined === true,
  };
}

/** One raw FLAC segment body; offsets ride headers so the body stays pure
 * audio. 60s timeout: segments are ~10 MB and this runs on a background pump
 * with its own retry/backoff, so patience beats a spurious abort. */
export interface UploadReceipt {
  receiptId: string;
  object: string;
  generation: string;
  contentSha256: string;
  byteLength: number;
  acceptedAt: string;
}

export async function uploadSegment(args: {
  jobId: string;
  meetingId: string;
  captureRunId: string;
  captureFence: number;
  seq: number;
  bytes: Uint8Array;
  startMs: number;
  durationMs: number;
  incomplete: boolean;
  contentSha256: string;
  byteLength: number;
  channelCount: number;
  sampleRateHz: number;
}): Promise<UploadReceipt> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const body = new Uint8Array(args.bytes).buffer as ArrayBuffer;
    const response = await authFetch(
      `/meetings/${args.meetingId}/capture-runs/${args.captureRunId}/segments/${args.seq}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "audio/flac",
          "Idempotency-Key": args.jobId,
          "X-Capture-Fence": String(args.captureFence),
          "X-Content-SHA256": args.contentSha256,
          "X-Byte-Length": String(args.byteLength),
          "X-Start-Ms": String(args.startMs),
          "X-Duration-Ms": String(args.durationMs),
          "X-Channel-Count": String(args.channelCount),
          "X-Sample-Rate-Hz": String(args.sampleRateHz),
          "X-Incomplete": args.incomplete ? "true" : "false",
        },
        body,
        signal: controller.signal,
      },
    );
    const payload = await readJsonObject(response);
    if (!response.ok && !(response.status === 409 && isSameIdentity(payload))) {
      throw transportError("Segment upload", response.status, payload);
    }
    return parseUploadReceipt(payload, args.contentSha256, args.byteLength);
  } finally {
    clearTimeout(timeoutId);
  }
}

export interface CompletionReceipt {
  receiptId: string;
  manifestSha256: string;
  acceptedAt: string;
}

export interface MeetingCompletionSegment {
  seq: number;
  startMs: number;
  durationMs: number;
  incomplete: boolean;
  contentSha256: string;
  byteLength: number;
  channelCount: number;
  sampleRateHz: number;
  metrics: {
    micRmsDbfs: number;
    systemRmsDbfs: number;
    micClippingRatio: number;
    systemClippingRatio: number;
    micZeroRatio: number;
    systemZeroRatio: number;
    micVadSpeechMs: number;
    systemVadSpeechMs: number;
    micDeviceIdHash: string;
    systemDeviceIdHash: string;
  };
}

export async function completeMeeting(args: {
    jobId: string;
    meetingId: string;
    captureRunId: string;
    captureFence: number;
    segmentCount: number;
    totalDurationMs: number;
    reason: string;
    segmentDigests: string[];
    manifestSegments: MeetingCompletionSegment[];
    manifestSha256: string;
  }): Promise<CompletionReceipt> {
  const response = await authFetch(
    `/meetings/${args.meetingId}/capture-runs/${args.captureRunId}/complete`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": args.jobId,
      },
      body: JSON.stringify({
      capture_fence: args.captureFence,
      segment_count: args.segmentCount,
      total_duration_ms: args.totalDurationMs,
      reason: args.reason,
      segment_digests: args.segmentDigests,
      segments: args.manifestSegments.map((segment) => ({
        seq: segment.seq,
        start_ms: segment.startMs,
        duration_ms: segment.durationMs,
        incomplete: segment.incomplete,
        content_sha256: segment.contentSha256,
        byte_length: segment.byteLength,
        channel_count: segment.channelCount,
        sample_rate_hz: segment.sampleRateHz,
        audio_metrics: {
          mic_rms_dbfs: segment.metrics.micRmsDbfs,
          system_rms_dbfs: segment.metrics.systemRmsDbfs,
          mic_clipping_ratio: segment.metrics.micClippingRatio,
          system_clipping_ratio: segment.metrics.systemClippingRatio,
          mic_zero_ratio: segment.metrics.micZeroRatio,
          system_zero_ratio: segment.metrics.systemZeroRatio,
          mic_vad_speech_ms: segment.metrics.micVadSpeechMs,
          system_vad_speech_ms: segment.metrics.systemVadSpeechMs,
          mic_device_id_hash: segment.metrics.micDeviceIdHash,
          system_device_id_hash: segment.metrics.systemDeviceIdHash,
        },
      })),
      manifest_sha256: args.manifestSha256,
      }),
    },
  );
  const payload = await readJsonObject(response);
  if (!response.ok && !(response.status === 409 && isSameIdentity(payload))) {
    throw transportError("Meeting complete", response.status, payload);
  }
  return parseCompletionReceipt(payload, args.manifestSha256);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  try {
    const payload = await response.json();
    return typeof payload === "object" && payload !== null
      ? payload as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function errorCode(payload: Record<string, unknown>, fallback: string): string {
  const detail = typeof payload.detail === "object" && payload.detail !== null
    ? payload.detail as Record<string, unknown>
    : payload;
  return typeof detail.code === "string" && detail.code.length > 0
    ? detail.code
    : fallback;
}

function isSameIdentity(payload: Record<string, unknown>): boolean {
  return [
    "segment_already_exists",
    "upload_already_accepted",
    "completion_already_accepted",
    "idempotent_replay",
  ].includes(errorCode(payload, ""));
}

// A 409 says "your view of this run disagrees with the server's". Most of those
// disagreements are repairable, and treating every one as terminal is what
// stranded real recordings: the job died, no retry was scheduled, no
// notification fired, and the local audio expired untouched. Only a conflict no
// client action can reconcile stays terminal.
const RECOVERABLE_CONFLICT_CODES = [
  // The server advanced past us. Re-claim, adopt its fence, resume.
  "stale_capture_fence",
  // Our manifest disagreed with the persisted segments. Rebuild it from local
  // truth and complete again.
  "manifest_integrity_failed",
  "completion_conflict",
  // Ingest is closed for this run, but the evidence itself is intact.
  "capture_run_not_accepting_uploads",
];

function transportError(
  operation: string,
  status: number,
  payload: Record<string, unknown>,
): MeetingTransportError {
  const code = errorCode(payload, `http_${status}`);
  let classification: MeetingJobFailureClassification;
  if (status === 401) classification = "auth";
  else if (status === 403) classification = "paused";
  else if (status === 408 || status === 429 || status >= 500 || status === 404) {
    classification = "transient";
  } else if (status === 409 && RECOVERABLE_CONFLICT_CODES.includes(code)) {
    classification = "transient";
  } else {
    classification = "terminal";
  }
  const detail = typeof payload.detail === "object" && payload.detail !== null
    ? payload.detail as Record<string, unknown>
    : payload;
  const serverFence = typeof detail.capture_fence === "number"
    ? detail.capture_fence
    : null;
  return new MeetingTransportError(
    `${operation} failed (${status}, ${code})`,
    status,
    code,
    classification,
    serverFence,
  );
}

function parseUploadReceipt(
  payload: Record<string, unknown>,
  expectedDigest: string,
  expectedLength: number,
): UploadReceipt {
  const receipt = {
    receiptId: typeof payload.receipt_id === "string" ? payload.receipt_id : "",
    object: typeof payload.object === "string" ? payload.object : "",
    generation: typeof payload.generation === "string"
      ? payload.generation
      : typeof payload.generation === "number"
      ? String(payload.generation)
      : "",
    contentSha256:
      typeof payload.content_sha256 === "string" ? payload.content_sha256 : "",
    byteLength: typeof payload.byte_length === "number" ? payload.byte_length : -1,
    acceptedAt: typeof payload.accepted_at === "string" ? payload.accepted_at : "",
  };
  if (
    !receipt.receiptId
    || !receipt.object
    || !receipt.generation
    || !receipt.acceptedAt
    || receipt.contentSha256 !== expectedDigest
    || receipt.byteLength !== expectedLength
  ) {
    throw new MeetingTransportError(
      "Segment upload returned an invalid receipt",
      200,
      "invalid_upload_receipt",
      "terminal",
    );
  }
  return receipt;
}

function parseCompletionReceipt(
  payload: Record<string, unknown>,
  expectedManifest: string,
): CompletionReceipt {
  const receipt = {
    receiptId: typeof payload.receipt_id === "string" ? payload.receipt_id : "",
    manifestSha256:
      typeof payload.manifest_sha256 === "string" ? payload.manifest_sha256 : "",
    acceptedAt: typeof payload.accepted_at === "string" ? payload.accepted_at : "",
  };
  if (
    !receipt.receiptId
    || !receipt.acceptedAt
    || receipt.manifestSha256 !== expectedManifest
  ) {
    throw new MeetingTransportError(
      "Meeting completion returned an invalid receipt",
      200,
      "invalid_completion_receipt",
      "terminal",
    );
  }
  return receipt;
}

function parseNote(raw: unknown): MeetingNote | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const transcript = Array.isArray(row.transcript)
    && row.transcript.every((turn) => {
      if (typeof turn !== "object" || turn === null) return false;
      const entry = turn as Record<string, unknown>;
      return typeof entry.speaker === "string" && typeof entry.text === "string";
    })
    ? row.transcript.map((turn) => {
        const entry = turn as Record<string, string>;
        return { speaker: entry.speaker, text: entry.text };
      })
    : [];
  return {
    summary: typeof row.summary === "string" ? row.summary : "",
    decisions: strings(row.decisions),
    actionItems: strings(row.action_items),
    openQuestions: strings(row.open_questions),
    transcript,
    language: typeof row.language === "string" ? row.language : "",
    oneSided: row.one_sided === true,
    partial: row.partial === true,
  };
}

const meetingStatuses = new Set<MeetingStatus>([
  "capturing",
  "uploaded",
  "synthesizing",
  "needs_attention",
  "ready",
  "excluded",
  "failed",
]);
const processingStages = new Set<MeetingProcessingStage>([
  "capturing",
  "uploading",
  "queued",
  "transcribing",
  "building_insights",
  "quality_check",
  "needs_attention",
  "ready",
]);

export function parseMeetingDoc(raw: unknown): MeetingDoc | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const meetingId = typeof row.meeting_id === "string" ? row.meeting_id : "";
  const status = typeof row.status === "string" ? row.status : "";
  if (!meetingId || !meetingStatuses.has(status as MeetingStatus)) return null;
  const processingStage = typeof row.processing_stage === "string"
    && processingStages.has(row.processing_stage as MeetingProcessingStage)
    ? row.processing_stage as MeetingProcessingStage
    : null;
  const artifact = typeof row.transcript_artifact === "object"
    && row.transcript_artifact !== null
    ? row.transcript_artifact as Record<string, unknown>
    : null;
  const transcriptArtifact = artifact
    && typeof artifact.object === "string"
    && typeof artifact.generation === "string"
    && typeof artifact.sha256 === "string"
    ? {
        object: artifact.object,
        generation: artifact.generation,
        sha256: artifact.sha256,
      }
    : null;
  if (status === "ready" && !transcriptArtifact) {
    return null;
  }
  return {
    meetingId,
    eventId: typeof row.event_id === "string" ? row.event_id : "",
    title: typeof row.title === "string" ? row.title : "",
    status: status as MeetingStatus,
    processingStage,
    failureCode: typeof row.failure_code === "string" ? row.failure_code : null,
    failureMessage: typeof row.failure_message === "string" ? row.failure_message : null,
    retryable: row.retryable === true,
    attemptCount: typeof row.attempt_count === "number" ? row.attempt_count : 0,
    lastErrorAt: typeof row.last_error_at === "string" ? row.last_error_at : null,
    statusRevision: typeof row.status_revision === "number" ? row.status_revision : 0,
    artifactRevision: typeof row.artifact_revision === "number" ? row.artifact_revision : 0,
    qualityOutcome: typeof row.quality_outcome === "string" ? row.quality_outcome : null,
    qualityPolicyVersion:
      typeof row.quality_policy_version === "string" ? row.quality_policy_version : null,
    transcriptArtifact,
    createdAt: typeof row.created_at === "string" ? row.created_at : "",
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
    note: parseNote(row.note),
  };
}

export async function retryMeeting(meetingId: string): Promise<void> {
  const response = await authFetch(`/meetings/${meetingId}/retry`, { method: "POST" });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Meeting retry failed (${response.status})`);
  }
}

/** Ambient-surface read (null on every failure), like fetchUpcomingMeetings:
 * the delivery card must never surface an error. */
export async function fetchMeeting(
  meetingId: string,
  timeoutMs: number,
): Promise<MeetingDoc | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await authFetch(`/meetings/${meetingId}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return parseMeetingDoc(await response.json());
  } catch (err) {
    if (!(err instanceof AuthRequiredError) && !(err instanceof DOMException && err.name === "AbortError")) {
      logError("fetchMeeting", err);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchRecentMeetings(
  limit: number,
  timeoutMs: number,
): Promise<MeetingDoc[] | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await authFetch(`/meetings/recent?limit=${limit}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { items?: unknown };
    return Array.isArray(data.items)
      ? data.items.map(parseMeetingDoc).filter((m): m is MeetingDoc => m !== null)
      : [];
  } catch (err) {
    if (!(err instanceof AuthRequiredError) && !(err instanceof DOMException && err.name === "AbortError")) {
      logError("fetchRecentMeetings", err);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
