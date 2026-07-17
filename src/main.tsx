import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import App from "./App";
import { DashboardApp } from "./dashboard/DashboardApp";

// Both windows load the same bundle; route on the window label. "main" is the
// transparent always-on-top overlay; "dashboard" is the decorated in-app window.
const label = getCurrentWebviewWindow().label;
const Root = label === "dashboard" ? DashboardApp : App;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
