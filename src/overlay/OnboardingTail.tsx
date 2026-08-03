import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError } from "../lib/log";
import {
  trackOnboardingCompleted,
  trackOnboardingStepCompleted,
} from "../lib/acquisitionAnalytics";
import { HotkeyTourStep } from "./HotkeyTourStep";
import { AgentDemoStep } from "./AgentDemoStep";
import type { VoiceBarState } from "./useVoiceBar";
import "./OnboardingFlow.css";

type TailStep = "hotkeyTour" | "agentDemo";

interface VoiceToggleKeyStatus {
  available: boolean;
  keyLabel: string;
  reason?: string;
}

interface OverlaySnapshot {
  presentation: string;
}

interface OnboardingTailProps {
  /** OverlayRoot's hoisted voice instance, reused for the live demo. */
  voice: VoiceBarState;
  /** Marks first-run complete once the user lands in the dashboard. */
  onComplete: () => void;
}

/** The post-sign-in tail: hotkey tour, then a live agent demo, then a handoff
 * to the dashboard. Rendered by OverlayRoot in a panel-sized surface once the
 * user signs in mid first-run (OnboardingFlow itself only mounts signed-out). */
export function OnboardingTail({ voice, onComplete }: OnboardingTailProps) {
  const [step, setStep] = useState<TailStep>("hotkeyTour");
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
    invoke("set_onboarding_step", { step }).catch((err) =>
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
    void trackOnboardingStepCompleted("agent_demo");
    void trackOnboardingCompleted();
    onComplete();
  }

  return (
    <div className="onboarding-flow">
      {step === "hotkeyTour" && (
        <HotkeyTourStep
          keyLabel={keyLabel}
          onContinue={() => {
            void trackOnboardingStepCompleted("hotkey_tour");
            setStep("agentDemo");
          }}
        />
      )}
      {step === "agentDemo" && (
        <AgentDemoStep voice={voice} onFinish={() => void finishDemo()} />
      )}
    </div>
  );
}
