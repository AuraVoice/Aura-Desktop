import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => {
  const roomEvents = {
    AudioPlaybackStatusChanged: "AudioPlaybackStatusChanged",
    ConnectionStateChanged: "ConnectionStateChanged",
    DataReceived: "DataReceived",
    Disconnected: "Disconnected",
    LocalTrackPublished: "LocalTrackPublished",
    MediaDevicesError: "MediaDevicesError",
    ParticipantAttributesChanged: "ParticipantAttributesChanged",
    ParticipantConnected: "ParticipantConnected",
    ParticipantDisconnected: "ParticipantDisconnected",
    TrackSubscribed: "TrackSubscribed",
    TrackSubscriptionFailed: "TrackSubscriptionFailed",
    TrackUnsubscribed: "TrackUnsubscribed",
    TranscriptionReceived: "TranscriptionReceived",
  };

  class FakeRoom {
    static instances: FakeRoom[] = [];
    handlers = new Map<string, (...args: any[]) => void>();
    connect = vi.fn(async () => {});
    disconnect = vi.fn(async () => {});
    startAudio = vi.fn(async () => {});
    canPlaybackAudio = true;
    remoteParticipants = new Map();
    localParticipant = {
      setMicrophoneEnabled: vi.fn<(active: boolean) => Promise<any>>(async () => ({
        track: { mediaStreamTrack: { readyState: "live", enabled: true } },
        isMuted: false,
      })),
    };

    constructor() {
      FakeRoom.instances.push(this);
    }

    on(event: string, handler: (...args: any[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }
  }

  return {
    FakeRoom,
    roomEvents,
    fetchVoiceToken: vi.fn(),
    invoke: vi.fn(async () => {}),
  };
});

vi.mock("livekit-client", () => ({
  Room: mocks.FakeRoom,
  RoomEvent: mocks.roomEvents,
  Track: { Kind: { Audio: "audio" } },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/voice", () => ({
  fetchVoiceToken: mocks.fetchVoiceToken,
  VoiceCapError: class VoiceCapError extends Error {},
}));
vi.mock("../lib/api", () => ({
  AuthRequiredError: class AuthRequiredError extends Error {},
  routeToDashboardForExpiredSession: vi.fn(async () => {}),
}));
vi.mock("../lib/agentData", () => ({
  validateAgentDataMessage: vi.fn(() => ({ kind: "rejected" })),
}));
vi.mock("../lib/log", () => ({ logError: vi.fn(), logInfo: vi.fn() }));
vi.mock("../lib/analytics", () => ({ trackEvent: vi.fn() }));

import { useVoiceBar, type VoiceBarState } from "./useVoiceBar";

let renderer: ReactTestRenderer | null = null;
let voice: VoiceBarState | null = null;

function Harness() {
  voice = useVoiceBar();
  return null;
}

beforeEach(async () => {
  mocks.FakeRoom.instances.length = 0;
  mocks.invoke.mockClear();
  mocks.fetchVoiceToken.mockReset();
  voice = null;
  await act(async () => {
    renderer = create(<Harness />);
  });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

const token = { token: "token", url: "wss://livekit.test", room: "voice-room" };

describe("useVoiceBar cancellation boundaries", () => {
  it("does not connect if the user stops while the token request is pending", async () => {
    const tokenRequest = deferred<typeof token>();
    mocks.fetchVoiceToken.mockReturnValue(tokenRequest.promise);

    let startPromise: Promise<void> | undefined;
    act(() => {
      startPromise = voice?.startSession();
    });
    await vi.waitFor(() => expect(mocks.fetchVoiceToken).toHaveBeenCalledTimes(1));
    const room = mocks.FakeRoom.instances[0];

    await act(async () => {
      await voice?.endSession();
      tokenRequest.resolve(token);
      await startPromise;
    });
    await vi.waitFor(() => expect(room.disconnect).toHaveBeenCalled());

    expect(room.connect).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("set_voice_active", { active: false });
  });

  it("does not enable the microphone if the user stops while connect is pending", async () => {
    const connecting = deferred<void>();
    mocks.fetchVoiceToken.mockResolvedValue(token);

    let startPromise: Promise<void> | undefined;
    act(() => {
      startPromise = voice?.startSession();
    });
    const room = await vi.waitFor(() => {
      const current = mocks.FakeRoom.instances[0];
      expect(current).toBeDefined();
      current.connect.mockReturnValue(connecting.promise);
      return current;
    });
    await vi.waitFor(() => expect(room.connect).toHaveBeenCalled());

    await act(async () => {
      await voice?.endSession();
      connecting.resolve();
      await startPromise;
    });
    await vi.waitFor(() => expect(room.disconnect).toHaveBeenCalled());

    expect(room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
  });

  it("disables a late microphone enable after the user stops", async () => {
    const microphone = deferred<{
      track: { mediaStreamTrack: { readyState: string; enabled: boolean } };
      isMuted: boolean;
    }>();
    const tokenRequest = deferred<typeof token>();
    mocks.fetchVoiceToken.mockReturnValue(tokenRequest.promise);

    let startPromise: Promise<void> | undefined;
    act(() => {
      startPromise = voice?.startSession();
    });
    const room = mocks.FakeRoom.instances[0];
    room.localParticipant.setMicrophoneEnabled.mockImplementation((active: boolean) => {
      if (active) return microphone.promise;
      return Promise.resolve(undefined);
    });
    await act(async () => {
      tokenRequest.resolve(token);
      await vi.waitFor(() => {
        expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);
      });
    });

    await act(async () => {
      await voice?.endSession();
      microphone.resolve({
        track: { mediaStreamTrack: { readyState: "live", enabled: true } },
        isMuted: false,
      });
      await startPromise;
    });
    await vi.waitFor(() => {
      expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    });

    expect(room.disconnect).toHaveBeenCalled();
    expect(voice?.desiredActive).toBe(false);
  });

  it("preserves Guide mode across an automatic retry", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchVoiceToken
        .mockRejectedValueOnce(new Error("temporary"))
        .mockResolvedValueOnce(token);

      await act(async () => {
        await voice?.startSession("guide");
      });
      expect(mocks.fetchVoiceToken).toHaveBeenNthCalledWith(1, "guide");

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      expect(mocks.fetchVoiceToken).toHaveBeenNthCalledWith(2, "guide");
    } finally {
      vi.useRealTimers();
    }
  });
});
