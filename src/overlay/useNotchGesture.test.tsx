import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { useVoiceBar } from "./useVoiceBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface ToggleEvent {
  payload: { sequence: number; emittedAtMs?: number };
}

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  toggleListener: null as ((event: ToggleEvent) => void) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, callback: (payload: ToggleEvent) => void) => {
    if (event === "aura-toggle") mocks.toggleListener = callback;
    return Promise.resolve(() => {});
  }),
}));
vi.mock("../lib/log", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

import { useNotchGesture } from "./useNotchGesture";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function voiceState(
  overrides: Partial<ReturnType<typeof useVoiceBar>> = {},
): ReturnType<typeof useVoiceBar> {
  return {
    status: "disconnected",
    assistantCaption: "",
    errorMessage: null,
    showMicSettingsHint: false,
    isVoiceCapped: false,
    desiredActive: false,
    realtimeActivity: null,
    realtimeVisualizerTrack: null,
    startSession: vi.fn(async () => {}),
    startBridgedSession: vi.fn(async () => {}),
    prepareSession: vi.fn(() => Promise.resolve()),
    activateSession: vi.fn(async () => {}),
    noteTapTimestamp: vi.fn(),
    endSession: vi.fn(async () => {}),
    toggleSession: vi.fn(),
    room: null,
    sessionMode: "standard",
    ...overrides,
  };
}

function Harness({
  voice,
  overlayVisible = false,
}: {
  voice: ReturnType<typeof useVoiceBar>;
  overlayVisible?: boolean;
}) {
  useNotchGesture(true, voice, false, overlayVisible);
  return null;
}

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  mocks.toggleListener = null;
  mocks.invoke.mockImplementation((command: string) => {
    if (command === "voice_toggle_key_status") {
      return Promise.resolve({ available: true, keyLabel: "Left Ctrl" });
    }
    return Promise.resolve();
  });
});

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

describe("useNotchGesture visible-before-voice ordering", () => {
  it("starts the bridged session immediately and never calls activateSession", async () => {
    const summon = deferred<void>();
    const voice = voiceState();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "voice_toggle_key_status") {
        return Promise.resolve({ available: true, keyLabel: "Left Ctrl" });
      }
      if (command === "summon_bar") return summon.promise;
      return Promise.resolve();
    });
    await act(async () => {
      renderer = create(<Harness voice={voice} />);
    });

    act(() => mocks.toggleListener?.({ payload: { sequence: 1 } }));
    // The bridged start fires immediately (the instant Realtime leg + LiveKit warm run in
    // parallel). The bridge coordinator owns the microphone - Realtime now, LiveKit at
    // handover - so the gesture never calls activateSession, before or after summon_bar.
    expect(voice.startBridgedSession).toHaveBeenCalledTimes(1);
    expect(voice.activateSession).not.toHaveBeenCalled();

    await act(async () => summon.resolve());
    expect(voice.activateSession).not.toHaveBeenCalled();
  });

  it("does not start voice when native notch presentation fails", async () => {
    const voice = voiceState();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "voice_toggle_key_status") {
        return Promise.resolve({ available: true, keyLabel: "Left Ctrl" });
      }
      if (command === "summon_bar") return Promise.reject(new Error("show failed"));
      return Promise.resolve();
    });
    await act(async () => {
      renderer = create(<Harness voice={voice} />);
    });

    await act(async () => mocks.toggleListener?.({ payload: { sequence: 1 } }));
    // The mic never opens, and any pre-dispatched transport is torn down so an
    // invisible call cannot keep running.
    expect(voice.activateSession).not.toHaveBeenCalled();
    expect(voice.endSession).toHaveBeenCalled();
  });

  it("keeps a stop toggle from being resurrected by a late summon", async () => {
    const summon = deferred<void>();
    const voice = voiceState();
    mocks.invoke.mockImplementation((command: string) => {
      if (command === "voice_toggle_key_status") {
        return Promise.resolve({ available: true, keyLabel: "Left Ctrl" });
      }
      if (command === "summon_bar") return summon.promise;
      return Promise.resolve();
    });
    await act(async () => {
      renderer = create(<Harness voice={voice} />);
    });

    act(() => {
      mocks.toggleListener?.({ payload: { sequence: 1 } });
      mocks.toggleListener?.({ payload: { sequence: 2 } });
    });
    expect(voice.endSession).toHaveBeenCalledTimes(1);

    await act(async () => summon.resolve());
    expect(voice.activateSession).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("dismiss_bar");
  });

  it("dismisses a visible bar even when no voice session is active", async () => {
    // The bar stays on screen for ended/error/voice-capped states, where
    // desiredActive is already false. A double-tap there must close the bar,
    // not re-summon or restart a call.
    const voice = voiceState({ status: "ended", desiredActive: false });
    await act(async () => {
      renderer = create(<Harness voice={voice} overlayVisible />);
    });

    await act(async () => mocks.toggleListener?.({ payload: { sequence: 1 } }));

    expect(mocks.invoke).toHaveBeenCalledWith("dismiss_bar");
    expect(mocks.invoke).not.toHaveBeenCalledWith("summon_bar");
    expect(voice.prepareSession).not.toHaveBeenCalled();
    expect(voice.activateSession).not.toHaveBeenCalled();
    expect(voice.endSession).toHaveBeenCalledTimes(1);
  });

  it("dismisses any visible non-bar surface (pill/moving notch) without restarting a call", async () => {
    // OverlayRoot maps the minimized-call pill and the drag-mode moving notch
    // into overlayVisible too, so a double-tap over either must close, never
    // re-enter the summon branch. Here the session already ended (desiredActive
    // false) but a surface is still on screen - the pre-fix gap that restarted a
    // call. It must take the dismiss branch off overlayVisible alone.
    const voice = voiceState({ status: "ended", desiredActive: false });
    await act(async () => {
      renderer = create(<Harness voice={voice} overlayVisible />);
    });

    await act(async () => mocks.toggleListener?.({ payload: { sequence: 1 } }));

    expect(mocks.invoke).toHaveBeenCalledWith("dismiss_bar");
    expect(mocks.invoke).not.toHaveBeenCalledWith("summon_bar");
    expect(voice.prepareSession).not.toHaveBeenCalled();
  });
});
