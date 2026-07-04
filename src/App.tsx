import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import AvatarView from "./views/AvatarView";
import DashboardView from "./views/DashboardView";
import { AuthProvider } from "./state/AuthProvider";
import { logError } from "./lib/log";
import "./App.css";

export type WindowMode = "avatar" | "dashboard";

function App() {
  const [mode, setMode] = useState<WindowMode>("avatar");

  useEffect(() => {
    const unlistenPromise = listen<WindowMode>("mode-changed", (event) => {
      setMode(event.payload);
    });

    // Covers the race where Rust emits the startup mode before this listener
    // is registered; pulls the authoritative mode once on mount.
    invoke<WindowMode>("current_mode")
      .then(setMode)
      .catch((err) => logError("App: current_mode", err));

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <AuthProvider>
      {mode === "avatar" ? <AvatarView /> : <DashboardView />}
    </AuthProvider>
  );
}

export default App;
