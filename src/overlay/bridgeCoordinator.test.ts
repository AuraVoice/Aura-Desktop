import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeCoordinator } from "./bridgeCoordinator";
import type { RealtimeLeg } from "../lib/realtime";

vi.mock("livekit-client", () => ({
  Track: { Source: { Microphone: "microphone" } },
}));
vi.mock("../lib/log", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

function harness(safeBoundary = true) {
  let safe = safeBoundary;
  const published: Record<string, unknown>[] = [];
  const room = {
    localParticipant: {
      publishData: vi.fn(async (data: Uint8Array) => {
        published.push(JSON.parse(new TextDecoder().decode(data)));
      }),
      publishTrack: vi.fn(async () => ({})),
    },
  };
  const realtime: RealtimeLeg = {
    transcript: () => [
      { role: "user", text: "What should I do next?" },
      { role: "assistant", text: "Finish the current step first." },
    ],
    hasSpoken: () => true,
    atSafeBoundary: () => safe,
    close: vi.fn(),
  };
  const agentTrack = {
    attach: vi.fn(),
    detach: vi.fn(),
  };
  const audioEl = {
    play: vi.fn(async () => {}),
  };
  const onFatal = vi.fn();
  const onActive = vi.fn();
  const coordinator = new BridgeCoordinator({
    room: room as never,
    realtime,
    sharedTrack: { stop: vi.fn() } as unknown as MediaStreamTrack,
    liveKitAudioEl: audioEl as unknown as HTMLAudioElement,
    onFatal,
    onActive,
  });
  coordinator.attachAgentAudio(agentTrack as never);
  return {
    coordinator,
    published,
    room,
    realtime,
    agentTrack,
    onFatal,
    onActive,
    setSafe: (value: boolean) => {
      safe = value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BridgeCoordinator", () => {
  it("fails once when a born LiveKit agent never emits hold_ready", async () => {
    vi.useFakeTimers();
    const { coordinator, onFatal } = harness();

    coordinator.onAgentReady();
    coordinator.onAgentReady();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(String(onFatal.mock.calls[0][0])).toContain("hold_ready timed out");
    coordinator.teardown();
  });

  it("waits for the final Realtime message before sending the transcript", async () => {
    vi.useFakeTimers();
    const { coordinator, published, realtime, setSafe } = harness(false);

    coordinator.onAgentReady();
    coordinator.handleDataMessage({ type: "hold_ready" });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(published.some((message) => message.type === "handover_begin")).toBe(false);
    expect(realtime.close).not.toHaveBeenCalled();

    setSafe(true);
    await vi.advanceTimersByTimeAsync(150);

    const handover = published.find((message) => message.type === "handover_begin");
    expect(handover?.turns).toEqual(realtime.transcript());
    expect(realtime.close).not.toHaveBeenCalled();
    coordinator.teardown();
  });

  it("moves audio and microphone ownership only after matching handover_applied", async () => {
    vi.useFakeTimers();
    const {
      coordinator,
      published,
      room,
      realtime,
      agentTrack,
      onActive,
    } = harness(true);

    coordinator.handleDataMessage({ type: "hold_ready" });
    const handover = published.find((message) => message.type === "handover_begin");
    const handoverId = String(handover?.handover_id);

    coordinator.handleDataMessage({ type: "handover_applied", handover_id: "wrong" });
    expect(room.localParticipant.publishTrack).not.toHaveBeenCalled();
    expect(realtime.close).not.toHaveBeenCalled();

    coordinator.handleDataMessage({ type: "handover_applied", handover_id: handoverId });
    await vi.runAllTimersAsync();

    expect(room.localParticipant.publishTrack).toHaveBeenCalledTimes(1);
    expect(agentTrack.attach).toHaveBeenCalledTimes(1);
    expect(realtime.close).toHaveBeenCalledTimes(1);
    expect(onActive).toHaveBeenCalledTimes(1);
    coordinator.teardown();
  });

  it("fails instead of forcing a handover across a stuck speaking boundary", async () => {
    vi.useFakeTimers();
    const { coordinator, published, onFatal } = harness(false);

    coordinator.handleDataMessage({ type: "hold_ready" });
    await vi.advanceTimersByTimeAsync(30_100);

    expect(published.some((message) => message.type === "handover_begin")).toBe(false);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(String(onFatal.mock.calls[0][0])).toContain("safe boundary timed out");
    coordinator.teardown();
  });
});
