import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RoomEvent } from "livekit-client";
import {
  GUIDE_FIXED_HEADER_LEN,
  GUIDE_MAGIC,
  GUIDE_PROTOCOL_VERSION,
} from "../lib/screenFrame";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_ID = "100f0e0d0c0b0a090807060504030201";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  guideListener: null as ((event: { payload: unknown }) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, callback: (event: { payload: unknown }) => void) => {
    if (event === "guide-armed") mocks.guideListener = callback;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("../lib/log", () => ({ logError: vi.fn(), logInfo: vi.fn() }));
vi.mock("../lib/analytics", () => ({ trackEvent: vi.fn() }));

import { useGuideMode } from "./useGuideMode";
import type { VoiceSessionStatus } from "./useVoiceBar";

function guideEnvelope(sequence = 9, verdict = 2) {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff]);
  const payload = new Uint8Array(28 + jpeg.length);
  const payloadView = new DataView(payload.buffer);
  payloadView.setInt32(0, -1920, true);
  payloadView.setInt32(4, 0, true);
  payloadView.setUint32(8, 1920, true);
  payloadView.setUint32(12, 1080, true);
  payloadView.setFloat32(16, 1.25, true);
  payloadView.setUint32(20, 1280, true);
  payloadView.setUint32(24, 720, true);
  payload.set(jpeg, 28);

  const buffer = new ArrayBuffer(GUIDE_FIXED_HEADER_LEN + payload.length);
  const view = new DataView(buffer);
  view.setUint32(0, GUIDE_MAGIC, true);
  view.setUint16(4, GUIDE_PROTOCOL_VERSION, true);
  view.setUint8(6, verdict);
  for (let index = 0; index < 16; index += 1) view.setUint8(7 + index, index + 1);
  view.setBigUint64(23, 7n, true);
  view.setUint32(31, sequence, true);
  view.setUint32(35, GUIDE_FIXED_HEADER_LEN, true);
  view.setUint32(39, payload.length, true);
  new Uint8Array(buffer, GUIDE_FIXED_HEADER_LEN).set(payload);
  return buffer;
}

// Header-only envelope (no JPEG payload) for the verdicts that never carry a
// frame: "same" (0), "hold" (1), "skip" (4).
function guideVerdictEnvelope(verdict: number, sequence = 9) {
  const buffer = new ArrayBuffer(GUIDE_FIXED_HEADER_LEN);
  const view = new DataView(buffer);
  view.setUint32(0, GUIDE_MAGIC, true);
  view.setUint16(4, GUIDE_PROTOCOL_VERSION, true);
  view.setUint8(6, verdict);
  for (let index = 0; index < 16; index += 1) view.setUint8(7 + index, index + 1);
  view.setBigUint64(23, 7n, true);
  view.setUint32(31, sequence, true);
  view.setUint32(35, GUIDE_FIXED_HEADER_LEN, true);
  view.setUint32(39, 0, true);
  return buffer;
}

function captureCallsWithForce(force: boolean) {
  return mocks.invoke.mock.calls.filter(
    ([command, args]) =>
      command === "capture_guide_frame" &&
      (args as { force?: boolean } | undefined)?.force === force,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class FakeRoom {
  handlers = new Map<RoomEvent, Set<(...args: never[]) => void>>();
  remoteParticipants = new Map([
    ["agent", { isAgent: true, isLocal: false, identity: "agent" }],
  ]);
  publishData = vi.fn((_data: Uint8Array, _options: { reliable: boolean; topic: string }) =>
    Promise.resolve(),
  );
  write = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
  streamBytes = vi.fn((_options: { attributes: Record<string, string> }) =>
    Promise.resolve({ write: this.write, close: this.close }),
  );
  localParticipant = {
    publishData: this.publishData,
    streamBytes: this.streamBytes,
  };

  on(event: RoomEvent, handler: (...args: never[]) => void) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return this;
  }

  off(event: RoomEvent, handler: (...args: never[]) => void) {
    this.handlers.get(event)?.delete(handler);
    return this;
  }

  emit(event: RoomEvent, ...args: unknown[]) {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (...eventArgs: unknown[]) => void)(...args);
    }
  }
}

let renderer: ReactTestRenderer | null = null;
let room: FakeRoom;
let captureResult: ArrayBuffer | Promise<ArrayBuffer>;
let ackDirty = false;
let hookStatus: VoiceSessionStatus;
let onPoint: ReturnType<typeof vi.fn>;
let hookArmed = false;
let hookActive = false;

function Harness() {
  const guide = useGuideMode({
    room: room as never,
    status: hookStatus,
    signedIn: true,
    onPoint,
  });
  hookArmed = guide.armed;
  hookActive = guide.active;
  return null;
}

async function acknowledgeLatestMode() {
  const call = [...room.publishData.mock.calls]
    .reverse()
    .find(([data]) => {
      const decoded = JSON.parse(new TextDecoder().decode(data));
      return decoded.type === "guide.mode" && decoded.active === true;
    });
  if (!call) return false;
  const control = JSON.parse(new TextDecoder().decode(call[0]));
  const agent = room.remoteParticipants.get("agent");
  room.emit(
    RoomEvent.DataReceived,
    new TextEncoder().encode(JSON.stringify({
      type: "guide.mode_ack",
      payload: {
        active: true,
        generation: control.generation,
        guide_session_id: control.guide_session_id,
        protocol_version: 2,
        reason: null,
      },
    })),
    agent,
    undefined,
    "agent_events",
  );
  await Promise.resolve();
  await Promise.resolve();
  return true;
}

async function mountHook(acknowledge = true) {
  await act(async () => {
    renderer = create(<Harness />);
    for (let index = 0; index < 20 && room.publishData.mock.calls.length === 0; index += 1) {
      await Promise.resolve();
    }
  });
  if (!acknowledge) return;
  await act(async () => {
    await acknowledgeLatestMode();
    await vi.advanceTimersByTimeAsync(0);
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

function guideStep(frameId = `${SESSION_ID}:9`) {
  return new TextEncoder().encode(JSON.stringify({
    type: "guide.step",
    payload: {
      frame_id: frameId,
      frame_seq: 9,
      step_index: 1,
      instruction: "Click Settings",
    },
  }));
}

beforeEach(() => {
  vi.useFakeTimers();
  room = new FakeRoom();
  captureResult = guideEnvelope();
  ackDirty = false;
  hookStatus = "listening";
  onPoint = vi.fn(async () => {});
  hookArmed = false;
  hookActive = false;
  mocks.guideListener = null;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "guide_armed_state") {
      return Promise.resolve({ armed: true, epoch: 7, sessionId: SESSION_ID });
    }
    if (command === "capture_guide_frame") return Promise.resolve(captureResult);
    if (command === "ack_guide_response") return Promise.resolve(ackDirty);
    if (command === "guide_observation_state") {
      return Promise.resolve({
        activeProcess: "Code",
        activeWindowId: "window-1",
        activeWindowTitle: "Aura",
        geometryRevision: 1,
      });
    }
    return Promise.resolve();
  });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("useGuideMode", () => {
  it("does not let an older native snapshot overwrite a newer armed event", async () => {
    const initialState = deferred<{
      armed: boolean;
      epoch: number;
      sessionId: string | null;
    }>();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "guide_armed_state") return initialState.promise;
      return Promise.resolve();
    });

    await mountHook();
    await act(async () => {
      mocks.guideListener?.({
        payload: { armed: true, epoch: 8, sessionId: SESSION_ID },
      });
      await Promise.resolve();
    });
    expect(hookArmed).toBe(true);

    await act(async () => {
      initialState.resolve({ armed: false, epoch: 7, sessionId: null });
      await Promise.resolve();
    });
    expect(hookArmed).toBe(true);
  });

  function emitGuideRequest(enable: unknown) {
    const agent = room.remoteParticipants.get("agent");
    room.emit(
      RoomEvent.DataReceived,
      new TextEncoder().encode(JSON.stringify({ type: "guide.request", payload: { enable } })),
      agent,
      undefined,
      undefined,
    );
  }

  it("arms Guide Mode natively when the agent requests enable", async () => {
    // Mount disarmed so an enable request is not a no-op.
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "guide_armed_state") {
        return Promise.resolve({ armed: false, epoch: 7, sessionId: null });
      }
      return Promise.resolve();
    });
    await mountHook(false);
    expect(hookArmed).toBe(false);

    await act(async () => {
      emitGuideRequest(true);
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("arm_guide");
    expect(mocks.invoke).not.toHaveBeenCalledWith("disarm_guide");
  });

  it("disarms Guide Mode natively when the agent requests disable", async () => {
    await mountHook(false); // default mock mounts armed
    expect(hookArmed).toBe(true);
    const disarmBefore = mocks.invoke.mock.calls.filter(([c]) => c === "disarm_guide").length;

    await act(async () => {
      emitGuideRequest(false);
      await Promise.resolve();
    });
    expect(
      mocks.invoke.mock.calls.filter(([c]) => c === "disarm_guide").length,
    ).toBe(disarmBefore + 1);
  });

  it("ignores a guide.request matching the current state or carrying a bad payload", async () => {
    await mountHook(false); // armed
    expect(hookArmed).toBe(true);
    const armBefore = mocks.invoke.mock.calls.filter(([c]) => c === "arm_guide").length;
    const disarmBefore = mocks.invoke.mock.calls.filter(([c]) => c === "disarm_guide").length;

    await act(async () => {
      emitGuideRequest(true); // enable while already armed -> no-op
      emitGuideRequest("yes"); // non-boolean -> rejected by the validator
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "arm_guide").length).toBe(armBefore);
    expect(mocks.invoke.mock.calls.filter(([c]) => c === "disarm_guide").length).toBe(disarmBefore);
  });

  it("seeds immediately, allows one capture in flight, and skips missed intervals", async () => {
    const capture = deferred<ArrayBuffer>();
    captureResult = capture.promise;
    await mountHook();

    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(1);

    await act(async () => {
      capture.resolve(guideEnvelope());
      await Promise.resolve();
    });
    await act(async () => {
      // The tick continuation may register its setTimeout re-arm after the
      // clock has already moved on a slow runner, leaving the timer just past
      // a single advance. Advance again only while the second capture hasn't
      // fired, so the green path stays byte-identical to one plain advance.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        await vi.advanceTimersByTimeAsync(750);
        if (
          mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame").length > 1
        ) break;
      }
    });
    expect(
      mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame").length,
    ).toBeGreaterThan(1);
  });

  it("retries the retained response once, then releases it without showing recovery UI", async () => {
    await mountHook();
    await act(async () => {
      for (
        let index = 0;
        index < 20 &&
        !mocks.invoke.mock.calls.some(([command]) => command === "commit_guide_frame");
        index += 1
      ) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    });
    expect(room.streamBytes).toHaveBeenCalledTimes(1);

    await act(async () => {
      for (let index = 0; index < 3 && room.streamBytes.mock.calls.length < 2; index += 1) {
        await vi.advanceTimersByTimeAsync(15_000);
      }
    });
    expect(room.streamBytes).toHaveBeenCalledTimes(2);
    await act(async () => {
      for (
        let index = 0;
        index < 3 &&
        !mocks.invoke.mock.calls.some(([command]) => command === "ack_guide_response");
        index += 1
      ) {
        await vi.advanceTimersByTimeAsync(15_000);
        await Promise.resolve();
      }
    });
    expect(mocks.invoke).toHaveBeenCalledWith("ack_guide_response", {
      frameId: `${SESSION_ID}:9`,
      epoch: 7,
    });
  });

  it("drops stale steps and frees retained bytes only after the matching acknowledgement", async () => {
    await mountHook();
    const agent = room.remoteParticipants.get("agent");

    await act(async () => {
      room.emit(RoomEvent.DataReceived, guideStep(`${SESSION_ID}:8`), agent, undefined, "agent_events");
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "ack_guide_response")).toHaveLength(0);

    await act(async () => {
      room.emit(RoomEvent.DataReceived, guideStep(), agent, undefined, "agent_events");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "ack_guide_response")).toHaveLength(1);
  });

  it("maps ordinary element.point events against retained Guide geometry", async () => {
    await mountHook();
    const agent = room.remoteParticipants.get("agent");
    const point = new TextEncoder().encode(JSON.stringify({
      type: "element.point",
      payload: {
        frame_id: `${SESSION_ID}:9`,
        x: 640,
        y: 360,
        label: "Settings",
      },
    }));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      room.emit(RoomEvent.DataReceived, point, agent, undefined, "agent_events");
      await Promise.resolve();
    });

    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ jpegWidthPx: 1280, jpegHeightPx: 720 }),
      expect.objectContaining({ frameId: `${SESSION_ID}:9`, x: 640, y: 360 }),
    );
  });

  it("uses hash-only ticks while awaiting, then captures fresh immediately when ack reports dirty", async () => {
    await mountHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(room.streamBytes).toHaveBeenCalledTimes(1);
    const capturesBeforeAck = mocks.invoke.mock.calls.filter(
      ([command]) => command === "capture_guide_frame",
    ).length;
    expect(capturesBeforeAck).toBeGreaterThan(1);

    ackDirty = true;
    const agent = room.remoteParticipants.get("agent");
    await act(async () => {
      room.emit(RoomEvent.DataReceived, guideStep(), agent, undefined, "agent_events");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(
      capturesBeforeAck + 1,
    );
  });

  it("retries a failed stream with the same retained frame id before committing", async () => {
    room.close.mockRejectedValueOnce(new Error("stream failed"));
    await mountHook();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(750);
      for (let index = 0; index < 20 && room.streamBytes.mock.calls.length < 2; index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(0);
      }
    });
    expect(room.streamBytes).toHaveBeenCalledTimes(2);
    expect(room.streamBytes.mock.calls[0][0].attributes.frame_id).toBe(`${SESSION_ID}:9`);
    expect(room.streamBytes.mock.calls[1][0].attributes.frame_id).toBe(`${SESSION_ID}:9`);
    const commitCalls = mocks.invoke.mock.calls.filter(
      ([command]) => command === "commit_guide_frame",
    );
    expect(commitCalls.length).toBeGreaterThanOrEqual(1);
    expect(
      commitCalls.every(([, args]) =>
        (args as { frameId?: string } | undefined)?.frameId === `${SESSION_ID}:9`
      ),
    ).toBe(true);
  });

  it("tears down timers and retained client bytes while preserving Guide across voice transport end", async () => {
    await mountHook();
    const capturesBeforeTeardown = mocks.invoke.mock.calls.filter(
      ([command]) => command === "capture_guide_frame",
    ).length;

    hookStatus = "error";
    await act(async () => {
      renderer?.update(<Harness />);
      await Promise.resolve();
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("disarm_guide");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(
      capturesBeforeTeardown,
    );
  });

  it("forces a fresh capture on the start of a local spoken turn", async () => {
    await mountHook();
    // The scheduler now force-captures every tick too, so clear its calls and
    // isolate just the spoken-turn forced captures below.
    mocks.invoke.mockClear();

    const local = { isLocal: true };
    await act(async () => {
      room.emit(RoomEvent.TranscriptionReceived, [{ final: false, text: "hi" }], local);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(captureCallsWithForce(true)).toHaveLength(1);
    // The final segment re-arms the guard; the next turn forces again.
    await act(async () => {
      room.emit(RoomEvent.TranscriptionReceived, [{ final: true, text: "hi" }], local);
      room.emit(RoomEvent.TranscriptionReceived, [{ final: false, text: "next" }], local);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(captureCallsWithForce(true)).toHaveLength(2);
  });

  it("ignores transcription from remote participants", async () => {
    await mountHook();
    mocks.invoke.mockClear();
    const agent = room.remoteParticipants.get("agent");
    await act(async () => {
      room.emit(RoomEvent.TranscriptionReceived, [{ final: false, text: "hi" }], agent);
      await Promise.resolve();
    });
    expect(captureCallsWithForce(true)).toHaveLength(0);
  });

  it("retries a forced capture exactly once when it only reseeds the baseline", async () => {
    await mountHook();
    mocks.invoke.mockClear();
    captureResult = guideVerdictEnvelope(1); // "hold": baseline seeded, no frame

    const local = { isLocal: true };
    await act(async () => {
      room.emit(RoomEvent.TranscriptionReceived, [{ final: false, text: "hi" }], local);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Initial forced capture (hold) + one retry (hold), then it stops - no loop.
    expect(captureCallsWithForce(true)).toHaveLength(2);
  });

  it("stamps change:1 on a classified change and change:0 on a forced frame", async () => {
    // Default captureResult is a "send" (verdict 2) envelope: a real change.
    await mountHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(room.streamBytes.mock.calls[0][0].attributes.change).toBe("1");
  });

  it("stamps change:0 for a forced static-screen frame (sendForced)", async () => {
    captureResult = guideEnvelope(9, 5); // "sendForced": forced, no visible change
    await mountHook();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(room.streamBytes.mock.calls[0][0].attributes.change).toBe("0");
  });

  it("becomes operational only after matching mode, task, and frame state", async () => {
    await mountHook();
    expect(hookArmed).toBe(true);
    expect(hookActive).toBe(false);
    const agent = room.remoteParticipants.get("agent");

    await act(async () => {
      room.emit(
        RoomEvent.DataReceived,
        new TextEncoder().encode(JSON.stringify({
          type: "guide.task",
          payload: {
            guide_session_id: SESSION_ID,
            task_id: "a".repeat(32),
            revision: 1,
            status: "active",
            current_step_id: "step-1",
            current_step_title: "First step",
            resumable: true,
            completion: false,
          },
        })),
        agent,
        undefined,
        "agent_events",
      );
      room.emit(
        RoomEvent.DataReceived,
        new TextEncoder().encode(JSON.stringify({
          type: "guide.frame_ack",
          payload: {
            frame_id: `${SESSION_ID}:9`,
            frame_seq: 9,
            accepted: true,
            rejection_reason: null,
            newest_frame_id: `${SESSION_ID}:9`,
          },
        })),
        agent,
        undefined,
        "agent_events",
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hookActive).toBe(true);
  });

  it("publishes guide.mode after the agent joins and again after reconnect", async () => {
    room.remoteParticipants.clear();
    await mountHook();
    expect(room.publishData).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(0);

    const agent = { isAgent: true, isLocal: false, identity: "agent" };
    room.remoteParticipants.set("agent", agent);
    await act(async () => {
      room.emit(RoomEvent.ParticipantConnected, agent);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await acknowledgeLatestMode();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(room.publishData).toHaveBeenCalledTimes(1);
    expect(room.publishData.mock.calls[0][1]).toEqual({ reliable: true, topic: "client_events" });
    expect(JSON.parse(new TextDecoder().decode(room.publishData.mock.calls[0][0]))).toMatchObject({
      type: "guide.mode",
      active: true,
      guide_session_id: SESSION_ID,
    });
    expect(captureCallsWithForce(true)).toHaveLength(1);
    expect(room.streamBytes).toHaveBeenCalledTimes(1);

    await act(async () => {
      room.emit(RoomEvent.Reconnected);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(room.publishData).toHaveBeenCalledTimes(2);
  });
});
