import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import QRCode from "react-qr-code";
import {
  onboarding as copy,
  consent as consentCopy,
  desktopOnboardingSeenKey,
  desktopConsentAcceptedKey,
  getAuraAppUrl,
  overlayStorePath,
  privacyUrl,
  termsUrl,
} from "../lib/copy";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { setTelemetryEnabled } from "../lib/analytics";
import { initSentryIfEnabled } from "../lib/sentry";
import { logError, logInfo } from "../lib/log";
import { SignInForm, type Mode as SignInMode } from "./SignInForm";
import "./OnboardingFlow.css";

type Step = "welcome" | "getApp" | "link";
const STEPS: Step[] = ["welcome", "getApp", "link"];
// This store file is shared with overlay.rs's window-position persistence,
// which writes to it on every WindowEvent::Moved - a burst of which fires
// exactly when SetupPanel first mounts post-sign-out (the Bar->Setup
// resize). That contention can stretch this store read well past the "one
// frame" the blank-render fallback below was sized for, so this is a hard
// upper bound on how long the overlay can stay blank waiting on it, not the
// expected common case.
const STORE_LOAD_TIMEOUT_MS = 300;

function ConsentStep({ onAccept }: { onAccept: () => void }) {
  const [ageConfirmed, setAgeConfirmed] = useState(false);

  return (
    <div className="onboarding-step">
      <h2 className="onboarding-heading">{consentCopy.heading}</h2>
      <p className="onboarding-body">{consentCopy.body}</p>
      <div className="onboarding-legal-links">
        <button type="button" className="onboarding-link-button" onClick={() => void openUrl(privacyUrl)}>
          {consentCopy.privacyLabel}
        </button>
        <button type="button" className="onboarding-link-button" onClick={() => void openUrl(termsUrl)}>
          {consentCopy.termsLabel}
        </button>
      </div>
      <label className="onboarding-age-check">
        <input
          type="checkbox"
          checked={ageConfirmed}
          onChange={(e) => setAgeConfirmed(e.target.checked)}
        />
        {consentCopy.ageLabel}
      </label>
      <button
        type="button"
        className="onboarding-primary-button"
        disabled={!ageConfirmed}
        onClick={onAccept}
      >
        {consentCopy.accept}
      </button>
      <button type="button" className="onboarding-link-button" onClick={() => void exit(0)}>
        {consentCopy.quit}
      </button>
    </div>
  );
}

function WelcomeStep({
  onNext,
  onSkipToLink,
  onGoogleSignup,
}: {
  onNext: () => void;
  onSkipToLink: () => void;
  onGoogleSignup: () => void;
}) {
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
      <button type="button" className="onboarding-link-button" onClick={onGoogleSignup}>
        {copy.welcome.googleSignupLink}
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
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [initialSignInMode, setInitialSignInMode] = useState<SignInMode>("pairing");
  const storeRef = useRef<Store | null>(null);
  const forcedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    // Hard upper bound on the blank render below: if the store read is
    // contended (see overlayStorePath's comment), default to the sign-in
    // screen rather than leaving the overlay blank indefinitely. Biased
    // toward "link" (skip welcome) rather than "welcome" - a user reaching
    // this component post-sign-out has, by definition, already onboarded
    // once, and "New here?" is still one click away if this guess is ever
    // wrong for a genuinely first-run case.
    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      forcedRef.current = true;
      logInfo(
        "OnboardingFlow: load store",
        `timed out after ${STORE_LOAD_TIMEOUT_MS}ms, defaulting to link step`,
      );
      setStep("link");
      setResolved(true);
    }, STORE_LOAD_TIMEOUT_MS);

    Store.load(overlayStorePath)
      .then(async (store) => {
        storeRef.current = store;
        const seen = await store.get<boolean>(desktopOnboardingSeenKey);
        const accepted = await store.get<boolean>(desktopConsentAcceptedKey);
        if (cancelled) return;
        setConsentAccepted(Boolean(accepted));
        clearTimeout(timeoutId);
        logInfo("OnboardingFlow: load store", `resolved seen=${Boolean(seen)} in ${Date.now() - startedAt}ms`);
        // The timeout above already forced a render - a late resolution
        // only gets logged (so the real duration is auditable), not applied,
        // since re-driving step/resolved now could stomp on-screen
        // navigation the user has already made.
        if (forcedRef.current) return;
        if (seen) setStep("link");
        setResolved(true);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        logError("OnboardingFlow: load store", err);
        if (!cancelled && !forcedRef.current) setResolved(true);
      });
    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
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

  function acceptConsent() {
    storeRef.current?.set(desktopConsentAcceptedKey, true).catch((err) =>
      logError("OnboardingFlow: persist consent", err),
    );
    // Flip immediately in-memory so telemetry starts this session too, not
    // just after the next launch - App.tsx's own startup read covers future
    // launches, this covers the one where consent was just given.
    setTelemetryEnabled(true);
    initSentryIfEnabled(true);
    setConsentAccepted(true);
  }

  // Render nothing for the one frame before the seen-flag resolves, avoiding
  // a welcome-screen flash for returning users.
  if (!resolved) return null;

  if (!consentAccepted) {
    return (
      <div className="onboarding-flow">
        <ConsentStep onAccept={acceptConsent} />
      </div>
    );
  }

  return (
    <div className="onboarding-flow">
      {step === "welcome" && (
        <WelcomeStep
          onNext={() => setStep("getApp")}
          onSkipToLink={() => {
            setInitialSignInMode("pairing");
            setStep("link");
          }}
          onGoogleSignup={() => {
            setInitialSignInMode("google");
            setStep("link");
          }}
        />
      )}
      {step === "getApp" && (
        <GetAppStep
          onNext={() => {
            setInitialSignInMode("pairing");
            setStep("link");
          }}
          onBack={() => setStep("welcome")}
        />
      )}
      {step === "link" && <SignInForm initialMode={initialSignInMode} />}

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
