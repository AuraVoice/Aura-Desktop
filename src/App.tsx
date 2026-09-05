import { useEffect, type ReactNode } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { AuthProvider, useAuth } from "./state/AuthProvider";
import { EntitlementProvider } from "./state/EntitlementProvider";
import { OverlayRoot } from "./overlay/OverlayRoot";
import { ErrorBoundary } from "./ErrorBoundary";
import { initializeAcquisitionAnalytics } from "./lib/acquisitionAnalytics";
import { desktopConsentAcceptedKey, overlayStorePath } from "./lib/copy";
import { initSentryIfEnabled } from "./lib/sentry";
import { logError } from "./lib/log";
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

function App() {
  useEffect(() => {
    void initializeAcquisitionAnalytics();
    // Covers every launch, not just first-run: OnboardingFlow (which flips
    // this itself the moment consent is accepted) never mounts again once a
    // user is signed in, so a returning signed-in user's telemetry state has
    // to come from somewhere that always runs - this effect.
    Store.load(overlayStorePath)
      .then(async (store) => {
        const accepted = await store.get<boolean>(desktopConsentAcceptedKey);
        if (accepted === true) initSentryIfEnabled(true);
      })
      .catch((err) => logError("App: load telemetry consent", err));
  }, []);

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
