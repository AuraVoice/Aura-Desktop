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

type GuideValue = ReturnType<typeof useGuideMode>;
let renderer: ReactTestRenderer | null = null;
let value: GuideValue | null = null;
let room: FakeRoom;
let captureResult: ArrayBuffer | Promise<ArrayBuffer>;
let ackDirty = false;
let hookStatus: VoiceSessionStatus;

function Harness() {
  value = useGuideMode({
    room: room as never,
    status: hookStatus,
    signedIn: true,
    startSession: vi.fn(async () => {}),
    onPoint: vi.fn(async () => {}),
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
  value = null;
  captureResult = guideEnvelope();
  ackDirty = false;
  hookStatus = "listening";
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "guide_armed_state") {
      return Promise.resolve({ armed: true, epoch: 7, sessionId: SESSION_ID });
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

  it("retries the retained response once, then exposes Still checking", async () => {
    await mountHook();
    expect(room.streamBytes).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(room.streamBytes).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(room.streamBytes).toHaveBeenCalledTimes(2);
    expect(value?.stillChecking).toBe(true);
  });

  it("drops stale steps and frees retained bytes only after the matching acknowledgement", async () => {
    await mountHook();
    expect(value?.awaitingFrameId).toBe(`${SESSION_ID}:9`);
    const agent = room.remoteParticipants.get("agent");

    await act(async () => {
      room.emit(RoomEvent.DataReceived, guideStep(`${SESSION_ID}:8`), agent, undefined, "agent_events");
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "ack_guide_response")).toHaveLength(0);
    expect(value?.step).toBe(null);

    await act(async () => {
      room.emit(RoomEvent.DataReceived, guideStep(), agent, undefined, "agent_events");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "ack_guide_response")).toHaveLength(1);
    expect(value?.awaitingFrameId).toBe(null);
    expect(value?.step?.instruction).toBe("Click Settings");
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
    expect(value?.awaitingFrameId).toBe(`${SESSION_ID}:9`);
    const capturesBeforeTeardown = mocks.invoke.mock.calls.filter(
      ([command]) => command === "capture_guide_frame",
    ).length;

    hookStatus = "error";
    await act(async () => {
      renderer?.update(<Harness />);
      await Promise.resolve();
    });
    expect(value?.awaitingFrameId).toBe(null);
    expect(mocks.invoke).toHaveBeenCalledWith("disarm_guide");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_guide_frame")).toHaveLength(
      capturesBeforeTeardown,
    );
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

    await act(async () => {
      room.emit(RoomEvent.Reconnected);
      await Promise.resolve();
    });
    expect(room.publishData).toHaveBeenCalledTimes(2);
  });
});
