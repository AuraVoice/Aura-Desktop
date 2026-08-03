import { getVersion } from "@tauri-apps/api/app";
import { Store } from "@tauri-apps/plugin-store";
import {
  setAnonymousDistinctId,
  setTelemetryEnabled,
  trackEvent,
  trackEventWithResult,
} from "./analytics";
import {
  desktopConsentAcceptedKey,
  desktopOnboardingSeenKey,
  overlayStorePath,
} from "./copy";
import { logError } from "./log";
import { getOrCreateAnonId } from "./profile";

const firstStartedAtKey = "desktop_first_started_at";
const firstStartedVersionKey = "desktop_first_started_version";
const lastStartedVersionKey = "desktop_last_started_version";
const installObservedSentKey = "desktop_install_observed_sent";
const onboardingStepSentKeyPrefix = "desktop_onboarding_step_sent";
const onboardingCompletedSentKey = "desktop_onboarding_completed_sent";

let startupPromise: Promise<void> | null = null;
let launchSent = false;
const onboardingStepsInFlight = new Set<string>();

type StartupContext = {
  store: Store;
  appVersion: string;
  previousVersion: string | null;
  isReturningInstall: boolean;
};

let startupContext: StartupContext | null = null;

async function sendOnce(
  store: Store,
  sentKey: string,
  event: string,
  properties?: Record<string, unknown>,
): Promise<void> {
  if (await store.get<boolean>(sentKey)) return;
  if (await trackEventWithResult(event, properties)) {
    await store.set(sentKey, true);
  }
}

async function recordStartup(): Promise<void> {
  try {
    const store = await Store.load(overlayStorePath);
    const [appVersion, existingFirstStart, previousVersion, onboardingSeen] = await Promise.all([
      getVersion().catch(() => "unknown"),
      store.get<string>(firstStartedAtKey),
      store.get<string>(lastStartedVersionKey),
      store.get<boolean>(desktopOnboardingSeenKey),
    ]);
    const isReturningInstall = Boolean(existingFirstStart);

    if (!existingFirstStart) {
      await store.set(firstStartedAtKey, new Date().toISOString());
      await store.set(firstStartedVersionKey, appVersion);
    }
    await store.set(lastStartedVersionKey, appVersion);

    const anonId = await getOrCreateAnonId(store);
    setAnonymousDistinctId(anonId);
    startupContext = {
      store,
      appVersion,
      previousVersion: previousVersion ?? null,
      isReturningInstall,
    };

    const consentAccepted = await store.get<boolean>(desktopConsentAcceptedKey);
    if (consentAccepted !== true) return;
    setTelemetryEnabled(true);
    await flushStartupEvents(Boolean(onboardingSeen));
  } catch (err) {
    logError("acquisitionAnalytics: recordStartup", err);
  }
}

export function initializeAcquisitionAnalytics(): Promise<void> {
  startupPromise ??= recordStartup();
  return startupPromise;
}

export async function telemetryConsentAccepted(): Promise<void> {
  await initializeAcquisitionAnalytics();
  setTelemetryEnabled(true);
  await flushStartupEvents(false);
}

async function flushStartupEvents(onboardingSeen: boolean): Promise<void> {
  if (!startupContext) return;
  const { store, appVersion, previousVersion, isReturningInstall } = startupContext;
  await sendOnce(store, installObservedSentKey, "desktop_install_observed", {
    app_version: appVersion,
    previous_version: previousVersion,
    is_returning_install: isReturningInstall,
  });
  if (!launchSent) {
    launchSent = true;
    trackEvent("desktop_app_launched", {
      app_version: appVersion,
      launch_reason: "process_start",
      previous_version: previousVersion,
      is_returning_install: isReturningInstall || onboardingSeen,
    });
  }
}

export async function trackOnboardingStepCompleted(onboardingStep: string): Promise<void> {
  if (onboardingStepsInFlight.has(onboardingStep)) return;
  onboardingStepsInFlight.add(onboardingStep);
  try {
    await initializeAcquisitionAnalytics();
    const store = await Store.load(overlayStorePath);
    await sendOnce(
      store,
      `${onboardingStepSentKeyPrefix}_${onboardingStep}`,
      "desktop_onboarding_step_completed",
      {
        onboarding_step: onboardingStep,
      },
    );
  } catch (err) {
    logError("acquisitionAnalytics: onboarding step", err);
  } finally {
    onboardingStepsInFlight.delete(onboardingStep);
  }
}

export async function trackOnboardingCompleted(): Promise<void> {
  try {
    await initializeAcquisitionAnalytics();
    const store = await Store.load(overlayStorePath);
    await sendOnce(store, onboardingCompletedSentKey, "desktop_onboarding_completed");
  } catch (err) {
    logError("acquisitionAnalytics: onboarding completed", err);
  }
}

export type SignInMethod = "pairing" | "email" | "google";

export function normalizedErrorCode(error: unknown, fallback: string): string {
  let candidate = fallback;
  if (typeof error === "string") candidate = error;
  else if (typeof error === "object" && error !== null && "code" in error) {
    candidate = String(error.code);
  } else if (typeof error === "object" && error !== null && "kind" in error) {
    candidate = String(error.kind);
  }
  return candidate
    .replace(/^auth\//, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unknown";
}

export function beginDesktopSignIn(signInMethod: SignInMethod) {
  const startedAt = performance.now();
  let finished = false;
  trackEvent("desktop_sign_in_started", { sign_in_method: signInMethod });

  return {
    completed() {
      if (finished) return;
      finished = true;
      trackEvent("desktop_sign_in_completed", {
        sign_in_method: signInMethod,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      void trackOnboardingStepCompleted("sign_in");
    },
    failed(error: unknown, fallback = "unknown") {
      if (finished) return;
      finished = true;
      trackEvent("desktop_sign_in_failed", {
        sign_in_method: signInMethod,
        duration_ms: Math.round(performance.now() - startedAt),
        error_code: normalizedErrorCode(error, fallback),
      });
    },
  };
}
