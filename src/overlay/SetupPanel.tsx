import { bar as barCopy, hotkeyHints } from "../lib/copy";
import { HotkeyHint } from "./HotkeyHint";
import { OnboardingFlow } from "./OnboardingFlow";
import iconUrl from "../assets/icons/Aura-Icon.png";
import "./SetupPanel.css";

export function SetupPanel() {
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
    </div>
  );
}
