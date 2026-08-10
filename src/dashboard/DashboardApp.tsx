import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import type { User } from "firebase/auth";
import { Store } from "@tauri-apps/plugin-store";
import { ErrorBoundary } from "../ErrorBoundary";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { DashboardTitleBar } from "./DashboardTitleBar";
import { SettingsDialog, settingsRoutes } from "./SettingsDialog";
import { HomePage } from "./pages/HomePage";
import { ConversationsPage } from "./pages/ConversationsPage";
import { SavedPage } from "./pages/SavedPage";
import { MeetingsPage } from "./pages/MeetingsPage";
import { AccountPage } from "./pages/AccountPage";
import { BillingPage } from "./pages/BillingPage";
import { ConnectorsPage } from "./pages/ConnectorsPage";
import { DraftsPage } from "./pages/DraftsPage";
import { HelpPage } from "./pages/HelpPage";
import { MobileAppPage } from "./pages/MobileAppPage";
import { ComingSoonPage } from "./pages/ComingSoonPage";
import { InsightsPage } from "./pages/InsightsPage";
import { GeneralPage } from "./pages/GeneralPage";
import { DictationPage } from "./pages/DictationPage";
import { DashboardOnboarding } from "./DashboardOnboarding";
import { useDashboardUser } from "./useDashboardUser";
import { DashboardResourceScope } from "./useDashboardResource";
import { useDashboardNotifications } from "./useDashboardNotifications";
import { navSections, navTitles } from "./navConfig";
import { desktopOnboardingSeenForUidKey, overlayStorePath } from "../lib/copy";
import { logError } from "../lib/log";
import { useGeneralSettings } from "../state/useGeneralSettings";
import "./dashboard.css";

// Routes with a real page today. Everything else falls back to the placeholder.
export const dashboardPages: Record<string, ReactElement> = {
  "/home": <HomePage />,
  "/conversations": <ConversationsPage />,
  "/drafts": <DraftsPage />,
  "/saved": <SavedPage />,
  "/meetings": <MeetingsPage />,
  "/insights": <InsightsPage />,
  "/general": <GeneralPage />,
  "/dictation": <DictationPage />,
  "/account": <AccountPage />,
  "/billing": <BillingPage />,
  "/connectors": <ConnectorsPage />,
  "/mobile": <MobileAppPage />,
  "/help": <HelpPage />,
};

export function DashboardShell({ user, collapsed }: { user: User | null; collapsed: boolean }) {
  const generalSettings = useGeneralSettings();
  const location = useLocation();
  const navigate = useNavigate();
  const contentRef = useRef<HTMLDivElement>(null);
  const lastMainPathRef = useRef("/home");
  const settingsOpen = settingsRoutes.has(location.pathname);
  if (!settingsOpen && dashboardPages[location.pathname]) {
    lastMainPathRef.current = location.pathname;
  }
  const mainPath = settingsOpen ? lastMainPathRef.current : location.pathname;
  const title = navTitles[mainPath] ?? "Home";
  const notifications = useDashboardNotifications(user?.uid ?? null);

  const routes = navSections.flatMap((section) => section.items);
  const closeSettings = useCallback(() => {
    navigate(lastMainPathRef.current);
  }, [navigate]);

  useLayoutEffect(() => {
    if (!contentRef.current) return;
    contentRef.current.scrollTop = 0;
    contentRef.current.scrollLeft = 0;
  }, [mainPath]);

  if (!user) return null;

  return (
    <div className={`db-app${collapsed ? " db-app-collapsed" : ""}${
      generalSettings.reduceMotion ? " db-reduce-motion" : ""
    }`}>
      <DashboardRouteListener />
      <Sidebar collapsed={collapsed} />
      <div className="db-main">
        <TopBar
          title={location.pathname === "/insights" ? "" : title}
          user={user}
          notifications={notifications}
        />
        <div className="db-content" ref={contentRef}>
          <DashboardResourceScope uid={user.uid}>
            <Routes location={mainPath}>
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
          </DashboardResourceScope>
        </div>
      </div>
      {settingsOpen && <SettingsDialog path={location.pathname} onClose={closeSettings} />}
    </div>
  );
}

function DashboardRouteListener() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<string>("dashboard-navigate", (event) => {
      window.location.hash = event.payload;
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("DashboardApp: dashboard-navigate", err));
    return () => unlisten?.();
  }, []);

  return null;
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
  const [collapsed, setCollapsed] = useState(false);
  const uid = user?.uid ?? null;

  useEffect(() => {
    if (!uid) {
      setOnboarded(false);
      return;
    }
    let cancelled = false;
    setOnboarded(null);
    Store.load(overlayStorePath)
      .then((store) => store.get<boolean>(desktopOnboardingSeenForUidKey(uid)))
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
  }, [uid]);

  const showApp = user !== null && onboarded;

  return (
    <div className="db-window">
      <DashboardTitleBar
        collapsed={collapsed}
        onToggle={showApp ? () => setCollapsed((current) => !current) : undefined}
      />
      <div className="db-window-content">
        {onboarded !== null && (
          <ErrorBoundary>
            {showApp ? (
              <HashRouter>
                <DashboardShell user={user} collapsed={collapsed} />
              </HashRouter>
            ) : (
              <DashboardOnboarding onComplete={() => setOnboarded(true)} />
            )}
          </ErrorBoundary>
        )}
      </div>
    </div>
  );
}
