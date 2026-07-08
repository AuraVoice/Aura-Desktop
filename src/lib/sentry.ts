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
  // Dev sessions must not report: Vite dev mode transpiles without
  // typechecking (a mid-edit bare identifier becomes a runtime
  // ReferenceError) and HMR re-renders against stale fibers when a hook
  // file's hook count changes - both land in the feed looking exactly like
  // shipped-build crashes (NATIVE-1 and NATIVE-2 were this noise, see
  // lessons-learnt.txt 2026-07-07). Dev errors already surface in the dev
  // console where the developer is looking.
  if (import.meta.env.DEV) return;
  Sentry.init({
    dsn: DSN,
    release: `aura-desktop@${packageJson.version}`,
    environment: import.meta.env.MODE,
  });
  initialized = true;
}

export function captureException(error: unknown, extra?: Record<string, unknown>): void {
  Sentry.captureException(error, extra ? { extra } : undefined);
}
