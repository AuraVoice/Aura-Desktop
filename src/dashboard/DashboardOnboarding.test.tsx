import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  user: null as { uid: string } | null,
  status: "active" as "active" | "done",
  complete: vi.fn(),
}));

vi.mock("./useDashboardUser", () => ({ useDashboardUser: () => mocks.user }));
vi.mock("../overlay/useOnboardingTail", () => ({
  useOnboardingTail: () => ({ status: mocks.status, complete: mocks.complete }),
}));
vi.mock("../overlay/OnboardingFlow", () => ({ OnboardingFlow: () => <div>overlay-flow</div> }));
vi.mock("../overlay/HotkeyTourStep", () => ({ HotkeyTourStep: () => <div>hotkey-tour</div> }));
vi.mock("../overlay/AgentDemoStep", () => ({ AgentDemoStep: () => <div>agent-demo</div> }));
vi.mock("../overlay/useVoiceBar", () => ({ useVoiceBar: () => ({}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(() => Promise.resolve({ keyLabel: "Ctrl" })) }));

import { DashboardOnboarding } from "./DashboardOnboarding";

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

describe("DashboardOnboarding", () => {
  it("hosts the signed-out onboarding flow inside the dashboard window", () => {
    mocks.user = null;
    mocks.status = "active";
    act(() => {
      renderer = create(<DashboardOnboarding onComplete={vi.fn()} />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("overlay-flow");
  });

  it("continues with the in-window post-sign-in tour", async () => {
    mocks.user = { uid: "user-1" };
    mocks.status = "active";
    await act(async () => {
      renderer = create(<DashboardOnboarding onComplete={vi.fn()} />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("hotkey-tour");
  });
});
