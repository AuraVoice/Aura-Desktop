import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import type { Room } from "livekit-client";

vi.mock("./useAudioLevels", () => ({ useAudioLevels: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("../lib/log", () => ({ logError: vi.fn(), logInfo: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { NotchBar } from "./NotchBar";
import { useNotchMove, type NotchMoveController } from "./useNotchMove";
import type { useVoiceBar } from "./useVoiceBar";

function voiceState(
  overrides: Partial<ReturnType<typeof useVoiceBar>> = {},
): ReturnType<typeof useVoiceBar> {
  return {
    status: "listening",
    assistantCaption: "Assistant caption",
    errorMessage: null,
    showMicSettingsHint: false,
    isVoiceCapped: false,
    desiredActive: true,
    startSession: async () => {},
    endSession: async () => {},
    toggleSession: () => {},
    room: null as Room | null,
    ...overrides,
  };
}

describe("NotchBar", () => {
  it("is a waveform-only pill: never renders the caption or any error text", () => {
    const html = renderToStaticMarkup(
      <NotchBar
        voice={voiceState({ errorMessage: "Microphone access is blocked." })}
        edge="top"
      />,
    );

    // The subtitle is gone: no caption, no error copy, no aria-live region.
    expect(html).not.toContain("Assistant caption");
    expect(html).not.toContain("Microphone access is blocked.");
    expect(html).not.toContain("aria-live");
    // The waveform canvas is still there.
    expect(html).toContain("notch-visualizer");
  });

  it("orients the shell to the docked edge", () => {
    for (const edge of ["top", "bottom", "left", "right"] as const) {
      const html = renderToStaticMarkup(<NotchBar voice={voiceState()} edge={edge} />);
      expect(html).toContain(`notch-shell-${edge}`);
    }
  });

  it("carries the voice status class through for styling", () => {
    const html = renderToStaticMarkup(
      <NotchBar voice={voiceState({ status: "listening" })} edge="top" />,
    );
    expect(html).toContain("notch-bar-listening");
  });
});

// The gesture handlers are plain callbacks, so render the hook through a probe
// component (server render supports useRef/useCallback) and drive them with
// synthetic pointer events. No DOM needed; setPointerCapture's absence is the
// try/catch path the hook already handles.
function captureController(enabled: boolean): NotchMoveController {
  let controller: NotchMoveController | null = null;
  function Probe() {
    controller = useNotchMove(enabled);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!controller) throw new Error("useNotchMove never rendered");
  return controller;
}

function pointerEvent(
  overrides: Partial<{ pointerId: number; button: number; clientX: number; clientY: number }> = {},
): React.PointerEvent<HTMLDivElement> {
  return {
    pointerId: 1,
    button: 0,
    clientX: 0,
    clientY: 0,
    currentTarget: {},
    ...overrides,
  } as unknown as React.PointerEvent<HTMLDivElement>;
}

describe("useNotchMove instant drag", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockClear();
  });

  it("does not begin the move under the drag threshold", () => {
    const { dragHandlers } = captureController(true);
    dragHandlers.onPointerDown?.(pointerEvent());
    dragHandlers.onPointerMove?.(pointerEvent({ clientX: 3 }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("begins the move exactly once past the threshold", () => {
    const { dragHandlers } = captureController(true);
    dragHandlers.onPointerDown?.(pointerEvent());
    dragHandlers.onPointerMove?.(pointerEvent({ clientX: 7 }));
    dragHandlers.onPointerMove?.(pointerEvent({ clientX: 40 }));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("begin_notch_move");
  });

  it("treats a plain click as a no-op", () => {
    const { dragHandlers } = captureController(true);
    dragHandlers.onPointerDown?.(pointerEvent());
    dragHandlers.onPointerUp?.(pointerEvent());
    dragHandlers.onPointerMove?.(pointerEvent({ clientX: 50 }));
    expect(invoke).not.toHaveBeenCalled();
  });

  it("ignores every pointer while disabled", () => {
    const { dragHandlers } = captureController(false);
    dragHandlers.onPointerDown?.(pointerEvent());
    dragHandlers.onPointerMove?.(pointerEvent({ clientX: 50 }));
    expect(invoke).not.toHaveBeenCalled();
  });
});
