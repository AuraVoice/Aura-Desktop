import { useEffect, useState, type ReactElement } from "react";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import type { User } from "firebase/auth";
import { Store } from "@tauri-apps/plugin-store";
import { ErrorBoundary } from "../ErrorBoundary";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { HomePage } from "./pages/HomePage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { SavedPage } from "./pages/SavedPage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { UsagePage } from "./pages/UsagePage";
import { AccountPage } from "./pages/AccountPage";
import { BillingPage } from "./pages/BillingPage";
import { ConnectorsPage } from "./pages/ConnectorsPage";
import { DraftsPage } from "./pages/DraftsPage";
import { HelpPage } from "./pages/HelpPage";
import { MobileAppPage } from "./pages/MobileAppPage";
import { ComingSoonPage } from "./pages/ComingSoonPage";
import { DashboardOnboarding } from "./DashboardOnboarding";
import { useDashboardUser } from "./useDashboardUser";
import { navSections, navTitles } from "./navConfig";
import { desktopOnboardingSeenKey, overlayStorePath } from "../lib/copy";
import { logError } from "../lib/log";
import "./dashboard.css";

// Routes with a real page today. Everything else falls back to the placeholder.
export const dashboardPages: Record<string, ReactElement> = {
  "/home": <HomePage />,
  "/conversations": <ConversationsPage />,
  "/drafts": <DraftsPage />,
  "/saved": <SavedPage />,
  "/meetings": <MeetingsPage />,
  "/usage": <UsagePage />,
  "/account": <AccountPage />,
  "/billing": <BillingPage />,
  "/connectors": <ConnectorsPage />,
  "/mobile": <MobileAppPage />,
  "/help": <HelpPage />,
};

export function DashboardShell({ user }: { user: User | null }) {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const title = navTitles[location.pathname] ?? "Home";

  const routes = navSections.flatMap((section) => section.items);

  return (
    <div className={`db-app${collapsed ? " db-app-collapsed" : ""}`}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
      <div className="db-main">
        <TopBar title={title} user={user} />
        <div className="db-content">
          <Routes>
            <Route path="/" element={<Navigate to="/home" replace />} />
            {routes.map(({ to, label }) => (
              <Route
                key={to}
                path={to}
                element={dashboardPages[to] ?? <ComingSoonPage title={label} />}
              />
            ))}
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

/** Root of the "dashboard" window. Uses a read-only Firebase subscription
 * (useDashboardUser) rather than the overlay's AuthProvider, whose native side
 * effects (set_panel_variant, dismiss_bar) must not run from this window.
 *
 * First-run gate: a user who is signed in AND has finished onboarding sees the
 * app; anyone else (signed out, or signed in mid first-run) sees the onboarding
 * flow in this same window. Sign-in propagates to Rust via the hidden main
 * window's AuthProvider, which observes the shared Firebase session. */
export function DashboardApp() {
  const user = useDashboardUser();
  const [onboarded, setOnboarded] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    Store.load(overlayStorePath)
      .then((store) => store.get<boolean>(desktopOnboardingSeenKey))
      .then((seen) => {
        if (!cancelled) setOnboarded(Boolean(seen));
      })
      .catch((err) => {
        logError("DashboardApp: read onboarding_seen", err);
        if (!cancelled) setOnboarded(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Hold the initial render until the seen flag resolves, so a returning user
  // never flashes the onboarding shell before the app.
  if (onboarded === null) return null;

  const showApp = user !== null && onboarded;

  return (
    <ErrorBoundary>
      {showApp ? (
        <HashRouter>
          <DashboardShell user={user} />
        </HashRouter>
      ) : (
        <DashboardOnboarding onComplete={() => setOnboarded(true)} />
      )}
    </ErrorBoundary>
  );
}
