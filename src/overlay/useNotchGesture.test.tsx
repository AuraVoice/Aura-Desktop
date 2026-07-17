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
    endSession: vi.fn(async () => {}),
    toggleSession: vi.fn(),
    room: null,
    ...overrides,
  };
}

function Harness({ voice }: { voice: ReturnType<typeof useVoiceBar> }) {
  useNotchGesture(true, voice, false);
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
    expect(voice.startSession).not.toHaveBeenCalled();

    await act(async () => summon.resolve());
    expect(voice.startSession).toHaveBeenCalledTimes(1);
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
    expect(voice.startSession).not.toHaveBeenCalled();
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
    expect(voice.startSession).not.toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("dismiss_bar");
  });
});
