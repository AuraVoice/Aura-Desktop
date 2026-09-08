import * as Sentry from "@sentry/browser";
import packageJson from "../../package.json";
import { osName } from "./platformKeys";

// Public/client-safe ingestion key, not a secret to protect - same Sentry
// project the Rust side reports to (see sentry_setup.rs), same reasoning
// this file's sibling analytics.ts already documents for its PostHog token:
// a DSN is a write-only ingestion key meant to be embedded in shipped code.
const DSN = "https://eac19fd147547b09aa774070f00b18f8@o4511685555519488.ingest.us.sentry.io/4511685630361600";

const MESSAGE_MAX_CHARS = 240;
/** Same key test analytics.ts applies to event properties: anything that
 * could hold user content is stripped from extras, contexts and breadcrumb
 * data before the report leaves the machine. */
const CONTENT_KEY_PATTERN = /text|transcript|message|body|title|prompt/i;

let initialized = false;
let windowLabel = "unknown";

function scrubRecord(record: Record<string, unknown> | undefined): void {
  if (!record) return;
  for (const key of Object.keys(record)) {
    if (CONTENT_KEY_PATTERN.test(key) && typeof record[key] === "string") {
      record[key] = "[stripped]";
    }
  }
}

function scrubEvent(event: Sentry.ErrorEvent): Sentry.ErrorEvent | null {
  // The dictation HUD renders live transcript text; nothing from that window
  // is ever reported, whatever the payload looks like.
  if (windowLabel === "dictation") return null;
  scrubRecord(event.extra);
  if (event.contexts) {
    for (const context of Object.values(event.contexts)) {
      scrubRecord(context as Record<string, unknown> | undefined);
    }
  }
  for (const crumb of event.breadcrumbs ?? []) {
    scrubRecord(crumb.data);
    if (crumb.message) crumb.message = crumb.message.slice(0, MESSAGE_MAX_CHARS);
  }
  if (event.message) event.message = event.message.slice(0, MESSAGE_MAX_CHARS);
  return event;
}

/** Call once per window, after the persisted telemetry-consent flag is known
 * (see telemetryInit.ts) - mirrors analytics.ts's gate so both telemetry
 * integrations share one on/off decision. Safe to call with enabled=false:
 * it just skips init, and captureException below silently no-ops without a
 * client (Sentry's own documented behavior), so call sites never need to
 * check "is Sentry on" themselves. */
export function initSentryForWindow(label: string, enabled: boolean): void {
  windowLabel = label;
  if (!enabled || initialized) return;
  // Dev sessions must not report: Vite dev mode transpiles without
  // typechecking (a mid-edit bare identifier becomes a runtime
  // ReferenceError) and HMR re-renders against stale fibers when a hook
  // file's hook count changes - both land in the feed looking exactly like
  // shipped-build crashes (NATIVE-1 and NATIVE-2 were this noise, see
  // lessons-learnt.txt 2026-07-07). Dev errors already surface in the dev
  // console where the developer is looking.
  if (import.meta.env.DEV) return;
  try {
    Sentry.init({
      dsn: DSN,
      release: `aura-desktop@${packageJson.version}`,
      environment: import.meta.env.MODE,
      sendDefaultPii: false,
      initialScope: {
        tags: { window_label: label, app_version: packageJson.version, os: osName() },
      },
      beforeSend: scrubEvent,
    });
    initialized = true;
  } catch {
    // Nothing durable to report a failure of the reporter itself; the
    // captureException no-op path covers every later call.
  }
}

/** Kept for the callers that predate per-window init (OnboardingFlow's
 * consent acceptance). Same gate, main-window label. */
export function initSentryIfEnabled(enabled: boolean): void {
  initSentryForWindow(windowLabel === "unknown" ? "main" : windowLabel, enabled);
}

export function setSentryUser(uid: string | null): void {
  try {
    Sentry.setUser(uid ? { id: uid } : null);
  } catch {
    // Sentry not initialised in this window; nothing to attach the user to.
  }
}

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  try {
    Sentry.captureException(error, extra ? { extra } : undefined);
  } catch {
    // Never let the reporter become a second failure on top of the first.
  }
}
