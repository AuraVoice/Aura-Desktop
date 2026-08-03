import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { DashboardApp } from "./dashboard/DashboardApp";
import { DictationHud } from "./dictation/DictationHud";

// Every window loads the same bundle; route on the window label. "main" is the
// transparent always-on-top overlay; "dashboard" is the decorated in-app window;
// "dictation" is the persistent passive pill and hold-to-talk caption strip.
const label = getCurrentWebviewWindow().label;
const Root =
  label === "dashboard" ? DashboardApp : label === "dictation" ? DictationHud : App;

// The overlay window is sized exactly to its content and must never scroll: mark
// it so overflow is clipped there (scoped to the overlay only - the dashboard
// still scrolls). A stray scrollbar here means a native OS scrollbar over the
// transparent HUD, which is what the compact/rotated notch was triggering.
if (label !== "dashboard") {
  document.documentElement.classList.add("is-overlay");
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
