import { logInfo } from "./log";

/**
 * Shared validation for every LiveKit data-channel message before any hook
 * acts on it. A message is not trusted because its JSON `type` looks right:
 * any participant in the room can publish on the data channel, and one of
 * these messages can end in a native command (element.point -> point_at).
 * Every RoomEvent.DataReceived consumer (useVoiceBar, useScreenSight,
 * useDraftCard) runs its payload through validateAgentDataMessage with the
 * full handler signature (payload, participant, kind, topic) and dispatches
 * only on a "valid" verdict.
 *
 * Sender trust: `participant.isAgent` is the LiveKit participant *kind*,
 * asserted by the SFU from the agent's own signed token grant - an ordinary
 * remote participant cannot claim it. That is the strongest signal available
 * today, because /voice/token returns only { token, url, room }.
 *
 * Backend contract additions this module is ready for (documented, NOT yet
 * implemented server-side - the client must fail closed but keep working
 * until they ship):
 *   1. /voice/token response gains `agent_identity: string` (the exact
 *      LiveKit identity the voice agent joins with). The client then pins
 *      `participant.identity === agentIdentity` IN ADDITION to isAgent.
 *      Migration is fail-closed either way: enforce the field when present,
 *      fall back to isAgent-only while absent, so the client ships first.
 *   2. Agent publish_data calls gain an explicit `topic` (e.g.
 *      "agent_events") plus `msg_id` and `sent_at_ms` fields, enabling topic
 *      pinning and replay/freshness rejection. Today the backend publishes
 *      with no topic, so absent/empty topics are accepted and any unexpected
 *      topic is rejected; the backend must only start setting the topic
 *      after clients that allowlist it are out (forced release order, same
 *      class as the 2026-07-10 draft-channel lesson).
 * Until (2) lands, replay exposure is bounded without message ids: drafts
 * are idempotent by draft_id/revision, and element.point is gated natively
 * (security.rs) on a live voice session with a real capture.
 */

/** Structural view of the LiveKit participant the handler received - kept
 * dependency-free so the validator is testable without livekit-client. */
export interface DataParticipantLike {
  isLocal: boolean;
  isAgent: boolean;
  identity: string;
}

export type KnownAgentEventType =
  | "element.point"
  | "screen_save.created"
  | "draft.generating"
  | "draft.created"
  | "draft.updated"
  | "draft.failed"
  | "session.error";

export interface ValidAgentEvent {
  kind: "valid";
  type: KnownAgentEventType;
  payload: Record<string, unknown>;
  /** session.error carries a top-level message alongside its payload. */
  message?: string;
}

export type AgentDataVerdict =
  | ValidAgentEvent
  /** Verified agent sender and parseable JSON, but an unknown type or a
   * failed schema: counts as agent liveness (watchdog poke), never
   * dispatched. Unknown types are expected across version skew - a newer
   * backend must not look "dead" to an older client. */
  | { kind: "agent-unknown"; reason: string }
  /** Not from the verified agent (or oversized/wrong topic): ignored
   * entirely - it must not even register as a sign of life. */
  | { kind: "rejected"; reason: string };

/** Screen frames we SEND use topic "screen_frame"; inbound agent events have
 * no topic today (see the contract block above). */
const ALLOWED_TOPICS = new Set<string>(["agent_events"]);

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TYPE_LENGTH = 64;

/** Per-field caps: generous multiples of anything the agent legitimately
 * sends, tight enough that a hostile publisher can't stuff megabytes into
 * React state or the clipboard. */
const FIELD_CAPS: Record<string, number> = {
  frame_id: 64,
  label: 300,
  collection_name: 300,
  title: 300,
  draft_id: 128,
  channel: 64,
  length: 64,
  mode: 64,
  reason: 64,
  code: 64,
  context_summary: 4_000,
  text: 32_000,
};

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "element.point",
  "screen_save.created",
  "draft.generating",
  "draft.created",
  "draft.updated",
  "draft.failed",
  "session.error",
] satisfies KnownAgentEventType[]);

// Rejection logging is throttled per reason so a hostile flood can't turn
// the durable log into its own denial of service.
const rejectionCounts = new Map<string, number>();
function logRejection(reason: string, detail: string) {
  const count = (rejectionCounts.get(reason) ?? 0) + 1;
  rejectionCounts.set(reason, count);
  if (count <= 3 || count % 100 === 0) {
    logInfo("agentData: message dropped", `reason=${reason} ${detail} (seen ${count}x)`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Type-safety pass over a known event's payload: fields we understand must
 * have the right primitive type and stay under their caps. Extra fields are
 * tolerated (version skew); required-field semantics stay in each hook,
 * which already narrows and logs per feature. */
function payloadWithinLimits(type: KnownAgentEventType, payload: Record<string, unknown>): boolean {
  for (const [field, value] of Object.entries(payload)) {
    const cap = FIELD_CAPS[field];
    if (cap !== undefined && typeof value === "string" && value.length > cap) return false;
  }
  if (type === "element.point") {
    const { x, y } = payload;
    if (typeof x !== "number" || !Number.isFinite(x)) return false;
    if (typeof y !== "number" || !Number.isFinite(y)) return false;
  }
  return true;
}

export function validateAgentDataMessage(
  payload: Uint8Array,
  participant: DataParticipantLike | undefined,
  topic: string | undefined,
): AgentDataVerdict {
  if (!participant) {
    // Server-API publishes arrive with no participant; nothing the backend
    // sends today does, so an anonymous message has no legitimate source.
    logRejection("no-participant", "");
    return { kind: "rejected", reason: "no-participant" };
  }
  if (participant.isLocal) {
    logRejection("local-participant", `identity=${participant.identity}`);
    return { kind: "rejected", reason: "local-participant" };
  }
  if (!participant.isAgent) {
    logRejection("not-agent", `identity=${participant.identity}`);
    return { kind: "rejected", reason: "not-agent" };
  }
  if (topic !== undefined && topic !== "" && !ALLOWED_TOPICS.has(topic)) {
    logRejection("unexpected-topic", `topic=${topic} identity=${participant.identity}`);
    return { kind: "rejected", reason: "unexpected-topic" };
  }
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    logRejection("oversized", `bytes=${payload.byteLength} identity=${participant.identity}`);
    return { kind: "rejected", reason: "oversized" };
  }

  let event: unknown;
  try {
    event = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    // Not JSON - not one of ours. From the verified agent this is still a
    // sign of life, but there's nothing to dispatch.
    return { kind: "agent-unknown", reason: "not-json" };
  }
  if (!isPlainObject(event)) return { kind: "agent-unknown", reason: "not-an-object" };

  const type = event.type;
  if (typeof type !== "string" || type.length === 0 || type.length > MAX_TYPE_LENGTH) {
    return { kind: "agent-unknown", reason: "bad-type-field" };
  }
  if (!KNOWN_TYPES.has(type)) return { kind: "agent-unknown", reason: "unknown-type" };
  const knownType = type as KnownAgentEventType;

  const eventPayload = event.payload;
  if (eventPayload !== undefined && !isPlainObject(eventPayload)) {
    return { kind: "agent-unknown", reason: "bad-payload-shape" };
  }
  const payloadObject = eventPayload ?? {};
  if (!payloadWithinLimits(knownType, payloadObject)) {
    logRejection("schema", `type=${knownType} identity=${participant.identity}`);
    return { kind: "agent-unknown", reason: "schema" };
  }

  const message = typeof event.message === "string" && event.message.length <= 2_000
    ? event.message
    : undefined;
  return { kind: "valid", type: knownType, payload: payloadObject, message };
}
