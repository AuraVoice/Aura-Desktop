import * as Sentry from "@sentry/browser";
import packageJson from "../../package.json";

// Public/client-safe ingestion key, not a secret to protect - same Sentry
// project the Rust side reports to (see sentry_setup.rs), same reasoning
// this file's sibling analytics.ts already documents for its PostHog token:
// a DSN is a write-only ingestion key meant to be embedded in shipped code.
const DSN = "https://eac19fd147547b09aa774070f00b18f8@o4511685555519488.ingest.us.sentry.io/4511685630361600";

let initialized = false;

/** Call once at startup, after the persisted telemetry-consent flag is known
 * (see App.tsx) - mirrors analytics.ts's gate so both telemetry integrations
 * share one on/off decision. Safe to call with enabled=false: it just skips
 * init, and captureException below silently no-ops without a client
 * (Sentry's own documented behavior), so call sites never need to check
 * "is Sentry on" themselves. */
export function initSentryIfEnabled(enabled: boolean): void {
  if (!enabled || initialized) return;
  Sentry.init({ dsn: DSN, release: `aura-desktop@${packageJson.version}` });
  initialized = true;
}

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  Sentry.captureException(error, extra ? { extra } : undefined);
}
