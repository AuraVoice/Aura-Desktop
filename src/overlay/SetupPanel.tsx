import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { bar as barCopy, hotkeyHints } from "../lib/copy";
import { HotkeyHint } from "./HotkeyHint";
import { OnboardingFlow } from "./OnboardingFlow";
import iconUrl from "../assets/icons/Aura-Icon.png";
import "./SetupPanel.css";

export function SetupPanel() {
  const [version, setVersion] = useState("");

  // A beta tester otherwise has no way to tell you which build they're
  // running without checking file properties manually.
  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {
        // Non-critical - the tray menu also shows the version.
      });
  }, []);

  return (
    <div className="setup-panel">
      <div className="setup-panel-header">
        <img src={iconUrl} alt="" className="setup-panel-icon" />
        <span className="setup-panel-title">{barCopy.title}</span>
        <span className="setup-panel-spacer" />
        <HotkeyHint keys={hotkeyHints.summon.keys} action={hotkeyHints.summon.action} />
        <HotkeyHint keys={hotkeyHints.hide.keys} action={hotkeyHints.hide.action} />
      </div>
      <div className="setup-panel-content">
        <OnboardingFlow />
      </div>
      {version && <span className="setup-panel-version">v{version}</span>}
    </div>
  );
}
