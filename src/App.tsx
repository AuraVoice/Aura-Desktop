import { useEffect, type ReactNode } from "react";
import { AuthProvider, useAuth } from "./state/AuthProvider";
import { EntitlementProvider } from "./state/EntitlementProvider";
import { OverlayRoot } from "./overlay/OverlayRoot";
import { ErrorBoundary } from "./ErrorBoundary";
import { initializeAcquisitionAnalytics } from "./lib/acquisitionAnalytics";
import { trackEvent } from "./lib/analytics";
import { DICTATION_HOLD_COMPLETED } from "./lib/ipcEvents";
import { useTauriEvent } from "./lib/useTauriEvent";
import "./App.css";

/** Bridges the overlay window's auth into the shared entitlement source. Sits
 * INSIDE AuthProvider because it reads useAuth, and OUTSIDE OverlayRoot because
 * the onboarding tail's voice picker reads the context from under there. Lives
 * here rather than in EntitlementProvider.tsx so the dashboard bundle never
 * imports AuthProvider and its native side effects. */
function OverlayEntitlement({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return (
    <EntitlementProvider signedIn={user !== null} uid={user?.uid ?? null}>
      {children}
    </EntitlementProvider>
  );
}

/** Mirrors dictation/mod.rs DictationHoldCompleted: enum outcome, duration
 * and a word-count bucket. Never carries text; the HUD window itself sends no
 * analytics at all, so the main window reports the hold on its behalf. */
interface DictationHoldCompleted {
  outcome: string;
  hold_ms: number;
  word_bucket: string;
  polished?: boolean;
  error_category?: string | null;
}

function App() {
  useEffect(() => {
    // The consent gate, Sentry and the SDK boot in main.tsx for every window;
    // this window additionally owns the launch/install events and outbox.
    void initializeAcquisitionAnalytics();
  }, []);

  useTauriEvent<DictationHoldCompleted>(
    DICTATION_HOLD_COMPLETED,
    (payload) => trackEvent("dictation_hold_completed", { ...payload }),
    "App: dictation-hold-completed",
  );

  return (
    <ErrorBoundary>
      <AuthProvider>
        <OverlayEntitlement>
          <OverlayRoot />
        </OverlayEntitlement>
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
