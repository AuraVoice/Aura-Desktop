import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  user: null as { uid: string } | null,
  seen: false,
  accountComplete: true,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: vi.fn(async () => ({ get: vi.fn(async () => mocks.seen) })),
  },
}));
vi.mock("./useDashboardUser", () => ({ useDashboardUser: () => mocks.user }));
vi.mock("./AccountOnboarding", () => ({
  hasConfirmedAccountOnboarding: vi.fn(async () => mocks.accountComplete),
  fetchAccountOnboarding: vi.fn(async () => ({ complete: mocks.accountComplete })),
  markAccountOnboardingConfirmed: vi.fn(async () => {}),
}));
vi.mock("./DashboardOnboarding", () => ({ DashboardOnboarding: () => <div>dashboard-onboarding</div> }));
vi.mock("./Sidebar", () => ({ Sidebar: () => <aside>sidebar</aside> }));
vi.mock("./TopBar", () => ({ TopBar: () => <header>topbar</header> }));
vi.mock("react-router-dom", () => ({
  HashRouter: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Navigate: () => null,
  Route: ({ element }: { element: React.ReactNode }) => <>{element}</>,
  Routes: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useLocation: () => ({ pathname: "/home" }),
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("./pages/HomePage", () => ({ HomePage: () => <div>home</div> }));
vi.mock("./pages/ConversationsPage", () => ({ ConversationsPage: () => <div>conversations</div> }));
vi.mock("./pages/DraftsPage", () => ({ DraftsPage: () => <div>drafts</div> }));
vi.mock("./pages/SavedPage", () => ({ SavedPage: () => <div>saved</div> }));
vi.mock("./pages/UsagePage", () => ({ UsagePage: () => <div>usage</div> }));
vi.mock("./pages/AccountPage", () => ({ AccountPage: () => <div>account</div> }));
vi.mock("./pages/BillingPage", () => ({ BillingPage: () => <div>billing</div> }));
vi.mock("./pages/ConnectorsPage", () => ({ ConnectorsPage: () => <div>connectors</div> }));
vi.mock("./pages/MobileAppPage", () => ({ MobileAppPage: () => <div>mobile</div> }));
vi.mock("./pages/HelpPage", () => ({ HelpPage: () => <div>help</div> }));
vi.mock("./pages/ComingSoonPage", () => ({ ComingSoonPage: () => <div>coming-soon</div> }));

import { DashboardApp, dashboardPages } from "./DashboardApp";

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

describe("DashboardApp", () => {
  it("routes every local sidebar page to a real page", () => {
    expect(Object.keys(dashboardPages)).toEqual(
      expect.arrayContaining(["/drafts", "/billing", "/connectors", "/mobile", "/help"]),
    );
  });

  it("shows the app when a signed-in user has completed onboarding", async () => {
    mocks.user = { uid: "user-1" };
    mocks.seen = true;
    await act(async () => {
      renderer = create(<DashboardApp />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("sidebar");
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("dashboard-onboarding");
  });

  it("keeps first-run users in the dashboard onboarding flow", async () => {
    mocks.user = { uid: "user-1" };
    mocks.seen = false;
    await act(async () => {
      renderer = create(<DashboardApp />);
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("dashboard-onboarding");
  });
});
