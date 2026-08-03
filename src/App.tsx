import { useEffect } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { AuthProvider } from "./state/AuthProvider";
import { OverlayRoot } from "./overlay/OverlayRoot";
import { ErrorBoundary } from "./ErrorBoundary";
import { initializeAcquisitionAnalytics } from "./lib/acquisitionAnalytics";
import { desktopConsentAcceptedKey, overlayStorePath } from "./lib/copy";
import { initSentryIfEnabled } from "./lib/sentry";
import { logError } from "./lib/log";
import "./App.css";

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
        <OverlayRoot />
      </AuthProvider>
    </ErrorBoundary>
  );
}

export default App;
