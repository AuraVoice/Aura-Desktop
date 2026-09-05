import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement } from "react";
import { useTauriEvent } from "../lib/useTauriEvent";
import { DASHBOARD_NAVIGATE } from "../lib/ipcEvents";
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
import { ResearchPage } from "./pages/ResearchPage";
import { InterviewPage } from "./pages/InterviewPage";
import { DashboardOnboarding } from "./DashboardOnboarding";
import { TrialBanner } from "./TrialBanner";
import { EntitlementProvider } from "../state/EntitlementProvider";
import {
  fetchAccountOnboarding,
  hasConfirmedAccountOnboarding,
  markAccountOnboardingConfirmed,
  type AccountOnboardingState,
} from "./AccountOnboarding";
import { useDashboardUser } from "./useDashboardUser";
import { DashboardResourceScope } from "./useDashboardResource";
import { useDashboardNotifications } from "./useDashboardNotifications";
import { navSections, navTitles } from "./navConfig";
import { desktopOnboardingSeenForUidKey, overlayStorePath } from "../lib/copy";
import { logError } from "../lib/log";
import { pruneSiteIcons } from "../lib/siteIconCache";
import { useGeneralSettings } from "../state/useGeneralSettings";
import { useUpdateReady } from "../overlay/useUpdateReady";
import { UpdateBanner } from "../UpdateBanner";
import "./dashboard.css";

// Routes with a real page today. Everything else falls back to the placeholder.
export const dashboardPages: Record<string, ReactElement> = {
  "/home": <HomePage />,
  "/conversations": <ConversationsPage />,
  "/drafts": <DraftsPage />,
  "/saved": <SavedPage />,
  "/meetings": <MeetingsPage />,
  "/interview": <InterviewPage />,
  "/research": <ResearchPage />,
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
  const updateReady = useUpdateReady();
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
        <UpdateBanner
          version={updateReady.version}
          updatedVersion={updateReady.updatedNotice}
          surface="dashboard"
        />
        <TrialBanner uid={user.uid} />
        <div className="db-content" ref={contentRef}>
          <DashboardResourceScope uid={user.uid}>
            <Routes location={settingsOpen ? mainPath : location}>
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
  // Keeps the favicon cache from growing for the life of the install. Fire and
  // forget: nothing on screen depends on it.
  useEffect(() => pruneSiteIcons(), []);

  useTauriEvent<string>(
    DASHBOARD_NAVIGATE,
    (destination) => {
      window.location.hash = destination;
    },
    "DashboardApp: dashboard-navigate",
  );

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
  const [accountComplete, setAccountComplete] = useState<boolean | null>(null);
  const [accountState, setAccountState] = useState<AccountOnboardingState | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const accountRequestRef = useRef(0);
  const uid = user?.uid ?? null;
  const currentUidRef = useRef(uid);
  currentUidRef.current = uid;

  const loadAccountOnboarding = useCallback(async (accountUid: string) => {
    const requestId = ++accountRequestRef.current;
    setAccountComplete(null);
    setAccountState(null);
    setAccountError(null);
    try {
      if (await hasConfirmedAccountOnboarding(accountUid)) {
        if (requestId === accountRequestRef.current && currentUidRef.current === accountUid) {
          setAccountComplete(true);
        }
        return;
      }
      const state = await fetchAccountOnboarding(accountUid);
      if (requestId !== accountRequestRef.current || currentUidRef.current !== accountUid) return;
      if (state.complete) {
        await markAccountOnboardingConfirmed(accountUid).catch((err) =>
          logError("DashboardApp: cache account onboarding", err),
        );
      }
      if (requestId !== accountRequestRef.current || currentUidRef.current !== accountUid) return;
      setAccountState(state);
      setAccountComplete(state.complete);
    } catch (err) {
      logError("DashboardApp: load account onboarding", err);
      if (requestId === accountRequestRef.current && currentUidRef.current === accountUid) {
        setAccountError("Aura couldn't confirm your account setup.");
      }
    }
  }, []);

  useEffect(() => {
    if (!uid) {
      setOnboarded(false);
      setAccountComplete(null);
      setAccountState(null);
      setAccountError(null);
      accountRequestRef.current += 1;
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

  useEffect(() => {
    if (uid) void loadAccountOnboarding(uid);
  }, [uid, loadAccountOnboarding]);

  const showApp = user !== null && onboarded === true && accountComplete === true;

  return (
    // Above the showApp fork on purpose: the onboarding tail's voice picker
    // needs the same shared entitlement the finished app does.
    <EntitlementProvider signedIn={user !== null} uid={uid}>
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
              <DashboardOnboarding
                accountComplete={accountComplete}
                accountState={accountState}
                accountError={accountError}
                onRetryAccount={() => {
                  if (uid) void loadAccountOnboarding(uid);
                }}
                onAccountComplete={async (state) => {
                  if (!uid) return;
                  const completedUid = uid;
                  if (currentUidRef.current !== completedUid) return;
                  await markAccountOnboardingConfirmed(completedUid).catch((err) =>
                    logError("DashboardApp: cache completed account onboarding", err),
                  );
                  if (currentUidRef.current !== completedUid) return;
                  setAccountState(state);
                  setAccountComplete(true);
                }}
                onComplete={() => setOnboarded(true)}
              />
            )}
          </ErrorBoundary>
        )}
      </div>
    </div>
    </EntitlementProvider>
  );
}
