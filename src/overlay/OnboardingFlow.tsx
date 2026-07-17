import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import QRCode from "react-qr-code";
import {
  onboarding as copy,
  consent as consentCopy,
  whereHeard as whereHeardCopy,
  role as roleCopy,
  desktopOnboardingSeenKey,
  desktopConsentAcceptedKey,
  desktopWhereHeardKey,
  desktopRoleKey,
  getAuraAppUrl,
  overlayStorePath,
  privacyUrl,
  termsUrl,
} from "../lib/copy";
import { openUrl } from "@tauri-apps/plugin-opener";
import { exit } from "@tauri-apps/plugin-process";
import { setPersonProperties, setTelemetryEnabled } from "../lib/analytics";
import { getOrCreateAnonId, type StoredAnswer } from "../lib/profile";
import { initSentryIfEnabled } from "../lib/sentry";
import { logError, logInfo } from "../lib/log";
import { ChoiceStep } from "./ChoiceStep";
import { SignInForm, type Mode as SignInMode } from "./SignInForm";
import "./OnboardingFlow.css";

type Step = "welcome" | "getApp" | "whereHeard" | "role" | "link";
// Dots cover the pre-sign-in sequence only; the sign-in ("link") step has no dot
// so a user can't skip the attribution questions by clicking ahead.
const DOT_STEPS: Step[] = ["welcome", "getApp", "whereHeard", "role"];
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
  const [whereHeardAnswer, setWhereHeardAnswer] = useState<StoredAnswer | null>(null);
  const [roleAnswer, setRoleAnswer] = useState<StoredAnswer | null>(null);
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
        const whereHeard = await store.get<StoredAnswer>(desktopWhereHeardKey);
        const role = await store.get<StoredAnswer>(desktopRoleKey);
        if (cancelled) return;
        setConsentAccepted(Boolean(accepted));
        setWhereHeardAnswer(whereHeard ?? null);
        setRoleAnswer(role ?? null);
        clearTimeout(timeoutId);
        logInfo("OnboardingFlow: load store", `resolved seen=${Boolean(seen)} in ${Date.now() - startedAt}ms`);
        // The timeout above already forced a render - a late resolution
        // only gets logged (so the real duration is auditable), not applied,
        // since re-driving step/resolved now could stomp on-screen
        // navigation the user has already made.
        if (forcedRef.current) return;
        // Resume where an interrupted first-run left off: a returning user
        // (seen) or one who already finished the questions (role answered)
        // jumps straight to sign-in; a partial answerer resumes at the next
        // unanswered question rather than re-asking.
        if (seen || role) setStep("link");
        else if (whereHeard) setStep("role");
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
    // The onboarding_seen flag is now written at the very end of the flow
    // (after the post-sign-in tour + demo, in OnboardingTail), not here - so an
    // interrupted first-run resumes instead of being marked complete at sign-in.
    invoke("set_onboarding_step", { step }).catch((err) =>
      logError("OnboardingFlow: set_onboarding_step", err),
    );
  }, [step, resolved]);

  // Persists a question answer, mirrors it to PostHog under the per-install
  // anonymous id (aliased to the uid post-sign-in), then advances. Referral is
  // captured here, pre-sign-in, so it survives even if the user never finishes.
  async function persistAnswer(
    key: typeof desktopWhereHeardKey | typeof desktopRoleKey,
    property: "where_heard" | "role",
    answer: StoredAnswer,
  ) {
    const store = storeRef.current;
    if (!store) return;
    await store.set(key, answer).catch((err) =>
      logError("OnboardingFlow: persist answer", err),
    );
    const anonId = await getOrCreateAnonId(store).catch((err) => {
      logError("OnboardingFlow: anon id", err);
      return undefined;
    });
    const props: Record<string, unknown> = { [property]: answer.id };
    if (answer.other) props[`${property}_other`] = answer.other;
    setPersonProperties(props, anonId ?? undefined);
  }

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
          onNext={() => setStep("whereHeard")}
          onBack={() => setStep("welcome")}
        />
      )}
      {step === "whereHeard" && (
        <ChoiceStep
          heading={whereHeardCopy.heading}
          body={whereHeardCopy.body}
          options={whereHeardCopy.options}
          otherPlaceholder={whereHeardCopy.otherPlaceholder}
          buttonLabel={whereHeardCopy.button}
          initial={whereHeardAnswer ?? undefined}
          onSubmit={(answer) => {
            setWhereHeardAnswer(answer);
            void persistAnswer(desktopWhereHeardKey, "where_heard", answer);
            setStep("role");
          }}
        />
      )}
      {step === "role" && (
        <ChoiceStep
          heading={roleCopy.heading}
          body={roleCopy.body}
          options={roleCopy.options}
          otherPlaceholder={roleCopy.otherPlaceholder}
          buttonLabel={roleCopy.button}
          initial={roleAnswer ?? undefined}
          onSubmit={(answer) => {
            setRoleAnswer(answer);
            void persistAnswer(desktopRoleKey, "role", answer);
            setInitialSignInMode("pairing");
            setStep("link");
          }}
        />
      )}
      {step === "link" && <SignInForm initialMode={initialSignInMode} />}

      <div className="onboarding-footer">
        {step !== "link" && (
          <div className="onboarding-progress-dots">
            {DOT_STEPS.map((s) => (
              <button
                key={s}
                type="button"
                className={`onboarding-dot${s === step ? " onboarding-dot-active" : ""}`}
                onClick={() => setStep(s)}
                aria-label={`Go to ${s} step`}
              />
            ))}
          </div>
        )}
        {step === "link" && (
          <button type="button" className="onboarding-link-button onboarding-new-here" onClick={() => setStep("welcome")}>
            {copy.newHereLink}
          </button>
        )}
      </div>
    </div>
  );
}
