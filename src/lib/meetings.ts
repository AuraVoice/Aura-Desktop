import { authFetch, AuthRequiredError } from "./api";
import { logError } from "./log";

/** Machine code the backend returns on a 402 claim denial - the exact
 * voice-cap contract shape (voice.ts), so the parsers mirror each other. */
export const meetingCapReachedCode = "meeting_cap_reached";
export const meetingConflictCode = "meeting_already_claimed";

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
  capMinutes: number;
  maxCaptureMinutes: number;
  rejoined: boolean;
}

export interface MeetingNote {
  summary: string;
  decisions: string[];
  actionItems: string[];
  openQuestions: string[];
  language: string;
  oneSided: boolean;
  /** Some captured segments carried gaps (device change mid-segment). */
  partial: boolean;
}

export type MeetingStatus =
  | "capturing"
  | "uploaded"
  | "synthesizing"
  | "ready"
  | "excluded"
  | "failed";

export type MeetingProcessingStage =
  | "capturing"
  | "uploading"
  | "queued"
  | "transcribing"
  | "building_insights"
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
  deviceId: string;
}): Promise<MeetingClaim> {
  const response = await authFetch("/meetings/claim", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      event_id: args.eventId,
      title: args.title,
      start_time: args.startTime,
      end_time: args.endTime,
      device_id: args.deviceId,
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
  };
  if (typeof data.meeting_id !== "string" || !data.meeting_id) {
    throw new Error("Meeting claim response missing meeting_id");
  }
  return {
    meetingId: data.meeting_id,
    capMinutes: typeof data.cap_minutes === "number" ? data.cap_minutes : 60,
    maxCaptureMinutes:
      typeof data.max_capture_minutes === "number" ? data.max_capture_minutes : 240,
    rejoined: data.rejoined === true,
  };
}

/** One raw FLAC segment body; offsets ride headers so the body stays pure
 * audio. 60s timeout: segments are ~10 MB and this runs on a background pump
 * with its own retry/backoff, so patience beats a spurious abort. */
export async function uploadSegment(
  meetingId: string,
  seq: number,
  bytes: Uint8Array,
  startMs: number,
  durationMs: number,
  incomplete: boolean,
): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60_000);
  try {
    const body = new Uint8Array(bytes).buffer as ArrayBuffer;
    const response = await authFetch(`/meetings/${meetingId}/segments/${seq}`, {
      method: "POST",
      headers: {
        "Content-Type": "audio/flac",
        "X-Segment-Start-Ms": String(startMs),
        "X-Segment-Duration-Ms": String(durationMs),
        "X-Segment-Incomplete": incomplete ? "true" : "false",
      },
      body,
      signal: controller.signal,
    });
    if (response.status === 404) throw new MeetingGoneError();
    if (!response.ok) {
      throw new Error(`Segment upload failed (${response.status})`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function completeMeeting(
  meetingId: string,
  args: { segmentCount: number; totalDurationMs: number; reason: string },
): Promise<void> {
  const response = await authFetch(`/meetings/${meetingId}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      segment_count: args.segmentCount,
      total_duration_ms: args.totalDurationMs,
      reason: args.reason,
    }),
  });
  if (response.status === 404) throw new MeetingGoneError();
  if (!response.ok) {
    throw new Error(`Meeting complete failed (${response.status})`);
  }
}

function parseNote(raw: unknown): MeetingNote | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  return {
    summary: typeof row.summary === "string" ? row.summary : "",
    decisions: strings(row.decisions),
    actionItems: strings(row.action_items),
    openQuestions: strings(row.open_questions),
    language: typeof row.language === "string" ? row.language : "",
    oneSided: row.one_sided === true,
    partial: row.partial === true,
  };
}

const meetingStatuses = new Set<MeetingStatus>([
  "capturing",
  "uploaded",
  "synthesizing",
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
