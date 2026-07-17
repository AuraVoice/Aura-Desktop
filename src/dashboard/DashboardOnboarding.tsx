import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OnboardingFlow } from "../overlay/OnboardingFlow";
import { HotkeyTourStep } from "../overlay/HotkeyTourStep";
import { AgentDemoStep } from "../overlay/AgentDemoStep";
import { useVoiceBar } from "../overlay/useVoiceBar";
import { useOnboardingTail } from "../overlay/useOnboardingTail";
import { useDashboardUser } from "./useDashboardUser";
import { logError } from "../lib/log";
import "../overlay/OnboardingFlow.css";
import "./DashboardOnboarding.css";

interface VoiceToggleKeyStatus {
  available: boolean;
  keyLabel: string;
  reason?: string;
}

/** Post-sign-in tail for the dashboard window: hotkey tour then live demo. This
 * is the in-window twin of overlay OnboardingTail, minus the overlay-specific
 * window commands (summon_onboarding_panel / dismiss_bar / open_dashboard_window)
 * - the dashboard window is already the visible surface, so there is nothing to
 * summon or hand off to. The live demo reuses this window's own useVoiceBar
 * (LiveKit is per-webview, so this is a distinct instance from the overlay's). */
function DashboardTail({ onFinish }: { onFinish: () => void }) {
  const voice = useVoiceBar();
  const [step, setStep] = useState<"tour" | "demo">("tour");
  const [keyLabel, setKeyLabel] = useState<string | undefined>();

  useEffect(() => {
    invoke<VoiceToggleKeyStatus>("voice_toggle_key_status")
      .then((status) => setKeyLabel(status.keyLabel || undefined))
      .catch((err) => logError("DashboardTail: voice_toggle_key_status", err));
  }, []);

  return (
    <div className="onboarding-flow">
      {step === "tour" && (
        <HotkeyTourStep keyLabel={keyLabel} onContinue={() => setStep("demo")} />
      )}
      {step === "demo" && <AgentDemoStep voice={voice} onFinish={onFinish} />}
    </div>
  );
}

/** Full first-run flow hosted inside the dashboard window. Pre-sign-in reuses
 * the overlay's OnboardingFlow (consent -> questions -> sign-in, with all the
 * attribution logic); post-sign-in runs the tour + demo. `onComplete` fires once
 * first-run is finished (or was already done), so the parent can show the app. */
export function DashboardOnboarding({ onComplete }: { onComplete: () => void }) {
  const user = useDashboardUser();
  const tail = useOnboardingTail(user !== null);

  useEffect(() => {
    if (user && tail.status === "done") onComplete();
  }, [user, tail.status, onComplete]);

  let content: ReactNode = null;
  if (!user) {
    content = <OnboardingFlow />;
  } else if (tail.status === "active") {
    content = <DashboardTail onFinish={tail.complete} />;
  }

  return (
    <div className="db-onboarding">
      <div className="db-onboarding-panel">{content}</div>
    </div>
  );
}
