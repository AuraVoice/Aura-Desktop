import { fetch } from "@tauri-apps/plugin-http";
import { auth } from "./firebase";
import { logError } from "./log";

/** Public PostHog project token - same project the Flutter app reports to, so
 * events are comparable across platforms. Client-side-safe by PostHog's own
 * design, not a secret. */
const PROJECT_TOKEN = "phc_CDtz3DmNraHdnJ2w9W7WJNkJ8VANYPBWAcqV2Uf77k5s";
const HOST = "https://us.i.posthog.com";

const STATIC_PROPERTIES = { platform: "desktop-react", $os: "Windows" };

// Single shared gate: both PostHog (here) and Sentry (see lib/sentry.ts) check
// this same in-memory flag, kept in sync with the persisted consent flag by
// App.tsx on every launch and flipped immediately when the consent screen is
// accepted. Defaults closed so nothing can fire before consent is read.
let telemetryEnabled = false;

export function setTelemetryEnabled(enabled: boolean): void {
  telemetryEnabled = enabled;
}

/** Plain HTTP capture, not the posthog-js SDK - mirrors the Flutter app's own
 * Windows desktop build, which hits the same wall (no Windows implementation
 * for its native PostHog plugin) and works around it the same way.
 * Fire-and-forget: analytics must never break a call, so failures only log. */
export function trackEvent(event: string, properties?: Record<string, unknown>): void {
  if (!telemetryEnabled) return;
  const distinctId = auth.currentUser?.uid ?? "anonymous";
  fetch(`${HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: PROJECT_TOKEN,
      event,
      distinct_id: distinctId,
      timestamp: new Date().toISOString(),
      properties: { ...STATIC_PROPERTIES, ...properties },
    }),
  })
    .then((response) => {
      if (!response.ok) {
        logError("analytics: trackEvent", `${event} -> HTTP ${response.status}`);
      }
    })
    .catch((err) => logError(`analytics: trackEvent (${event})`, err));
}
