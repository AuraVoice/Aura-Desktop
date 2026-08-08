import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Store } from "@tauri-apps/plugin-store";
import {
  onboarding as copy,
  consent as consentCopy,
  desktopConsentAcceptedKey,
  overlayStorePath,
  privacyUrl,
  termsUrl,
} from "../lib/copy";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  telemetryConsentAccepted,
  trackOnboardingStepCompleted,
} from "../lib/acquisitionAnalytics";
import { trackEvent } from "../lib/analytics";
import { recordDesktopOnboardingEvent } from "../lib/profile";
import { initSentryIfEnabled } from "../lib/sentry";
import { logError, logInfo } from "../lib/log";
import { webAuthCopy } from "../lib/webAuthCopy";
import iconUrl from "../assets/icons/Aura-Icon.png";
import { SignInForm } from "./SignInForm";
import { useWebAuthSignIn } from "./useWebAuthSignIn";
import "./OnboardingFlow.css";

// This store file is shared with overlay.rs's window-position persistence,
// which writes to it on every WindowEvent::Moved - a burst of which fires
// exactly when SetupPanel first mounts post-sign-out (the Bar->Setup
// resize). That contention can stretch this store read well past the "one
// frame" the blank-render fallback below was sized for, so this is a hard
// upper bound on how long the overlay can stay blank waiting on it, not the
// expected common case.
const STORE_LOAD_TIMEOUT_MS = 300;

function GoogleMark() {
  return (
    <svg className="onboarding-google-mark" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.205c0-.638-.057-1.252-.164-1.841H9v3.482h4.844a4.14 4.14 0 0 1-1.797 2.716v2.26h2.909c1.702-1.567 2.684-3.875 2.684-6.617Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.178l-2.91-2.26c-.805.54-1.835.86-3.046.86-2.344 0-4.328-1.584-5.037-3.71H.956v2.332A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.963 10.712A5.41 5.41 0 0 1 3.682 9c0-.594.102-1.172.28-1.712V4.956H.957A9 9 0 0 0 0 9c0 1.452.347 2.827.956 4.044l3.007-2.332Z" />
      <path fill="#EA4335" d="M9 3.578c1.321 0 2.507.454 3.442 1.346l2.582-2.582C13.463.89 11.426 0 9 0A9 9 0 0 0 .956 4.956l3.007 2.332C4.672 5.162 6.656 3.578 9 3.578Z" />
    </svg>
  );
}

export function OnboardingFlow() {
  const [resolved, setResolved] = useState(false);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [savingConsent, setSavingConsent] = useState(false);
  const [consentError, setConsentError] = useState<string | null>(null);
  const [phoneCodeVisible, setPhoneCodeVisible] = useState(false);
  const storeRef = useRef<Store | null>(null);
  const forcedRef = useRef(false);
  const webAuth = useWebAuthSignIn();

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    // Hard upper bound on the blank render below. If the shared store is busy,
    // show the welcome surface while the read continues rather than leaving
    // the window empty.
    const timeoutId = setTimeout(() => {
      if (cancelled) return;
      forcedRef.current = true;
      logInfo(
        "OnboardingFlow: load store",
        `timed out after ${STORE_LOAD_TIMEOUT_MS}ms, showing welcome screen`,
      );
      setResolved(true);
    }, STORE_LOAD_TIMEOUT_MS);

    Store.load(overlayStorePath)
      .then(async (store) => {
        storeRef.current = store;
        const accepted = await store.get<boolean>(desktopConsentAcceptedKey);
        if (cancelled) return;
        setConsentAccepted(Boolean(accepted));
        clearTimeout(timeoutId);
        logInfo(
          "OnboardingFlow: load store",
          `resolved consent=${Boolean(accepted)} in ${Date.now() - startedAt}ms`,
        );
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
    invoke("set_onboarding_step", { step: "welcome" }).catch((err) =>
      logError("OnboardingFlow: set_onboarding_step", err),
    );
  }, [resolved]);

  async function acceptConsentIfNeeded(): Promise<boolean> {
    if (!consentAccepted && !ageConfirmed) return false;
    setConsentError(null);
    if (!consentAccepted) {
      setSavingConsent(true);
      try {
        const store = storeRef.current ?? await Store.load(overlayStorePath);
        storeRef.current = store;
        await store.set(desktopConsentAcceptedKey, true);
        await telemetryConsentAccepted();
        trackEvent("desktop_telemetry_consent_accepted", { age_confirmed: true });
        await recordDesktopOnboardingEvent(
          "desktop_telemetry_consent_accepted",
          { age_confirmed: true },
          "telemetry_consent_accepted",
        );
        await trackOnboardingStepCompleted("consent");
        initSentryIfEnabled(true);
        setConsentAccepted(true);
      } catch (err) {
        logError("OnboardingFlow: persist consent", err);
        setConsentError("Aura couldn't save your choice. Please try again.");
        setSavingConsent(false);
        return false;
      }
      setSavingConsent(false);
    }
    return true;
  }

  async function continueWithGoogle() {
    if (savingConsent || webAuth.state.phase === "opening" || webAuth.state.phase === "waiting") return;
    if (!await acceptConsentIfNeeded()) return;
    trackEvent("desktop_onboarding_auth_path_selected", { auth_path: "google" });
    await recordDesktopOnboardingEvent(
      "desktop_onboarding_auth_path_selected",
      { auth_path: "google" },
      "auth_path_google",
    );
    await trackOnboardingStepCompleted("welcome");
    await webAuth.start();
  }

  async function showPhoneCode() {
    if (savingConsent || authBusy) return;
    if (!await acceptConsentIfNeeded()) return;
    webAuth.cancel();
    trackEvent("desktop_onboarding_auth_path_selected", { auth_path: "phone_pairing" });
    await recordDesktopOnboardingEvent(
      "desktop_onboarding_auth_path_selected",
      { auth_path: "phone_pairing" },
      "auth_path_phone_pairing",
    );
    await trackOnboardingStepCompleted("welcome");
    setPhoneCodeVisible(true);
  }

  // Render nothing for the short store read so a returning user does not see
  // the age checkbox flash before their saved consent resolves.
  if (!resolved) return null;

  const authBusy = savingConsent
    || webAuth.state.phase === "opening"
    || webAuth.state.phase === "waiting"
    || webAuth.state.phase === "signing_in";
  const authError = webAuth.state.phase === "expired"
    ? webAuthCopy.expired
    : webAuth.state.phase === "failed"
      ? webAuth.state.reason === "account_exists_different_credential"
        ? webAuthCopy.accountExistsDifferentCredential
        : webAuth.state.reason === "cancelled"
          ? webAuthCopy.cancelled
          : webAuth.state.reason === "popup_blocked"
            ? webAuthCopy.popupBlocked
            : webAuthCopy.otherFailure
      : webAuth.state.phase === "error"
        ? webAuthCopy.otherFailure
        : null;

  return (
    <div className="onboarding-flow onboarding-welcome-flow">
      <div className="onboarding-brand-mark">
        <img src={iconUrl} alt="" className="onboarding-brand-icon" />
      </div>
      <div className="onboarding-step onboarding-welcome-step">
        <h2 className="onboarding-heading">
          <span className="onboarding-heading-accent">{copy.welcome.headingAccent}</span>
          {copy.welcome.headingTail}
        </h2>
        <p className="onboarding-body">{copy.welcome.body}</p>

        {!consentAccepted && (
          <label className="onboarding-age-check">
            <input
              type="checkbox"
              checked={ageConfirmed}
              onChange={(event) => setAgeConfirmed(event.target.checked)}
            />
            <span>{consentCopy.ageLabel}</span>
          </label>
        )}

        <button
          type="button"
          className="onboarding-google-button"
          disabled={authBusy || (!consentAccepted && !ageConfirmed)}
          onClick={() => void continueWithGoogle()}
        >
          <GoogleMark />
          <span>
            {savingConsent
              ? "Saving your choice..."
              : webAuth.state.phase === "opening"
                ? webAuthCopy.opening
                : webAuth.state.phase === "waiting"
                  ? "Waiting for Google..."
                  : webAuth.state.phase === "signing_in"
                    ? "Signing you in..."
                    : authError
                      ? webAuthCopy.tryAgain
                      : "Continue with Google"}
          </span>
        </button>

        <button
          type="button"
          className="onboarding-link-button onboarding-phone-link"
          disabled={authBusy || (!consentAccepted && !ageConfirmed)}
          onClick={() => {
            if (phoneCodeVisible) setPhoneCodeVisible(false);
            else void showPhoneCode();
          }}
        >
          {phoneCodeVisible ? "Hide phone code" : "Connect with phone using a code"}
        </button>

        {phoneCodeVisible && (
          <div className="onboarding-phone-pairing">
            <SignInForm initialMode="pairing" pairingOnly showLegal={false} />
          </div>
        )}

        {webAuth.state.phase === "waiting" && (
          <p className="onboarding-status" role="status">{webAuthCopy.waiting}</p>
        )}
        {(consentError || authError) && (
          <p className="onboarding-error" role="alert">{consentError ?? authError}</p>
        )}
        {authBusy && !savingConsent && webAuth.state.phase !== "signing_in" && (
          <button type="button" className="onboarding-link-button" onClick={webAuth.cancel}>
            {webAuthCopy.cancel}
          </button>
        )}

        <p className="onboarding-consent-note">
          By continuing, you agree to Aura's
          {" "}
          <button type="button" className="onboarding-inline-link" onClick={() => void openUrl(privacyUrl)}>
            {consentCopy.privacyLabel}
          </button>
          {" and "}
          <button type="button" className="onboarding-inline-link" onClick={() => void openUrl(termsUrl)}>
            {consentCopy.termsLabel}
          </button>
          .
        </p>
      </div>
    </div>
  );
}
