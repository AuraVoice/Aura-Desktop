import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { RoomEvent, type Room } from "livekit-client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  validate: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/agentData", () => ({
  validateAgentDataMessage: mocks.validate,
}));
vi.mock("../lib/log", () => ({ logError: vi.fn() }));

import { useTurnScreenCapture } from "./useTurnScreenCapture";

type Handler = (...args: any[]) => void;

class FakeRoom {
  handlers = new Map<string, Handler>();
  writer = {
    write: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  localParticipant = {
    streamBytes: vi.fn(async () => this.writer),
  };

  on(event: string, handler: Handler) {
    this.handlers.set(event, handler);
    return this;
  }

  off(event: string, handler: Handler) {
    if (this.handlers.get(event) === handler) this.handlers.delete(event);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.(...args);
  }
}

function capturedFrame(): ArrayBuffer {
  const buffer = new ArrayBuffer(31);
  const view = new DataView(buffer);
  view.setInt32(0, 100, true);
  view.setInt32(4, 200, true);
  view.setUint32(8, 1000, true);
  view.setUint32(12, 500, true);
  view.setFloat32(16, 2, true);
  view.setUint32(20, 500, true);
  view.setUint32(24, 250, true);
  new Uint8Array(buffer, 28).set([1, 2, 3]);
  return buffer;
}

function Harness({ room }: { room: Room | null }) {
  useTurnScreenCapture(room);
  return null;
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "capture_turn_screen_with_geometry") {
      return Promise.resolve(capturedFrame());
    }
    return Promise.resolve();
  });
  mocks.validate.mockReturnValue({
    kind: "valid",
    type: "element.point",
    payload: { x: 250, y: 125, frame_id: "f1", label: "Submit" },
  });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

async function captureFirstTurn(room: FakeRoom) {
  await act(async () => {
    room.emit(
      RoomEvent.TranscriptionReceived,
      [{ final: false }],
      { isLocal: true },
    );
  });
  await vi.waitFor(() => expect(room.localParticipant.streamBytes).toHaveBeenCalledTimes(1));
}

describe("useTurnScreenCapture room-scoped geometry", () => {
  it("uses memory-only capture and accepts an exact current-room frame id", async () => {
    const room = new FakeRoom();
    await act(async () => {
      renderer = create(<Harness room={room as unknown as Room} />);
    });

    await captureFirstTurn(room);
    // The capture command carries the turn id since structured context landed:
    // both halves of a turn's evidence are correlated by it on the backend.
    expect(mocks.invoke).toHaveBeenCalledWith("capture_turn_screen_with_geometry", {
      turnContextId: expect.any(String),
    });

    act(() => {
      room.emit(RoomEvent.DataReceived, new Uint8Array(), undefined, undefined, "agent_events");
    });
    expect(mocks.invoke).toHaveBeenCalledWith("point_at", {
      targetX: 300,
      targetY: 225,
      monitorX: 50,
      monitorY: 100,
      monitorW: 500,
      monitorH: 250,
      label: "Submit",
    });
  });

  it("rejects unknown frame ids instead of falling back to recent geometry", async () => {
    const room = new FakeRoom();
    await act(async () => {
      renderer = create(<Harness room={room as unknown as Room} />);
    });
    await captureFirstTurn(room);
    mocks.validate.mockReturnValue({
      kind: "valid",
      type: "element.point",
      payload: { x: 250, y: 125, frame_id: "unknown" },
    });

    act(() => {
      room.emit(RoomEvent.DataReceived, new Uint8Array());
    });

    expect(mocks.invoke).not.toHaveBeenCalledWith("point_at", expect.anything());
  });

  it("clears retained geometry when the LiveKit room changes", async () => {
    const roomA = new FakeRoom();
    const roomB = new FakeRoom();
    await act(async () => {
      renderer = create(<Harness room={roomA as unknown as Room} />);
    });
    await captureFirstTurn(roomA);

    await act(async () => {
      renderer?.update(<Harness room={roomB as unknown as Room} />);
    });
    act(() => {
      roomB.emit(RoomEvent.DataReceived, new Uint8Array());
    });

    expect(mocks.invoke).not.toHaveBeenCalledWith("point_at", expect.anything());
  });
});
