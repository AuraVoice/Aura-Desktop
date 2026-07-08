import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { Store } from "@tauri-apps/plugin-store";
import { AuthProvider } from "./state/AuthProvider";
import { OverlayRoot } from "./overlay/OverlayRoot";
import { ErrorBoundary } from "./ErrorBoundary";
import { desktopConsentAcceptedKey, overlayStorePath } from "./lib/copy";
import { openDashboard } from "./lib/dashboardLink";
import { setTelemetryEnabled } from "./lib/analytics";
import { initSentryIfEnabled } from "./lib/sentry";
import { logError } from "./lib/log";
import "./App.css";

function App() {
  useEffect(() => {
    // Covers every launch, not just first-run: OnboardingFlow (which flips
    // this itself the moment consent is accepted) never mounts again once a
    // user is signed in, so a returning signed-in user's telemetry state has
    // to come from somewhere that always runs - this effect.
    Store.load(overlayStorePath)
      .then(async (store) => {
        const accepted = Boolean(await store.get<boolean>(desktopConsentAcceptedKey));
        setTelemetryEnabled(accepted);
        initSentryIfEnabled(accepted);
      })
      .catch((err) => logError("App: load telemetry consent", err));
  }, []);

  // Mounted here (not inside OverlayRoot) so it fires regardless of what the
  // overlay is currently presenting - opening a browser tab isn't an overlay
  // state change.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("open-dashboard-requested", () => void openDashboard())
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("App: listen open-dashboard-requested", err));
    return () => unlisten?.();
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
