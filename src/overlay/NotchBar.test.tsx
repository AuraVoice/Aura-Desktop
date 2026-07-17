import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import type { Room } from "livekit-client";

vi.mock("./useAudioLevels", () => ({ useAudioLevels: vi.fn() }));

import { NotchBar } from "./NotchBar";
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

describe("NotchBar status copy", () => {
  it("renders a capture or shortcut notice when there is no voice error", () => {
    const html = renderToStaticMarkup(
      <NotchBar voice={voiceState()} notice="Couldn't capture this turn." />,
    );

    expect(html).toContain("Couldn&#x27;t capture this turn.");
    expect(html).not.toContain("Assistant caption");
    expect(html).toContain('aria-live="polite"');
  });

  it("gives the actionable voice error priority over notices and captions", () => {
    const html = renderToStaticMarkup(
      <NotchBar
        voice={voiceState({ errorMessage: "Microphone access is blocked." })}
        notice="Shortcut unavailable"
      />,
    );

    expect(html).toContain("Microphone access is blocked.");
    expect(html).not.toContain("Shortcut unavailable");
    expect(html).not.toContain("Assistant caption");
  });
});
