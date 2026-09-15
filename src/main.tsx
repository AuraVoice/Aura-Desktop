import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { DashboardApp } from "./dashboard/DashboardApp";
import { DictationHud } from "./dictation/DictationHud";
import { StatusPill } from "./overlay/StatusPill";
import { RegionOverlay } from "./region/RegionOverlay";
import { ErrorBoundary } from "./ErrorBoundary";
import { initTelemetryForWindow } from "./lib/telemetryInit";
import { ThemeSync } from "./theme/ThemeSync";
import { bootTheme } from "./theme/themeEngine";
import "./theme/themes.css";

// Every window loads the same bundle; route on the window label. "main" is the
// transparent always-on-top overlay; "dashboard" is the decorated in-app window;
// "dictation" is the persistent passive pill and hold-to-talk caption strip;
// "status-pill" is the brief bottom-middle confirmation for global state toggles;
// "region" is the fullscreen click-through trail drawn while circling to ask.
const label = getCurrentWebviewWindow().label;

// Before any render: paint the last known theme so no window opens in the wrong
// one. ThemeSync reconciles against the stored setting once it loads. The
// dictation HUD takes the notch's edge, and the notch is dark in both themes.
if (label === "dictation") {
  document.documentElement.classList.add("theme-pinned-dark");
}
bootTheme();

// Analytics, crash reporting and the consent gate boot per window (each
// webview is its own JS realm). Never awaited: React renders regardless.
initTelemetryForWindow(label);

// The transparent HUD windows get the silent boundary: a render crash
// there is logged and reported, but must not paint a "Restart" card onto the
// notch edge or over another app.
const root =
  label === "dashboard"
    ? <DashboardApp />
    : label === "dictation"
      ? <ErrorBoundary variant="silent"><DictationHud /></ErrorBoundary>
      : label === "status-pill"
        ? <ErrorBoundary variant="silent"><StatusPill /></ErrorBoundary>
        : label === "region"
          ? <ErrorBoundary variant="silent"><RegionOverlay /></ErrorBoundary>
          : <App />;

// The overlay window is sized exactly to its content and must never scroll: mark
// it so overflow is clipped there (scoped to the overlay only - the dashboard
// still scrolls). A stray scrollbar here means a native OS scrollbar over the
// transparent HUD, which is what the compact/rotated notch was triggering.
if (label !== "dashboard") {
  document.documentElement.classList.add("is-overlay");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeSync />
    {root}
  </React.StrictMode>,
);
