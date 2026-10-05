import type { Room } from "livekit-client";

/**
 * Wire helpers for the Interview Mode context transfer: the job description,
 * resume and notes the user hands Buddy before a mock interview.
 *
 * Every constant here is one half of a cross-repo contract; the other half is
 * `backend/src/agent/voice/interview/contracts.py`, and ECOSYSTEM.md section 5a
 * is the agreement between them. Changing a value on one side alone silently
 * breaks the transfer, so they are named and commented rather than inlined.
 *
 * Two directions, deliberately different transports:
 *
 * - Control (shown, dismissed) is a small reliable data-channel packet on
 *   `client_events`, shaped like `artifact.displayed`: flat fields, not nested
 *   under `payload`, because that is what the worker parses.
 * - The context itself goes back over a LiveKit byte stream as one JSON object,
 *   because it is arbitrarily long prose and the data channel is for control.
 *   Files never cross the wire: their text is extracted on this machine first.
 */

/** Byte-stream topic the worker registered a handler for before session start. */
export const CONTEXT_TOPIC = "interview_context";

/** Worker -> desktop: show the context card. Nested under `payload`. */
export const CONTEXT_REQUEST_TYPE = "interview.context.request";

/** Desktop -> worker: the card is genuinely on screen. Flat fields. */
export const CONTEXT_SHOWN_TYPE = "interview.context.shown";

/** Desktop -> worker: the user closed the card without sending. Flat fields. */
export const CONTEXT_DISMISSED_TYPE = "interview.context.dismissed";

/**
 * Per-part character caps, enforced again by the worker on receipt. Enforced
 * here first so an over-long part is refused in the card, where the user can
 * trim it, instead of being shipped and silently dropped on arrival.
 */
export const CONTEXT_FIELD_MAX_CHARS = {
  jobDescription: 24_000,
  resume: 20_000,
  notes: 12_000,
} as const;

/** Byte ceiling for the whole stream, as the worker counts it. */
export const MAX_CONTEXT_BYTES = 96_000;

export interface ContextRequest {
  interviewId: string;
  revision: number;
}

export interface InterviewContextParts {
  jobDescription: string;
  resume: string;
  notes: string;
}

export type ContextPart = keyof InterviewContextParts;

const HEX_128 = /^[0-9a-f]{32}$/;

/**
 * The worker's request payload, or null if it is not one we can answer.
 *
 * Fails closed on every field. A request we cannot correlate is worse than no
 * request: the card would open, the user would fill it in, and the stream would
 * be rejected on arrival for a mismatched revision with nothing on screen to say
 * so. Silence instead lets the worker's ack timeout fall back to voice setup.
 */
export function parseContextRequest(payload: Record<string, unknown>): ContextRequest | null {
  const { interview_id: interviewId, revision } = payload;
  if (typeof interviewId !== "string" || !HEX_128.test(interviewId)) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    return null;
  }
  return { interviewId, revision };
}

/** The first part over its cap, or null when every part fits. */
export function overLimitPart(parts: InterviewContextParts): ContextPart | null {
  for (const part of Object.keys(CONTEXT_FIELD_MAX_CHARS) as ContextPart[]) {
    if (parts[part].trim().length > CONTEXT_FIELD_MAX_CHARS[part]) return part;
  }
  return null;
}

export function encodeContext(parts: InterviewContextParts): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      job_description: parts.jobDescription.trim(),
      resume: parts.resume.trim(),
      notes: parts.notes.trim(),
    }),
  );
}

async function publishControl(room: Room, type: string, request: ContextRequest): Promise<void> {
  const data = new TextEncoder().encode(
    JSON.stringify({ type, interview_id: request.interviewId, revision: request.revision }),
  );
  await room.localParticipant.publishData(data, { reliable: true, topic: "client_events" });
}

/**
 * Receipt that the card is drawn and the user can see it.
 *
 * Publishing the request only proves the worker sent a packet, so without this
 * "the card is on your screen" is a claim about the network. Acknowledging packet
 * receipt, a hidden overlay, or a stale revision is forbidden by the contract for
 * exactly that reason: the worker speaks a line that would be a lie.
 */
export function publishContextShown(room: Room, request: ContextRequest): Promise<void> {
  return publishControl(room, CONTEXT_SHOWN_TYPE, request);
}

/** Tells setup to carry on now instead of waiting out the arrival bound. */
export function publishContextDismissed(room: Room, request: ContextRequest): Promise<void> {
  return publishControl(room, CONTEXT_DISMISSED_TYPE, request);
}

/**
 * Sends the context back over its own byte stream. Returns the byte count.
 *
 * The attributes are the whole correlation mechanism: the worker accepts exactly
 * one stream per armed `(interview_id, revision)` pair and rejects everything
 * else. Throws so the caller can tell the user it did not go, rather than
 * clearing the card on a failure they never saw.
 */
export async function publishContext(
  room: Room,
  request: ContextRequest,
  parts: InterviewContextParts,
): Promise<number> {
  if (!parts.jobDescription.trim() && !parts.resume.trim() && !parts.notes.trim()) {
    throw new Error("interview context is empty");
  }
  const part = overLimitPart(parts);
  if (part) throw new Error(`interview context part ${part} is over its limit`);
  const bytes = encodeContext(parts);
  if (bytes.length > MAX_CONTEXT_BYTES) {
    throw new Error(`interview context exceeds ${MAX_CONTEXT_BYTES} bytes`);
  }
  const writer = await room.localParticipant.streamBytes({
    topic: CONTEXT_TOPIC,
    mimeType: "application/json",
    totalSize: bytes.length,
    attributes: {
      interview_id: request.interviewId,
      revision: String(request.revision),
    },
  });
  await writer.write(bytes);
  await writer.close();
  return bytes.length;
}
