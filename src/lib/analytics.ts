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

/** Shared fire-and-forget POST to PostHog's capture endpoint, used by the
 * person-property and alias calls below. Same failure posture as trackEvent:
 * analytics never breaks a flow, so errors only log. */
function postCapture(label: string, payload: Record<string, unknown>): void {
  fetch(`${HOST}/capture/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: PROJECT_TOKEN,
      timestamp: new Date().toISOString(),
      ...payload,
    }),
  })
    .then((response) => {
      if (!response.ok) {
        logError(`analytics: ${label}`, `HTTP ${response.status}`);
      }
    })
    .catch((err) => logError(`analytics: ${label}`, err));
}

/** Sets person properties on a PostHog person via a $set on an $identify event.
 * `distinctId` lets pre-sign-in callers attach properties to the per-install
 * anonymous id (desktop_anon_id) rather than the shared "anonymous" fallback;
 * post-sign-in callers pass the uid. */
export function setPersonProperties(
  properties: Record<string, unknown>,
  distinctId?: string,
): void {
  if (!telemetryEnabled) return;
  const id = distinctId ?? auth.currentUser?.uid ?? "anonymous";
  postCapture("setPersonProperties", {
    event: "$identify",
    distinct_id: id,
    properties: { ...STATIC_PROPERTIES, $set: properties },
  });
}

/** Merges the pre-sign-in anonymous person (captured under `anonId`) into the
 * real user (`uid`) so attribution set before sign-in follows the account.
 * We alias a per-install id, never the literal "anonymous" - see
 * desktopAnonIdKey in copy.ts for why. */
export function aliasAnonymousToUser(anonId: string, uid: string): void {
  if (!telemetryEnabled) return;
  postCapture("aliasAnonymousToUser", {
    event: "$create_alias",
    distinct_id: uid,
    properties: { ...STATIC_PROPERTIES, alias: anonId },
  });
}
