import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import QRCode from "react-qr-code";
import { onboarding as copy, desktopOnboardingSeenKey, getAuraAppUrl } from "../lib/copy";
import { logError } from "../lib/log";
import { SignInForm } from "./SignInForm";
import "./OnboardingFlow.css";

type Step = "welcome" | "getApp" | "link";
const STEPS: Step[] = ["welcome", "getApp", "link"];
const OVERLAY_STORE_PATH = "overlay-window.json";

function WelcomeStep({ onNext, onSkipToLink }: { onNext: () => void; onSkipToLink: () => void }) {
  return (
    <div className="onboarding-step">
      <h2 className="onboarding-heading">{copy.welcome.heading}</h2>
      <p className="onboarding-body">{copy.welcome.body}</p>
      <p className="onboarding-hint">{copy.welcome.trayHint}</p>
      <button type="button" className="onboarding-primary-button" onClick={onNext}>
        {copy.welcome.button}
      </button>
      <button type="button" className="onboarding-link-button" onClick={onSkipToLink}>
        {copy.welcome.skipLink}
      </button>
    </div>
  );
}

function GetAppStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  return (
    <div className="onboarding-step onboarding-step-get-app">
      <div className="onboarding-qr-card">
        <QRCode value={getAuraAppUrl} size={116} />
      </div>
      <div className="onboarding-get-app-copy">
        <h2 className="onboarding-heading">{copy.getApp.heading}</h2>
        <p className="onboarding-body">{copy.getApp.body}</p>
        <button type="button" className="onboarding-primary-button" onClick={onNext}>
          {copy.getApp.button}
        </button>
        <button type="button" className="onboarding-link-button" onClick={onBack}>
          {copy.getApp.backLink}
        </button>
      </div>
    </div>
  );
}

export function OnboardingFlow() {
  const [step, setStep] = useState<Step>("welcome");
  const [resolved, setResolved] = useState(false);
  const storeRef = useRef<Store | null>(null);

  useEffect(() => {
    let cancelled = false;
    Store.load(OVERLAY_STORE_PATH)
      .then(async (store) => {
        storeRef.current = store;
        const seen = await store.get<boolean>(desktopOnboardingSeenKey);
        if (cancelled) return;
        if (seen) setStep("link");
        setResolved(true);
      })
      .catch((err) => {
        logError("OnboardingFlow: load store", err);
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!resolved) return;
    invoke("set_onboarding_step", { step }).catch((err) =>
      logError("OnboardingFlow: set_onboarding_step", err),
    );
    if (step === "link") {
      storeRef.current?.set(desktopOnboardingSeenKey, true).catch((err) =>
        logError("OnboardingFlow: persist onboarding_seen", err),
      );
    }
  }, [step, resolved]);

  // Render nothing for the one frame before the seen-flag resolves, avoiding
  // a welcome-screen flash for returning users.
  if (!resolved) return null;

  return (
    <div className="onboarding-flow">
      {step === "welcome" && (
        <WelcomeStep onNext={() => setStep("getApp")} onSkipToLink={() => setStep("link")} />
      )}
      {step === "getApp" && (
        <GetAppStep onNext={() => setStep("link")} onBack={() => setStep("welcome")} />
      )}
      {step === "link" && <SignInForm />}

      <div className="onboarding-footer">
        <div className="onboarding-progress-dots">
          {STEPS.map((s) => (
            <button
              key={s}
              type="button"
              className={`onboarding-dot${s === step ? " onboarding-dot-active" : ""}`}
              onClick={() => setStep(s)}
              aria-label={`Go to ${s} step`}
            />
          ))}
        </div>
        {step === "link" && (
          <button type="button" className="onboarding-link-button onboarding-new-here" onClick={() => setStep("welcome")}>
            {copy.newHereLink}
          </button>
        )}
      </div>
    </div>
  );
}
