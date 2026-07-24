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
    startSession: vi.fn(async () => {}),
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
  barVisible = false,
}: {
  voice: ReturnType<typeof useVoiceBar>;
  barVisible?: boolean;
}) {
  useNotchGesture(true, voice, false, barVisible);
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
  it("does not start voice until summon_bar confirms the notch is visible", async () => {
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
    // Pre-dispatch fires the transport (token + connect + agent dispatch)
    // immediately, but the microphone stays closed until the notch is visible.
    expect(voice.prepareSession).toHaveBeenCalledTimes(1);
    expect(voice.activateSession).not.toHaveBeenCalled();

    await act(async () => summon.resolve());
    expect(voice.activateSession).toHaveBeenCalledTimes(1);
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
      renderer = create(<Harness voice={voice} barVisible />);
    });

    await act(async () => mocks.toggleListener?.({ payload: { sequence: 1 } }));

    expect(mocks.invoke).toHaveBeenCalledWith("dismiss_bar");
    expect(mocks.invoke).not.toHaveBeenCalledWith("summon_bar");
    expect(voice.prepareSession).not.toHaveBeenCalled();
    expect(voice.activateSession).not.toHaveBeenCalled();
    expect(voice.endSession).toHaveBeenCalledTimes(1);
  });
});
