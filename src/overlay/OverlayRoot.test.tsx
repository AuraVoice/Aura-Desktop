import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("window", {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

const mocks = vi.hoisted(() => ({
  useMeetings: vi.fn(),
  useMeetingArm: vi.fn(),
  useMeetingCapture: vi.fn(),
}));

vi.mock("../state/AuthProvider", () => ({
  useAuth: () => ({ user: { uid: "user-1" } }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve()) }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
vi.mock("./useVoiceBar", () => ({
  useVoiceBar: () => ({
    status: "disconnected",
    assistantCaption: "",
    errorMessage: null,
    showMicSettingsHint: false,
    isVoiceCapped: false,
    desiredActive: false,
    startSession: vi.fn(),
    endSession: vi.fn(() => Promise.resolve()),
    toggleSession: vi.fn(),
    room: null,
  }),
}));
vi.mock("./useNotchGesture", () => ({
  useNotchGesture: () => ({ available: true, keyLabel: "Left Ctrl", checking: false }),
}));
vi.mock("./useTurnScreenCapture", () => ({
  useTurnScreenCapture: () => ({ notice: null }),
}));
vi.mock("./useDraftCard", () => ({
  useDraftCard: () => ({ phase: "idle", reset: vi.fn() }),
}));
vi.mock("./useUpdateReady", () => ({ useUpdateReady: vi.fn() }));
vi.mock("./useMeetings", () => ({ useMeetings: mocks.useMeetings }));
vi.mock("./useMeetingArm", () => ({ useMeetingArm: mocks.useMeetingArm }));
vi.mock("./useMeetingCapture", () => ({ useMeetingCapture: mocks.useMeetingCapture }));
vi.mock("./NotchBar", () => ({ NotchBar: () => <div>notch</div> }));
vi.mock("./DraftCard", () => ({ DraftCard: () => <div>draft</div> }));

import { OverlayRoot } from "./OverlayRoot";

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

describe("OverlayRoot meeting background services", () => {
  it("mounts calendar, saved arm state, capture, and restart recovery without auto-summoning UI", () => {
    const event = {
      id: "event-1",
      title: "Planning",
      startTime: "2026-07-17T10:00:00Z",
      endTime: "2026-07-17T10:30:00Z",
      meetingLink: "https://zoom.us/j/1",
    };
    const isArmed = vi.fn(() => true);
    mocks.useMeetings.mockReturnValue({ events: [event] });
    mocks.useMeetingArm.mockReturnValue({ isArmed, revision: 4 });
    mocks.useMeetingCapture.mockReturnValue({});

    act(() => {
      renderer = create(<OverlayRoot />);
    });

    expect(mocks.useMeetings).toHaveBeenCalledWith({
      presentation: "hidden",
      signedIn: true,
      callLive: false,
      autoSummon: false,
    });
    expect(mocks.useMeetingArm).toHaveBeenCalledWith("user-1");
    expect(mocks.useMeetingCapture).toHaveBeenCalledWith({
      uid: "user-1",
      appHidden: true,
      events: [event],
      isArmed,
      armRevision: 4,
      automaticCapture: true,
    });
  });
});
