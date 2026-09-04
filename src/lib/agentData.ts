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
  // Backend confirmation that a voice-triggered Notion save landed. Caption
  // only; page_url is stored but never auto-opened.
  | "notion.saved"
  | "assistant.text.delta"
  | "assistant.text.done"
  | "text_input.accepted"
  | "text_input.started"
  | "text_input.failed"
  | "draft.generating"
  | "draft.created"
  | "draft.updated"
  | "draft.failed"
  | "session.error"
  // Confirms the worker actually suppressed its own audio. Without it a mute
  // silently degrades to client-side-only and the user keeps paying for TTS.
  | "output.mode_ack"
  | "guide.step"
  | "guide.mode_ack"
  | "guide.frame_ack"
  | "guide.task"
  | "guide.instruction"
  | "guide.failure"
  // Agent-requested Guide Mode arm/disarm. The desktop stays the arming
  // authority: this only asks, and useGuideMode routes it to the native
  // arm_guide/disarm_guide command (payload.enable decides which).
  | "guide.request"
  // Agent-requested screen-context enable. Mirrors guide.request's authority
  // split: the desktop shows an explicit consent prompt, and only the user's
  // own click flips the voiceScreenContext setting. Empty payload.
  | "screen_context.request"
  // Interview Mode: show one job-description paste overlay. The desktop must
  // echo interview.material.overlay_shown only once the box is genuinely on
  // screen (see overlay/interview/), because the worker speaks a line to the
  // user off the back of that ack.
  | "interview.material.request"
  // Desktop control (desktop client only). The verb lives inside
  // payload.id and is validated against the client capability registry
  // (desktopCapabilities.ts), so this stays a single message type no matter
  // how many verbs exist - the whole point of the capability-as-data design.
  | "desktop.run";

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
  id: 64,
  label: 300,
  collection_name: 300,
  title: 300,
  draft_id: 128,
  client_message_id: 128,
  channel: 64,
  skill_id: 64,
  length: 64,
  mode: 64,
  reason: 64,
  code: 64,
  context_summary: 4_000,
  text: 32_000,
  instruction: 2_000,
  instruction_id: 128,
  guide_session_id: 64,
  interview_id: 64,
  material_type: 64,
  task_id: 64,
  current_step_id: 80,
  current_step_title: 100,
  status: 64,
  delivery_status: 64,
  rejection_reason: 64,
  newest_frame_id: 64,
  trace_id: 64,
  event_id: 64,
  parent_event_id: 64,
  stage: 32,
  error_type: 120,
  database_name: 300,
  page_url: 2_000,
  page_id: 64,
};

const KNOWN_TYPES: ReadonlySet<string> = new Set([
  "element.point",
  "screen_save.created",
  "notion.saved",
  "assistant.text.delta",
  "assistant.text.done",
  "text_input.accepted",
  "text_input.started",
  "text_input.failed",
  "draft.generating",
  "draft.created",
  "draft.updated",
  "draft.failed",
  "session.error",
  "output.mode_ack",
  "guide.step",
  "guide.mode_ack",
  "guide.frame_ack",
  "guide.task",
  "guide.instruction",
  "guide.failure",
  "guide.request",
  "screen_context.request",
  "interview.material.request",
  "desktop.run",
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
  if (
    type === "assistant.text.delta" ||
    type === "assistant.text.done" ||
    type === "text_input.accepted" ||
    type === "text_input.started" ||
    type === "text_input.failed"
  ) {
    if (
      typeof payload.client_message_id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        payload.client_message_id,
      )
    ) {
      return false;
    }
  }
  if (type === "assistant.text.delta" || type === "assistant.text.done") {
    return typeof payload.text === "string";
  }
  if (type === "text_input.accepted") {
    return Number.isSafeInteger(payload.queue_position) && (payload.queue_position as number) >= 0;
  }
  if (type === "text_input.failed") {
    return typeof payload.reason === "string" && payload.reason.trim().length > 0;
  }
  if (type === "output.mode_ack") {
    return (
      (payload.mode === "voice" || payload.mode === "text") &&
      Number.isSafeInteger(payload.generation) &&
      (payload.generation as number) >= 0 &&
      typeof payload.applied === "boolean" &&
      (payload.reason == null || typeof payload.reason === "string")
    );
  }
  if (type === "guide.step") return validateGuideStep(payload);
  if (type === "guide.mode_ack") {
    return (
      typeof payload.active === "boolean" &&
      Number.isSafeInteger(payload.generation) &&
      (payload.generation as number) >= 0 &&
      typeof payload.guide_session_id === "string" &&
      /^[0-9a-f]{32}$/.test(payload.guide_session_id) &&
      payload.protocol_version === 2 &&
      (payload.reason == null || typeof payload.reason === "string")
    );
  }
  if (type === "guide.frame_ack") {
    return (
      typeof payload.frame_id === "string" &&
      /^([0-9a-f]{32}):(\d+)$/.test(payload.frame_id) &&
      typeof payload.accepted === "boolean"
    );
  }
  if (type === "guide.task") {
    return (
      typeof payload.guide_session_id === "string" &&
      /^[0-9a-f]{32}$/.test(payload.guide_session_id) &&
      typeof payload.task_id === "string" &&
      /^[0-9a-f]{32}$/.test(payload.task_id) &&
      Number.isSafeInteger(payload.revision)
    );
  }
  if (type === "guide.instruction") {
    return (
      typeof payload.guide_session_id === "string" &&
      /^[0-9a-f]{32}$/.test(payload.guide_session_id) &&
      typeof payload.task_id === "string" &&
      /^[0-9a-f]{32}$/.test(payload.task_id) &&
      typeof payload.instruction_id === "string" &&
      payload.instruction_id.length <= FIELD_CAPS.instruction_id &&
      Number.isSafeInteger(payload.revision)
    );
  }
  if (type === "guide.request") {
    return typeof payload.enable === "boolean";
  }
  if (type === "notion.saved") {
    // page_url is the one field that could reach openUrl someday; only https
    // (or absent) survives validation.
    return (
      typeof payload.database_name === "string" &&
      (payload.page_url == null ||
        (typeof payload.page_url === "string" &&
          (payload.page_url === "" || payload.page_url.startsWith("https://"))))
    );
  }
  if (type === "guide.failure") {
    return (
      typeof payload.guide_session_id === "string" &&
      /^[0-9a-f]{32}$/.test(payload.guide_session_id) &&
      typeof payload.trace_id === "string" &&
      /^[0-9a-f]{32}$/.test(payload.trace_id) &&
      typeof payload.event_id === "string" &&
      /^[0-9a-f]{32}$/.test(payload.event_id) &&
      ["capture", "planning", "execution", "verification", "speech"].includes(
        String(payload.stage),
      ) &&
      typeof payload.reason === "string"
    );
  }
  return true;
}

function validateGuideStep(payload: Record<string, unknown>): boolean {
  const frameId = payload.frame_id;
  const frameSeq = payload.frame_seq;
  const stepIndex = payload.step_index;
  const instruction = payload.instruction;
  if (typeof frameId !== "string" || frameId.length > 64) return false;
  const frameMatch = /^([0-9a-f]{32}):(\d+)$/.exec(frameId);
  if (!frameMatch) return false;
  if (!Number.isInteger(frameSeq) || (frameSeq as number) < 0 || (frameSeq as number) > 0xffff_ffff) {
    return false;
  }
  if (Number(frameMatch[2]) !== frameSeq) return false;
  if (!Number.isInteger(stepIndex) || (stepIndex as number) < 1) return false;
  if (
    typeof instruction !== "string" ||
    instruction.length > FIELD_CAPS.instruction ||
    instruction.trim().length === 0
  ) {
    return false;
  }
  if (payload.done !== undefined && typeof payload.done !== "boolean") return false;
  if (payload.point === undefined) return true;
  if (!isPlainObject(payload.point)) return false;
  if (payload.point.frame_id !== frameId) return false;
  if (typeof payload.point.x !== "number" || !Number.isFinite(payload.point.x)) return false;
  if (typeof payload.point.y !== "number" || !Number.isFinite(payload.point.y)) return false;
  if (
    payload.point.label !== undefined &&
    (typeof payload.point.label !== "string" || payload.point.label.trim().length > FIELD_CAPS.label)
  ) {
    return false;
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
  let payloadObject = eventPayload ?? {};
  if (!payloadWithinLimits(knownType, payloadObject)) {
    logRejection("schema", `type=${knownType} identity=${participant.identity}`);
    return { kind: "agent-unknown", reason: "schema" };
  }
  if (knownType === "guide.step") {
    const point = isPlainObject(payloadObject.point)
      ? {
          ...payloadObject.point,
          label:
            typeof payloadObject.point.label === "string"
              ? payloadObject.point.label.trim()
              : undefined,
        }
      : undefined;
    payloadObject = {
      ...payloadObject,
      instruction: (payloadObject.instruction as string).trim(),
      point,
    };
  }

  const message = typeof event.message === "string" && event.message.length <= 2_000
    ? event.message
    : undefined;
  return { kind: "valid", type: knownType, payload: payloadObject, message };
}
