import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { onAuthStateChanged } from "firebase/auth";
import { Store } from "@tauri-apps/plugin-store";
import packageJson from "../../package.json";
import {
  hasIdentifiedUser,
  identifyUser,
  initAnalyticsSdk,
  isTelemetryEnabled,
  resetTelemetryIdentity,
  setTelemetryEnabled,
  trackEvent,
} from "./analytics";
import { API_BASE_URL, fetchWithTimeout } from "./api";
import { desktopConsentAcceptedKey, overlayStorePath } from "./copy";
import { getOrCreateDesktopInstallId } from "./desktopInstallId";
import { collectDesktopMetadata, posthogSafeMetadata } from "./desktopMetadata";
import { auth } from "./firebase";
import { TELEMETRY_CONSENT_CHANGED, UPDATE_CHECK_RESULT } from "./ipcEvents";
import { captureException, initSentryForWindow } from "./sentry";
import { logError, logInfo } from "./log";
import { platformTag } from "./platformKeys";

/** Every window boots the same bundle (see main.tsx), so every window runs
 * this once. It owns the one telemetry on/off decision for PostHog and
 * Sentry, the identity join on sign-in and sign-out, and the two health
 * signals the beta needs (heartbeat, crash-loop beacon). Nothing here is
 * awaited by React: the root renders whether or not any of this succeeds,
 * and every step is bounded by a deadline and a try/catch. */

const INIT_DEADLINE_MS = 5_000;
const IPC_DEADLINE_MS = 3_000;
const DIAGNOSTICS_POST_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

let readyResolve: (() => void) | null = null;
const readyPromise = new Promise<void>((resolve) => {
  readyResolve = resolve;
});
let currentLabel = "unknown";
let consentAccepted = false;

/** Resolves once the SDKs are initialised for this window (or once init has
 * given up); acquisitionAnalytics awaits it so its first events are not
 * dropped by a not-yet-booted SDK. */
export function telemetryReady(): Promise<void> {
  return readyPromise;
}

function withDeadline<T>(label: string, ms: number, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function installGlobalErrorHandlers(label: string): void {
  // Sentry's own integration also hooks these, but only once consent turns
  // it on; this guarantees a line in the log file in every build, and hands
  // the error to Sentry when it is enabled (a no-op otherwise).
  window.addEventListener("error", (event) => {
    logError(`window: unhandled error (${label})`, event.error ?? event.message);
    captureException(event.error ?? new Error(String(event.message)), { window_label: label });
  });
  window.addEventListener("unhandledrejection", (event) => {
    logError(`window: unhandled rejection (${label})`, event.reason);
    captureException(event.reason, { window_label: label });
  });
}

function watchAuthIdentity(): void {
  try {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        identifyUser(user.uid);
      } else if (hasIdentifiedUser()) {
        // Sign-out from another window (the overlay's Ctrl+Shift+D, the
        // dashboard's account page): drop the identity here too, so this
        // window's later events never land on the old account.
        resetTelemetryIdentity();
      }
    });
  } catch (err) {
    logError("telemetryInit: auth watch", err);
  }
}

function watchConsentFromOtherWindows(): void {
  listen(TELEMETRY_CONSENT_CHANGED, () => {
    if (consentAccepted) return;
    consentAccepted = true;
    setTelemetryEnabled(true);
    initSentryForWindow(currentLabel, true);
  }).catch((err) => logError("telemetryInit: listen consent", err));
}

/** Called the moment the consent screen is accepted (OnboardingFlow, main
 * window). Turns both SDKs on here and tells every other open window. */
export async function enableTelemetryAfterConsent(): Promise<void> {
  consentAccepted = true;
  setTelemetryEnabled(true);
  initSentryForWindow(currentLabel, true);
  await emit(TELEMETRY_CONSENT_CHANGED).catch((err) =>
    logError("telemetryInit: emit consent", err),
  );
}

async function boot(label: string): Promise<void> {
  const store = await Store.load(overlayStorePath);
  const [accepted, installId] = await Promise.all([
    store.get<boolean>(desktopConsentAcceptedKey),
    getOrCreateDesktopInstallId(store),
  ]);
  const metadata = await collectDesktopMetadata(store, installId, auth.currentUser?.uid);
  initAnalyticsSdk({ label, installId, superProperties: posthogSafeMetadata(metadata) });
  consentAccepted = accepted === true;
  if (consentAccepted) {
    setTelemetryEnabled(true);
    initSentryForWindow(label, true);
  } else {
    initSentryForWindow(label, false);
  }
}

export function initTelemetryForWindow(label: string): void {
  currentLabel = label;
  installGlobalErrorHandlers(label);
  withDeadline("telemetryInit: boot", INIT_DEADLINE_MS, boot(label))
    .catch((err) => logError("telemetryInit: boot", err))
    .finally(() => {
      readyResolve?.();
      watchAuthIdentity();
      watchConsentFromOtherWindows();
      if (label === "main") {
        startHeartbeat();
        watchUpdateChecks();
        void reportStartupDiagnostics();
      }
    });
}

// ── Updater ─────────────────────────────────────────────────────────────────
// Mirrors updater.rs UpdateCheckResult. The updater emits app-wide and the
// six-hour loop repeats the same verdict, so each (outcome, version) pair is
// reported once per process from the main window only.
interface UpdateCheckResult {
  outcome: "available" | "up_to_date" | "check_failed" | "download_failed";
  version: string | null;
}

const reportedUpdateChecks = new Set<string>();

function watchUpdateChecks(): void {
  listen<UpdateCheckResult>(UPDATE_CHECK_RESULT, (event) => {
    const { outcome, version } = event.payload;
    if (outcome === "up_to_date") return;
    const key = `${outcome}:${version ?? ""}`;
    if (reportedUpdateChecks.has(key)) return;
    reportedUpdateChecks.add(key);
    trackEvent(
      outcome === "available" ? "desktop_update_available" : "desktop_update_check_failed",
      { outcome, version },
    );
  }).catch((err) => logError("telemetryInit: listen update-check-result", err));
}

// ── Heartbeat ───────────────────────────────────────────────────────────────
// Mirrors telemetry.rs DiagnosticsSnapshot. A missing heartbeat from an
// install with an open session is the "hung app" signal MONITORING.md reads.
interface DiagnosticsSnapshot {
  dictation_worker_lost: boolean;
  dictation_available: boolean;
  dictation_blocker: string | null;
  voice_toggle_available: boolean;
  meeting_state: string;
  updater_pending_version: string | null;
  log_file_bytes: number;
  uptime_s: number;
  crash_reporter_alive: boolean;
}

async function sendHeartbeat(): Promise<void> {
  if (!isTelemetryEnabled()) return;
  try {
    const snapshot = await withDeadline(
      "diagnostics_snapshot",
      IPC_DEADLINE_MS,
      invoke<DiagnosticsSnapshot>("diagnostics_snapshot"),
    );
    const windows = await getAllWebviewWindows().catch(() => []);
    trackEvent("desktop_heartbeat", { ...snapshot, window_count: windows.length });
  } catch (err) {
    logError("telemetryInit: heartbeat", err);
  }
}

function startHeartbeat(): void {
  setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
}

// ── Crash-loop beacon ───────────────────────────────────────────────────────
// Mirrors telemetry.rs StartupDiagnostics. Rust decides whether the previous
// run ended cleanly; this side only posts when it did not. Consent-gated,
// unlike the Android beacon, because the desktop privacy copy promises that
// nothing leaves the machine before consent.
interface StartupDiagnostics {
  should_report: boolean;
  payload: {
    install_id: string | null;
    app_version: string;
    os_platform: string;
    os_version: string;
    os_arch: string;
    launch_count: number;
    consecutive_failed_launches: number;
    last_exit: { kind: string; at: string | null };
    crash_reporter_alive: boolean;
    previous_app_version: string | null;
  };
}

async function reportStartupDiagnostics(): Promise<void> {
  if (!isTelemetryEnabled()) return;
  try {
    const diagnostics = await withDeadline(
      "startup_diagnostics_snapshot",
      IPC_DEADLINE_MS,
      invoke<StartupDiagnostics>("startup_diagnostics_snapshot"),
    );
    if (!diagnostics.should_report) return;
    const response = await fetchWithTimeout(
      `${API_BASE_URL}/diagnostics/desktop`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Aura-Platform": platformTag(),
          "X-Aura-App-Version": packageJson.version,
        },
        body: JSON.stringify(diagnostics.payload),
      },
      DIAGNOSTICS_POST_TIMEOUT_MS,
    );
    if (response.status === 404) {
      // Backend not deployed yet; the beacon is best-effort and never retried.
      logInfo("telemetryInit: startup diagnostics", "endpoint not live, skipped");
      return;
    }
    if (!response.ok) {
      logError("telemetryInit: startup diagnostics", `HTTP ${response.status}`);
      return;
    }
    trackEvent("desktop_startup_diagnostics_sent", {
      last_exit_kind: diagnostics.payload.last_exit.kind,
      consecutive_failed_launches: diagnostics.payload.consecutive_failed_launches,
    });
  } catch (err) {
    logError("telemetryInit: startup diagnostics", err);
  }
}
