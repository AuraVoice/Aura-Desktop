import type { Room } from "livekit-client";

/**
 * Wire helpers for the Interview Mode job-description transfer.
 *
 * Every constant here is one half of a cross-repo contract; the other half is
 * `backend/src/agent/voice/interview/contracts.py`, and ECOSYSTEM.md section 5a
 * is the agreement between them. Changing a value on one side alone silently
 * breaks the transfer, so they are named and commented rather than inlined.
 *
 * Two directions, deliberately different transports:
 *
 * - The overlay acknowledgement is a small reliable data-channel packet on
 *   `client_events`, shaped like `artifact.displayed`: flat fields, not nested
 *   under `payload`, because that is what the worker parses.
 * - The pasted text itself goes back over a LiveKit byte stream, because it is
 *   arbitrarily long prose and the data channel is for control, not content.
 */

/** Byte-stream topic the worker registered a handler for before session start. */
export const INTERVIEW_MATERIAL_TOPIC = "interview_material";

/** Worker -> desktop: show one paste overlay. Nested under `payload`. */
export const MATERIAL_REQUEST_TYPE = "interview.material.request";

/** Desktop -> worker: that overlay is genuinely on screen. Flat fields. */
export const MATERIAL_OVERLAY_SHOWN_TYPE = "interview.material.overlay_shown";

/** The only wire schema the worker understands today. */
export const MATERIAL_SCHEMA_VERSION = 1;

/** The only material kind this transfer carries. */
export const MATERIAL_TYPE_JOB_DESCRIPTION = "job_description";

/**
 * Hard ceiling enforced by the worker on receipt regardless of what we claim to
 * have applied. Enforced here too so an over-long paste is refused in the UI,
 * where the user can actually do something about it, instead of being assembled,
 * shipped, and silently dropped on arrival.
 */
export const MAX_MATERIAL_BYTES = 64_000;

export interface MaterialRequest {
  interviewId: string;
  revision: number;
  materialType: string;
  schemaVersion: number;
}

const HEX_128 = /^[0-9a-f]{32}$/;

/**
 * The worker's request payload, or null if it is not one we can answer.
 *
 * Fails closed on every field. A request we cannot correlate is worse than no
 * request: the overlay would open, the user would paste, and the stream would be
 * rejected on arrival for a mismatched revision with nothing on screen to say so.
 */
export function parseMaterialRequest(payload: Record<string, unknown>): MaterialRequest | null {
  const { interview_id: interviewId, revision, material_type: materialType } = payload;
  const schemaVersion = payload.schema_version;
  if (typeof interviewId !== "string" || !HEX_128.test(interviewId)) return null;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    return null;
  }
  if (materialType !== MATERIAL_TYPE_JOB_DESCRIPTION) return null;
  // An unknown schema is a newer worker talking to an older desktop. Staying
  // silent is correct: the worker's own timeout then falls back to collecting
  // the role by voice, which is a working interview rather than a broken box.
  if (schemaVersion !== undefined && schemaVersion !== MATERIAL_SCHEMA_VERSION) {
    return null;
  }
  return {
    interviewId,
    revision,
    materialType,
    schemaVersion: MATERIAL_SCHEMA_VERSION,
  };
}

export function encodeOverlayShown(request: MaterialRequest): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: MATERIAL_OVERLAY_SHOWN_TYPE,
      interview_id: request.interviewId,
      revision: request.revision,
    }),
  );
}

/**
 * Receipt that the paste box is drawn and the user can see it.
 *
 * Publishing the request only proves the worker sent a packet, so without this
 * "the box is on your screen" is a claim about the network. Acknowledging packet
 * receipt, a hidden overlay, or a stale revision is forbidden by the contract for
 * exactly that reason: the worker speaks a line that would be a lie.
 */
export async function publishOverlayShown(
  room: Room,
  request: MaterialRequest,
): Promise<void> {
  await room.localParticipant.publishData(encodeOverlayShown(request), {
    reliable: true,
    topic: "client_events",
  });
}

/**
 * Sends the pasted job description back over its own byte stream.
 *
 * The attributes are the whole correlation mechanism: the worker accepts exactly
 * one stream per armed `(interview_id, revision)` pair and rejects everything
 * else, which is what makes a paste answering an earlier box unusable against a
 * later one. Throws so the caller can tell the user it did not go, rather than
 * clearing the box on a failure they never saw.
 */
export async function publishInterviewMaterial(
  room: Room,
  request: MaterialRequest,
  text: string,
): Promise<number> {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length === 0) throw new Error("interview material is empty");
  if (bytes.length > MAX_MATERIAL_BYTES) {
    throw new Error(`interview material exceeds ${MAX_MATERIAL_BYTES} bytes`);
  }
  const writer = await room.localParticipant.streamBytes({
    topic: INTERVIEW_MATERIAL_TOPIC,
    mimeType: "text/plain",
    totalSize: bytes.length,
    attributes: {
      interview_id: request.interviewId,
      revision: String(request.revision),
      material_type: request.materialType,
      schema_version: String(request.schemaVersion),
    },
  });
  await writer.write(bytes);
  await writer.close();
  return bytes.length;
}
