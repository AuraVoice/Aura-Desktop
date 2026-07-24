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

function Harness() {
  useGuideMode({
    room: room as never,
    status: hookStatus,
    signedIn: true,
    onPoint,
  });
  return null;
}

async function mountHook() {
  await act(async () => {
    renderer = create(<Harness />);
    await Promise.resolve();
    await Promise.resolve();
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
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "guide_armed_state") {
      return Promise.resolve({ armed: true, epoch: 7, session_id: SESSION_ID });
    }
    if (command === "capture_guide_frame") return Promise.resolve(captureResult);
    if (command === "ack_guide_response") return Promise.resolve(ackDirty);
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
      await vi.advanceTimersByTimeAsync(1_999);
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(2);
  });

  it("retries the retained response once, then releases it without showing recovery UI", async () => {
    await mountHook();
    expect(room.streamBytes).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(room.streamBytes).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await Promise.resolve();
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
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(2);

    ackDirty = true;
    const agent = room.remoteParticipants.get("agent");
    await act(async () => {
      room.emit(RoomEvent.DataReceived, guideStep(), agent, undefined, "agent_events");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(3);
  });

  it("retries a failed stream with the same retained frame id before committing", async () => {
    room.close.mockRejectedValueOnce(new Error("stream failed"));
    await mountHook();
    expect(room.streamBytes).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "commit_guide_frame")).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(room.streamBytes).toHaveBeenCalledTimes(2);
    expect(room.streamBytes.mock.calls[0][0].attributes.frame_id).toBe(`${SESSION_ID}:9`);
    expect(room.streamBytes.mock.calls[1][0].attributes.frame_id).toBe(`${SESSION_ID}:9`);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "commit_guide_frame")).toHaveLength(1);
  });

  it("tears down timers and retained client bytes on a terminal voice status", async () => {
    await mountHook();
    const capturesBeforeTeardown = mocks.invoke.mock.calls.filter(
      ([command]) => command === "capture_guide_frame",
    ).length;

    hookStatus = "error";
    await act(async () => {
      renderer?.update(<Harness />);
      await Promise.resolve();
    });
    expect(mocks.invoke).toHaveBeenCalledWith("disarm_guide");
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
    expect(room.streamBytes.mock.calls[0][0].attributes.change).toBe("1");
  });

  it("stamps change:0 for a forced static-screen frame (sendForced)", async () => {
    captureResult = guideEnvelope(9, 5); // "sendForced": forced, no visible change
    await mountHook();
    expect(room.streamBytes.mock.calls[0][0].attributes.change).toBe("0");
  });

  it("publishes guide.mode after the agent joins and again after reconnect", async () => {
    room.remoteParticipants.clear();
    await mountHook();
    expect(room.publishData).not.toHaveBeenCalled();

    const agent = { isAgent: true, isLocal: false, identity: "agent" };
    room.remoteParticipants.set("agent", agent);
    await act(async () => {
      room.emit(RoomEvent.ParticipantConnected, agent);
      await Promise.resolve();
    });
    expect(room.publishData).toHaveBeenCalledTimes(1);
    expect(room.publishData.mock.calls[0][1]).toEqual({ reliable: true, topic: "client_events" });
    expect(JSON.parse(new TextDecoder().decode(room.publishData.mock.calls[0][0]))).toMatchObject({
      type: "guide.mode",
      active: true,
      guide_session_id: SESSION_ID,
    });

    await act(async () => {
      room.emit(RoomEvent.Reconnected);
      await Promise.resolve();
    });
    expect(room.publishData).toHaveBeenCalledTimes(2);
  });
});
