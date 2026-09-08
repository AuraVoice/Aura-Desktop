import posthog from "posthog-js/dist/module.full.no-external";
import type { AnalyticsEvent } from "./analyticsEvents";
import { logError } from "./log";
import { osName, platformTag } from "./platformKeys";
import { redactSecrets } from "./redact";
import { setSentryUser } from "./sentry";

/** Public PostHog project token - same project the Flutter app reports to, so
 * events are comparable across platforms. Client-side-safe by PostHog's own
 * design, not a secret. */
const PROJECT_TOKEN = "phc_CDtz3DmNraHdnJ2w9W7WJNkJ8VANYPBWAcqV2Uf77k5s";
const HOST = "https://us.i.posthog.com";

const STATIC_PROPERTIES = { platform: "desktop-react", $os: osName() };
let superProperties: Record<string, unknown> = {};

// Single shared gate: both PostHog (here) and Sentry (see lib/sentry.ts) check
// this same in-memory flag, kept in sync with the persisted consent flag by
// telemetryInit.ts in every window and flipped immediately when the consent
// screen is accepted. Defaults closed so nothing can fire before consent is
// read. The SDK carries its own copy of the same decision
// (opt_out_capturing_by_default + opt_in_capturing), so even a call that slips
// past this flag is dropped inside posthog-js until consent lands.
let telemetryEnabled = false;
let sdkReady = false;
let windowLabel = "unknown";
let identifiedUid: string | null = null;

/** Property keys that look like they could carry user content. Any string
 * value under one of these is dropped before it leaves the machine, whatever
 * event it rode in on. Counts, booleans and enums pass untouched. The one
 * allowed exception is client_log's own (already redacted, capped) message. */
const CONTENT_KEY_PATTERN = /text|transcript|message|body|title|prompt/i;

function stripContentLikeProperties(
  properties: Record<string, unknown>,
  eventName: string,
): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (
      typeof value === "string"
      && value.length > 0
      && CONTENT_KEY_PATTERN.test(key)
      && !(eventName === "client_log" && key === "message")
    ) {
      continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

export interface AnalyticsSdkOptions {
  /** Tauri window label; becomes the `window_label` super property and gates
   * session replay (never recorded in the dictation HUD or status pill). */
  label: string;
  /** Per-install id (desktop_anon_id). Used as the pre-sign-in distinct id so
   * existing PostHog persons keyed by it keep their history. */
  installId: string;
  superProperties?: Record<string, unknown>;
}

/** Boots posthog-js for this window. Sync, cheap, and safe to call before
 * consent is known: the SDK starts opted out and nothing is sent until
 * setTelemetryEnabled(true). Any throw is logged and the module keeps
 * behaving as "analytics off" for the life of the window. */
export function initAnalyticsSdk(options: AnalyticsSdkOptions): void {
  if (sdkReady) return;
  windowLabel = options.label;
  const replayOff = options.label === "dictation" || options.label === "status-pill";
  try {
    posthog.init(PROJECT_TOKEN, {
      api_host: HOST,
      persistence: "localStorage",
      opt_out_capturing_by_default: true,
      opt_out_capturing_persistence_type: "localStorage",
      person_profiles: "always",
      bootstrap: { distinctID: options.installId, isIdentifiedID: false },
      capture_pageview: false,
      capture_pageleave: false,
      autocapture: false,
      capture_dead_clicks: false,
      rageclick: false,
      // Sentry owns exceptions; PostHog only sees product events.
      capture_exceptions: false,
      disable_surveys: true,
      disable_web_experiments: true,
      // The CSP's script-src is 'self', so the recorder must ship in the
      // bundle (dist/module.full.no-external) and nothing may be fetched as
      // a script at runtime.
      disable_external_dependency_loading: true,
      disable_session_recording: replayOff,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: "*",
        blockClass: "ph-no-capture",
        blockSelector: ".ph-no-capture",
        recordCrossOriginIframes: false,
      },
      request_batching: true,
      sanitize_properties: stripContentLikeProperties,
      // Belt and braces for the dictation HUD: even a capture that slips past
      // the label checks above never leaves that window.
      before_send: (result) => (options.label === "dictation" ? null : result),
    });
    superProperties = { ...superProperties, ...(options.superProperties ?? {}) };
    posthog.register({ ...STATIC_PROPERTIES, ...superProperties, window_label: options.label });
    sdkReady = true;
  } catch (err) {
    logError("analytics: init", err);
  }
}

export function setTelemetryEnabled(enabled: boolean): void {
  telemetryEnabled = enabled;
  if (!sdkReady) return;
  try {
    if (enabled) posthog.opt_in_capturing();
    else posthog.opt_out_capturing();
  } catch (err) {
    logError("analytics: setTelemetryEnabled", err);
  }
}

export function isTelemetryEnabled(): boolean {
  return telemetryEnabled;
}

export function setAnalyticsSuperProperties(properties: Record<string, unknown>): void {
  superProperties = { ...superProperties, ...properties };
  if (!sdkReady) return;
  try {
    posthog.register(properties);
  } catch (err) {
    logError("analytics: register", err);
  }
}

/** True means the event was handed to the SDK's queue, which batches and
 * retries with backoff on its own; it does NOT mean PostHog acknowledged it.
 * The durable, acknowledged path for onboarding events is the backend outbox
 * in profile.ts. */
function captureEvent(event: string, properties?: Record<string, unknown>): boolean {
  if (!telemetryEnabled || !sdkReady) return false;
  try {
    posthog.capture(event, properties);
    return true;
  } catch (err) {
    logError(`analytics: trackEvent (${event})`, err);
    return false;
  }
}

/** Fire-and-forget: analytics must never break a call, so failures only log.
 * The SDK queues and retries; nothing here awaits the network. */
export function trackEvent(event: AnalyticsEvent, properties?: Record<string, unknown>): void {
  captureEvent(event, properties);
}

export function trackEventWithResult(
  event: AnalyticsEvent,
  properties?: Record<string, unknown>,
): Promise<boolean> {
  return Promise.resolve(captureEvent(event, properties));
}

/** Dashboard route change. Hash-router paths, so the URL is synthesised: the
 * webview's real location is the same index.html for every page. */
export function trackPageView(path: string): void {
  captureEvent("$pageview", { path, $current_url: `app://dashboard${path}` });
}

/** Sets person properties on the current PostHog person. `distinctId` is kept
 * for API compatibility with the pre-SDK callers (pre-sign-in callers passed
 * the install id, post-sign-in callers the uid); the SDK always writes to
 * its current distinct id, which those callers already match. */
export function setPersonProperties(
  properties: Record<string, unknown>,
  distinctId?: string,
): void {
  if (!telemetryEnabled || !sdkReady) return;
  try {
    const current = posthog.get_distinct_id();
    if (distinctId && current !== distinctId) {
      logError("analytics: setPersonProperties", `distinct id mismatch (wanted ${distinctId})`);
    }
    posthog.setPersonProperties(properties);
  } catch (err) {
    logError("analytics: setPersonProperties", err);
  }
}

/** Merges the pre-sign-in anonymous person (captured under `anonId`) into the
 * real user (`uid`) so attribution set before sign-in follows the account.
 * When the SDK is still on the anonymous id this is a plain identify (the SDK
 * sends $anon_distinct_id itself); otherwise an explicit alias. Resolves true
 * once the call was queued. */
export function aliasAnonymousToUser(anonId: string, uid: string): Promise<boolean> {
  if (!telemetryEnabled || !sdkReady) return Promise.resolve(false);
  try {
    if (posthog.get_distinct_id() === anonId) {
      posthog.identify(uid);
    } else {
      posthog.alias(anonId, uid);
    }
    identifiedUid = uid;
    return Promise.resolve(true);
  } catch (err) {
    logError("analytics: aliasAnonymousToUser", err);
    return Promise.resolve(false);
  }
}

/** Sign-in: point both PostHog and Sentry at the account. Idempotent per uid. */
export function identifyUser(uid: string): void {
  if (identifiedUid === uid) return;
  identifiedUid = uid;
  setSentryUser(uid);
  if (!sdkReady) return;
  try {
    posthog.identify(uid);
  } catch (err) {
    logError("analytics: identify", err);
  }
}

export function hasIdentifiedUser(): boolean {
  return identifiedUid !== null;
}

/** Sign-out: drop the account identity so later events never land on it.
 * posthog.reset() also clears the SDK's stored consent (a documented side
 * effect of opt_out_capturing_by_default), so consent and the super
 * properties are re-applied right after. */
export function resetTelemetryIdentity(): void {
  identifiedUid = null;
  setSentryUser(null);
  if (!sdkReady) return;
  try {
    posthog.reset();
    if (telemetryEnabled) posthog.opt_in_capturing();
    posthog.register({ ...STATIC_PROPERTIES, ...superProperties, window_label: windowLabel });
  } catch (err) {
    logError("analytics: reset", err);
  }
}

// ── client_log: the desktop twin of the Flutter app_logger remote capture ──
// Every logError call becomes a rate-limited, redacted PostHog event so a
// tester's silent failure shows up in a dashboard instead of only in a log
// file nobody has asked for yet. Never fires from the dictation HUD window.
const CLIENT_LOG_MAX_CHARS = 240;
const CLIENT_LOG_WINDOW_MS = 10 * 60 * 1000;
const CLIENT_LOG_MAX_PER_WINDOW = 20;
const CLIENT_LOG_CONTEXT_COOLDOWN_MS = 60 * 1000;
let clientLogWindowStart = 0;
let clientLogWindowCount = 0;
const clientLogLastByContext = new Map<string, number>();

export function trackClientLog(severity: "warn" | "error", context: string, message: string): void {
  if (import.meta.env.DEV) return;
  if (!telemetryEnabled || !sdkReady) return;
  if (windowLabel === "dictation") return;
  // The analytics module reports its own failures through logError; never
  // turn one of those into another capture.
  if (context.startsWith("analytics:")) return;
  const now = Date.now();
  if (now - clientLogWindowStart > CLIENT_LOG_WINDOW_MS) {
    clientLogWindowStart = now;
    clientLogWindowCount = 0;
  }
  if (clientLogWindowCount >= CLIENT_LOG_MAX_PER_WINDOW) return;
  const last = clientLogLastByContext.get(context);
  if (last !== undefined && now - last < CLIENT_LOG_CONTEXT_COOLDOWN_MS) return;
  clientLogLastByContext.set(context, now);
  clientLogWindowCount += 1;
  captureEvent("client_log", {
    severity,
    tag: context,
    message: redactSecrets(message).slice(0, CLIENT_LOG_MAX_CHARS),
    platform: platformTag(),
  });
}
