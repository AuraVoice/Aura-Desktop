import { useEffect, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { OnboardingFlow } from "../overlay/OnboardingFlow";
import { HotkeyTourStep } from "../overlay/HotkeyTourStep";
import { AgentDemoStep } from "../overlay/AgentDemoStep";
import { ProfileSetupStep } from "../overlay/ProfileSetupStep";
import { PrivacySetupStep } from "../overlay/PrivacySetupStep";
import { VoiceSetupStep } from "../overlay/VoiceSetupStep";
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

/** Post-sign-in tail owned by the dashboard window: profile, hotkey tour,
 * privacy, voice choice, then live demo. The main overlay stays hidden while this runs. The
 * live demo reuses this window's own useVoiceBar
 * (LiveKit is per-webview, so this is a distinct instance from the overlay's). */
function DashboardTail({
  uid,
  needsProfile,
  onProfileComplete,
  onFinish,
}: {
  uid: string;
  needsProfile: boolean;
  onProfileComplete: () => void;
  onFinish: () => void;
}) {
  const voice = useVoiceBar();
  type DashboardTailStep = "profile" | "tour" | "privacy" | "voice" | "demo";
  const initialStepRef = useRef<DashboardTailStep>(needsProfile ? "profile" : "tour");
  const [step, setStep] = useState<DashboardTailStep>(initialStepRef.current);
  const [keyLabel, setKeyLabel] = useState<string | undefined>();

  useEffect(() => {
    invoke<VoiceToggleKeyStatus>("voice_toggle_key_status")
      .then((status) => setKeyLabel(status.keyLabel || undefined))
      .catch((err) => logError("DashboardTail: voice_toggle_key_status", err));
  }, []);

  async function goBack() {
    if (step === "demo") {
      if (voice.desiredActive) await voice.endSession().catch(() => {});
      setStep("voice");
    } else if (step === "voice") {
      setStep("privacy");
    } else if (step === "privacy") {
      setStep("tour");
    } else if (step === "tour" && needsProfile) {
      setStep("profile");
    }
  }

  return (
    <div className="onboarding-flow">
      {step !== initialStepRef.current && (
        <div className="onboarding-topbar">
          <button type="button" className="onboarding-back-button" aria-label="Back" onClick={() => void goBack()}>
            <span aria-hidden="true">{"<"}</span>
          </button>
        </div>
      )}
      {step === "profile" && (
        <ProfileSetupStep
          uid={uid}
          onContinue={() => {
            onProfileComplete();
            setStep("tour");
          }}
        />
      )}
      {step === "tour" && (
        <HotkeyTourStep keyLabel={keyLabel} onContinue={() => setStep("privacy")} />
      )}
      {step === "privacy" && (
        <PrivacySetupStep onContinue={() => setStep("voice")} />
      )}
      {step === "voice" && <VoiceSetupStep onContinue={() => setStep("demo")} />}
      {step === "demo" && <AgentDemoStep voice={voice} onFinish={onFinish} />}
    </div>
  );
}

/** Full first-run flow hosted inside the dashboard window. Pre-sign-in reuses
 * the overlay's Google welcome and consent screen; post-sign-in currently runs
 * the existing tour + demo. `onComplete` fires once
 * first-run is finished (or was already done), so the parent can show the app. */
export function DashboardOnboarding({ onComplete }: { onComplete: () => void }) {
  const user = useDashboardUser();
  const tail = useOnboardingTail(user?.uid ?? null);

  useEffect(() => {
    if (user && tail.status === "done") onComplete();
  }, [user, tail.status, onComplete]);

  let content: ReactNode = null;
  if (!user) {
    content = <OnboardingFlow />;
  } else if (tail.status === "active") {
    content = (
      <DashboardTail
        uid={user.uid}
        needsProfile={tail.needsProfile}
        onProfileComplete={tail.profileComplete}
        onFinish={tail.complete}
      />
    );
  }

  return (
    <div className="db-onboarding">
      <div className="db-onboarding-panel">{content}</div>
    </div>
  );
}
