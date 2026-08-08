import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("window", {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

const mocks = vi.hoisted(() => ({
  user: { uid: "user-1" } as { uid: string } | null,
  invoke: vi.fn(() => Promise.resolve()),
  useMeetings: vi.fn(),
  useMeetingArm: vi.fn(),
  useMeetingCapture: vi.fn(),
  useOnboardingTail: vi.fn(),
  useGuideMode: vi.fn(),
  useDraftCard: vi.fn(),
  guideStop: vi.fn(),
  startBridgedSession: vi.fn(() => Promise.resolve()),
}));

vi.mock("../state/AuthProvider", () => ({
  useAuth: () => ({ user: mocks.user }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
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
    startBridgedSession: mocks.startBridgedSession,
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
  useDraftCard: mocks.useDraftCard,
}));
vi.mock("./useGuideMode", () => ({ useGuideMode: mocks.useGuideMode }));
vi.mock("./useUpdateReady", () => ({ useUpdateReady: vi.fn() }));
vi.mock("./useMeetings", () => ({ useMeetings: mocks.useMeetings }));
vi.mock("./useMeetingArm", () => ({ useMeetingArm: mocks.useMeetingArm }));
vi.mock("./useMeetingCapture", () => ({ useMeetingCapture: mocks.useMeetingCapture }));
vi.mock("./useOnboardingTail", () => ({ useOnboardingTail: mocks.useOnboardingTail }));
vi.mock("./OnboardingTail", () => ({ OnboardingTail: () => <div>tail</div> }));
vi.mock("./NotchBar", () => ({ NotchBar: () => <div>notch</div> }));
vi.mock("./DraftCard", () => ({
  DraftCard: () => <div>draft</div>,
  INITIAL_DRAFT_SLOT_HEIGHT: 180,
}));
vi.mock("./useCallbackCard", () => ({
  useCallbackCard: () => ({ visible: false, reset: vi.fn() }),
}));

import { OverlayRoot } from "./OverlayRoot";

let renderer: ReactTestRenderer | null = null;

beforeEach(() => {
  mocks.user = { uid: "user-1" };
  mocks.useGuideMode.mockReturnValue({
    armed: false,
    active: false,
    epoch: 0,
    stop: mocks.guideStop,
  });
  mocks.useDraftCard.mockReturnValue({ phase: "idle", reset: vi.fn() });
  mocks.useMeetings.mockReturnValue({ events: [] });
  mocks.useMeetingArm.mockReturnValue({ isArmed: vi.fn(() => false), revision: 0 });
  mocks.useMeetingCapture.mockReturnValue({});
  mocks.useOnboardingTail.mockReturnValue({ status: "done", complete: vi.fn() });
});

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
    mocks.useOnboardingTail.mockReturnValue({ status: "done", complete: vi.fn() });

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

  it("leaves onboarding to the dashboard while first-run is active", () => {
    mocks.useMeetings.mockReturnValue({ events: [] });
    mocks.useMeetingArm.mockReturnValue({ isArmed: vi.fn(() => false), revision: 0 });
    mocks.useMeetingCapture.mockReturnValue({});
    mocks.useOnboardingTail.mockReturnValue({ status: "active", complete: vi.fn() });

    act(() => {
      renderer = create(<OverlayRoot />);
    });

    const text = JSON.stringify(renderer!.toJSON());
    expect(text).not.toContain("tail");
    expect(text).toContain("notch");
  });

  it("keeps Guide Mode out of the card slot so drafts remain conversationally available", () => {
    mocks.useGuideMode.mockReturnValue({
      armed: true,
      active: false,
      epoch: 3,
      stop: mocks.guideStop,
    });
    mocks.useDraftCard.mockReturnValue({ phase: "ready", reset: vi.fn() });

    act(() => {
      renderer = create(<OverlayRoot />);
    });

    const text = JSON.stringify(renderer!.toJSON());
    expect(text).not.toContain("Check now");
    expect(text).not.toContain("Still checking");
    expect(text).toContain('"children":["draft"]');
    expect(mocks.invoke).toHaveBeenCalledWith("set_slot_height", { height: 180 });
    expect(mocks.startBridgedSession).toHaveBeenCalledWith("guide");
  });

  it("stops Guide mode and clears the slot when sign-out reaches the root", () => {
    mocks.user = null;
    mocks.useGuideMode.mockReturnValue({
      armed: true,
      active: false,
      epoch: 3,
      stop: mocks.guideStop,
    });

    act(() => {
      renderer = create(<OverlayRoot />);
    });

    expect(mocks.guideStop).toHaveBeenCalled();
    expect(mocks.invoke).toHaveBeenCalledWith("set_slot_height", { height: null });
  });
});
