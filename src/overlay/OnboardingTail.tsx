import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError } from "../lib/log";
import { HotkeyTourStep } from "./HotkeyTourStep";
import { AgentDemoStep } from "./AgentDemoStep";
import { ProfileSetupStep } from "./ProfileSetupStep";
import { PrivacySetupStep } from "./PrivacySetupStep";
import type { VoiceBarState } from "./useVoiceBar";
import "./OnboardingFlow.css";

type TailStep = "profile" | "hotkeyTour" | "privacy" | "agentDemo";

interface VoiceToggleKeyStatus {
  available: boolean;
  keyLabel: string;
  reason?: string;
}

interface OverlaySnapshot {
  presentation: string;
}

interface OnboardingTailProps {
  uid: string;
  needsProfile: boolean;
  onProfileComplete: () => void;
  /** OverlayRoot's hoisted voice instance, reused for the live demo. */
  voice: VoiceBarState;
  /** Marks first-run complete once the user lands in the dashboard. */
  onComplete: () => void;
}

/** The post-sign-in tail: hotkey tour, then a live agent demo, then a handoff
 * to the dashboard. Rendered by OverlayRoot in a panel-sized surface once the
 * user signs in mid first-run (OnboardingFlow itself only mounts signed-out). */
export function OnboardingTail({
  uid,
  needsProfile,
  onProfileComplete,
  voice,
  onComplete,
}: OnboardingTailProps) {
  const initialStepRef = useRef<TailStep>(needsProfile ? "profile" : "hotkeyTour");
  const [step, setStep] = useState<TailStep>(initialStepRef.current);
  const [keyLabel, setKeyLabel] = useState<string | undefined>();
  const completedRef = useRef(false);

  // Sign-in hid the window (set_panel_variant -> Hidden). Re-show it as a
  // panel-sized surface so the tour and demo are visible. The listener below is
  // a belt-and-suspenders re-show if a late hide races the initial reveal.
  useEffect(() => {
    invoke("summon_onboarding_panel").catch((err) =>
      logError("OnboardingTail: summon_onboarding_panel", err),
    );
    let unlisten: (() => void) | undefined;
    listen<OverlaySnapshot>("overlay-changed", (event) => {
      if (!completedRef.current && event.payload.presentation === "hidden") {
        invoke("summon_onboarding_panel").catch((err) =>
          logError("OnboardingTail: re-show panel", err),
        );
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("OnboardingTail: listen overlay-changed", err));
    return () => unlisten?.();
  }, []);

  // Mirror the step to Rust for parity, same as OnboardingFlow.
  useEffect(() => {
    const nativeStep = step === "profile" ? "whereHeard" : step === "privacy" ? "link" : step;
    invoke("set_onboarding_step", { step: nativeStep }).catch((err) =>
      logError("OnboardingTail: set_onboarding_step", err),
    );
  }, [step]);

  useEffect(() => {
    invoke<VoiceToggleKeyStatus>("voice_toggle_key_status")
      .then((status) => setKeyLabel(status.keyLabel || undefined))
      .catch((err) => logError("OnboardingTail: voice_toggle_key_status", err));
  }, []);

  async function finishDemo() {
    if (completedRef.current) return;
    completedRef.current = true;
    // Land in the dashboard first (so the user always ends up somewhere), then
    // hide the onboarding surface, then mark first-run complete.
    await invoke("open_dashboard_window").catch((err) =>
      logError("OnboardingTail: open_dashboard_window", err),
    );
    await invoke("dismiss_bar").catch((err) =>
      logError("OnboardingTail: dismiss_bar", err),
    );
    onComplete();
  }

  async function goBack() {
    if (step === "agentDemo") {
      if (voice.desiredActive) await voice.endSession().catch(() => {});
      setStep("privacy");
    } else if (step === "privacy") {
      setStep("hotkeyTour");
    } else if (step === "hotkeyTour" && needsProfile) {
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
            setStep("hotkeyTour");
          }}
        />
      )}
      {step === "hotkeyTour" && (
        <HotkeyTourStep
          keyLabel={keyLabel}
          onContinue={() => setStep("privacy")}
        />
      )}
      {step === "privacy" && (
        <PrivacySetupStep
          onContinue={() => setStep("agentDemo")}
        />
      )}
      {step === "agentDemo" && (
        <AgentDemoStep voice={voice} onFinish={() => void finishDemo()} />
      )}
    </div>
  );
}
