import { describe, expect, it, vi } from "vitest";

// The logger reaches into Tauri IPC, which doesn't exist under vitest's node
// environment - the validator's behavior must not depend on it anyway.
vi.mock("./log", () => ({
  logInfo: () => {},
  logError: () => {},
}));

import { validateAgentDataMessage, type DataParticipantLike } from "./agentData";

const agent: DataParticipantLike = { isLocal: false, isAgent: true, identity: "buddy-agent" };
const stranger: DataParticipantLike = { isLocal: false, isAgent: false, identity: "intruder" };
const self: DataParticipantLike = { isLocal: true, isAgent: false, identity: "me" };

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

const pointMessage = { type: "element.point", payload: { x: 10, y: 20, frame_id: "f1", label: "Save" } };
const draftMessage = {
  type: "draft.created",
  payload: { channel: "email_reply", length: "short", text: "Hi", draft_id: "d1", revision: 1 },
};

describe("sender validation", () => {
  it("rejects a message with no participant (server-API publish)", () => {
    const verdict = validateAgentDataMessage(encode(pointMessage), undefined, undefined);
    expect(verdict).toEqual({ kind: "rejected", reason: "no-participant" });
  });

  it("rejects the local participant", () => {
    const verdict = validateAgentDataMessage(encode(pointMessage), self, undefined);
    expect(verdict).toEqual({ kind: "rejected", reason: "local-participant" });
  });

  it("rejects a non-agent remote participant for every message type", () => {
    for (const message of [
      pointMessage,
      draftMessage,
      { type: "screen_save.created", payload: { collection_name: "Ideas" } },
      { type: "session.error", payload: { code: "boom" }, message: "kaput" },
    ]) {
      const verdict = validateAgentDataMessage(encode(message), stranger, undefined);
      expect(verdict).toEqual({ kind: "rejected", reason: "not-agent" });
    }
  });
});

describe("topic validation", () => {
  it("accepts an absent or empty topic (backend sets none today)", () => {
    expect(validateAgentDataMessage(encode(pointMessage), agent, undefined).kind).toBe("valid");
    expect(validateAgentDataMessage(encode(pointMessage), agent, "").kind).toBe("valid");
  });

  it("accepts the documented future topic", () => {
    expect(validateAgentDataMessage(encode(pointMessage), agent, "agent_events").kind).toBe("valid");
  });

  it("rejects any unexpected topic even from the agent", () => {
    const verdict = validateAgentDataMessage(encode(pointMessage), agent, "screen_frame");
    expect(verdict).toEqual({ kind: "rejected", reason: "unexpected-topic" });
  });
});

describe("size and shape limits", () => {
  it("rejects oversized payloads without crashing", () => {
    const huge = new Uint8Array(64 * 1024 + 1);
    const verdict = validateAgentDataMessage(huge, agent, undefined);
    expect(verdict).toEqual({ kind: "rejected", reason: "oversized" });
  });

  it("treats malformed JSON from the agent as liveness only", () => {
    const verdict = validateAgentDataMessage(new TextEncoder().encode("{nope"), agent, undefined);
    expect(verdict).toEqual({ kind: "agent-unknown", reason: "not-json" });
  });

  it("treats non-object JSON as liveness only", () => {
    expect(validateAgentDataMessage(encode([1, 2, 3]), agent, undefined)).toEqual({
      kind: "agent-unknown",
      reason: "not-an-object",
    });
    expect(validateAgentDataMessage(encode("hello"), agent, undefined)).toEqual({
      kind: "agent-unknown",
      reason: "not-an-object",
    });
  });

  it("treats a missing/odd type field as liveness only", () => {
    expect(validateAgentDataMessage(encode({}), agent, undefined).kind).toBe("agent-unknown");
    expect(validateAgentDataMessage(encode({ type: 42 }), agent, undefined).kind).toBe("agent-unknown");
    expect(
      validateAgentDataMessage(encode({ type: "x".repeat(65) }), agent, undefined).kind,
    ).toBe("agent-unknown");
  });

  it("treats an unknown type from the agent as liveness (version skew must not look dead)", () => {
    const verdict = validateAgentDataMessage(encode({ type: "shiny.new_thing" }), agent, undefined);
    expect(verdict).toEqual({ kind: "agent-unknown", reason: "unknown-type" });
  });
});

describe("per-type schema", () => {
  it("rejects element.point without finite numeric coordinates", () => {
    for (const payload of [
      { x: "10", y: 20 },
      { x: 10 },
      {},
      { x: Number.NaN, y: 1 },
      { x: Infinity, y: 1 },
    ]) {
      const verdict = validateAgentDataMessage(encode({ type: "element.point", payload }), agent, undefined);
      expect(verdict.kind).toBe("agent-unknown");
    }
  });

  it("rejects over-long string fields (draft text, labels)", () => {
    const bloated = {
      type: "draft.created",
      payload: { ...draftMessage.payload, text: "x".repeat(32_001) },
    };
    expect(validateAgentDataMessage(encode(bloated), agent, undefined).kind).toBe("agent-unknown");

    const longLabel = { type: "element.point", payload: { x: 1, y: 2, label: "x".repeat(301) } };
    expect(validateAgentDataMessage(encode(longLabel), agent, undefined).kind).toBe("agent-unknown");
  });

  it("round-trips every known type when well-formed", () => {
    const messages = [
      pointMessage,
      { type: "screen_save.created", payload: { collection_name: "Ideas", title: "T" } },
      { type: "draft.generating", payload: { channel: "cold_dm", mode: "refine" } },
      draftMessage,
      { type: "draft.updated", payload: { draft_id: "d1", text: "Hello again", revision: 2 } },
      { type: "draft.failed", payload: { reason: "quota_exceeded" } },
      { type: "session.error", payload: { code: "agent_crash" }, message: "it broke" },
    ] as const;
    for (const message of messages) {
      const verdict = validateAgentDataMessage(encode(message), agent, undefined);
      expect(verdict.kind, message.type).toBe("valid");
      if (verdict.kind === "valid") {
        expect(verdict.type).toBe(message.type);
        expect(verdict.payload).toEqual(message.payload);
      }
    }
  });

  it("accepts guide.request only with a boolean enable", () => {
    for (const enable of [true, false]) {
      const verdict = validateAgentDataMessage(
        encode({ type: "guide.request", payload: { enable } }),
        agent,
        undefined,
      );
      expect(verdict.kind, String(enable)).toBe("valid");
      expect(verdict.kind === "valid" && verdict.payload.enable).toBe(enable);
    }
    for (const bad of [{ enable: "yes" }, { enable: 1 }, {}]) {
      const verdict = validateAgentDataMessage(
        encode({ type: "guide.request", payload: bad }),
        agent,
        undefined,
      );
      expect(verdict.kind, JSON.stringify(bad)).toBe("agent-unknown");
    }
  });

  it("keeps session.error's top-level message but caps it", () => {
    const ok = validateAgentDataMessage(
      encode({ type: "session.error", message: "short" }),
      agent,
      undefined,
    );
    expect(ok.kind === "valid" && ok.message).toBe("short");

    const long = validateAgentDataMessage(
      encode({ type: "session.error", message: "x".repeat(2_001) }),
      agent,
      undefined,
    );
    expect(long.kind === "valid" && long.message).toBe(undefined);
  });

  it("strictly validates guide.step and its nested point", () => {
    const valid = {
      type: "guide.step",
      payload: {
        frame_id: "0123456789abcdef0123456789abcdef:9",
        frame_seq: 9,
        step_index: 2,
        instruction: "  Click Save.  ",
        point: {
          frame_id: "0123456789abcdef0123456789abcdef:9",
          x: 10,
          y: 20,
          label: " Save ",
        },
      },
    };
    const verdict = validateAgentDataMessage(encode(valid), agent, "agent_events");
    expect(verdict.kind).toBe("valid");
    if (verdict.kind === "valid") {
      expect(verdict.payload.instruction).toBe("Click Save.");
      expect((verdict.payload.point as Record<string, unknown>).label).toBe("Save");
    }

    for (const payload of [
      { ...valid.payload, frame_seq: 8 },
      { ...valid.payload, step_index: 0 },
      { ...valid.payload, instruction: "   " },
      { ...valid.payload, done: "yes" },
      { ...valid.payload, point: { ...valid.payload.point, frame_id: "other:9" } },
      { ...valid.payload, point: { ...valid.payload.point, x: Infinity } },
      { ...valid.payload, point: { ...valid.payload.point, label: "x".repeat(301) } },
    ]) {
      expect(
        validateAgentDataMessage(encode({ type: "guide.step", payload }), agent, "agent_events")
          .kind,
      ).toBe("agent-unknown");
    }
  });

  it("keeps frame_seq correlation separate from task step_index", () => {
    const verdict = validateAgentDataMessage(
      encode({
        type: "guide.step",
        payload: {
          frame_id: "0123456789abcdef0123456789abcdef:12",
          frame_seq: 12,
          step_index: 3,
          instruction: "Try the same step again.",
        },
      }),
      agent,
      "agent_events",
    );
    expect(verdict.kind).toBe("valid");
  });

  it("accepts only generation-bound Guide mode acknowledgements", () => {
    const payload = {
      active: true,
      generation: 4,
      guide_session_id: "0123456789abcdef0123456789abcdef",
      protocol_version: 2,
      reason: null,
    };
    expect(
      validateAgentDataMessage(
        encode({ type: "guide.mode_ack", payload }),
        agent,
        "agent_events",
      ).kind,
    ).toBe("valid");
    for (const invalid of [
      { ...payload, generation: -1 },
      { ...payload, guide_session_id: "wrong" },
      { ...payload, protocol_version: 1 },
      { ...payload, active: "yes" },
    ]) {
      expect(
        validateAgentDataMessage(
          encode({ type: "guide.mode_ack", payload: invalid }),
          agent,
          "agent_events",
        ).kind,
      ).toBe("agent-unknown");
    }
  });

  it("tolerates unknown extra fields (forward compatibility)", () => {
    const verdict = validateAgentDataMessage(
      encode({ type: "element.point", payload: { x: 1, y: 2, future_field: true } }),
      agent,
      undefined,
    );
    expect(verdict.kind).toBe("valid");
  });
});

describe("watchdog liveness semantics", () => {
  // The caller pokes the silence watchdog for "valid" and "agent-unknown"
  // but never for "rejected" - pin the verdict split those semantics ride on.
  it("a stranger's message can never register as a sign of life", () => {
    expect(validateAgentDataMessage(encode({ type: "anything" }), stranger, undefined).kind).toBe(
      "rejected",
    );
  });

  it("an agent message that fails schema still registers as alive", () => {
    const verdict = validateAgentDataMessage(
      encode({ type: "element.point", payload: { x: "bad" } }),
      agent,
      undefined,
    );
    expect(verdict.kind).toBe("agent-unknown");
  });
});
