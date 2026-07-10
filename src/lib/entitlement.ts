import { authFetch } from "./api";

/**
 * GET /entitlement + POST /billing/checkout wrappers, mirroring the thin
 * per-feature helpers (voice.ts, calendar.ts, draft.ts): authFetch + a
 * per-request timeout + a defensive parser that maps the backend's snake_case
 * body to camelCase and degrades safely on anything malformed.
 *
 * Entitlement is the account's subscription state, written only by the backend
 * (the Dodo payment webhook). The desktop is a pure reader: it fetches this,
 * caches it via the Rust store for offline grace, and opens the web checkout -
 * it never writes entitlement anywhere.
 */

export type EntitlementTier = "free" | "companion" | "pro";
export type EntitlementStatus = "trialing" | "active" | "gracePeriod" | "expired";
export type CheckoutTier = "companion" | "pro";
export type CheckoutPeriod = "monthly" | "yearly";

/** The desktop's read of GET /entitlement. `raw` keeps the untouched JSON body
 * so the Rust offline cache can store it verbatim and replay it back through
 * this same parser on a later launch. */
export interface Entitlement {
  tier: EntitlementTier;
  effectiveTier: EntitlementTier;
  status: EntitlementStatus;
  trialEndDate: string | null;
  cancelAtPeriodEnd: boolean;
  raw: unknown;
}

const TIERS: readonly string[] = ["free", "companion", "pro"];
const STATUSES: readonly string[] = ["trialing", "active", "gracePeriod", "expired"];

const FETCH_TIMEOUT_MS = 10_000;
const CHECKOUT_TIMEOUT_MS = 15_000;

function asTier(value: unknown): EntitlementTier {
  return typeof value === "string" && TIERS.includes(value) ? (value as EntitlementTier) : "free";
}

function asStatus(value: unknown): EntitlementStatus {
  // Unknown/missing status resolves to "expired": never grant access off a
  // value this client doesn't understand.
  return typeof value === "string" && STATUSES.includes(value)
    ? (value as EntitlementStatus)
    : "expired";
}

/** Parses a GET /entitlement body (or a cached copy of one). Never throws;
 * unknown tier -> free and unknown status -> expired, so a malformed payload
 * can never hand out a paid tier. Returns null only for a non-object input. */
export function parseEntitlement(json: unknown): Entitlement | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  return {
    tier: asTier(obj.tier),
    effectiveTier: asTier(obj.effective_tier),
    status: asStatus(obj.status),
    trialEndDate: typeof obj.trial_end_date === "string" ? obj.trial_end_date : null,
    cancelAtPeriodEnd: obj.cancel_at_period_end === true,
    raw: json,
  };
}

/** GET /entitlement: the account's subscription state. Throws on a transport
 * failure, a non-2xx, or a malformed body (AuthRequiredError on 401/403, from
 * authFetch). */
export async function fetchEntitlement(): Promise<Entitlement> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await authFetch("/entitlement", { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`fetchEntitlement failed: ${response.status}`);
    }
    const parsed = parseEntitlement(await response.json());
    if (!parsed) {
      throw new Error("fetchEntitlement: malformed response");
    }
    return parsed;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** POST /billing/checkout: returns the Dodo hosted-checkout URL to open in the
 * system browser. The backend binds the caller's uid into the session metadata,
 * so paying on the web unlocks this desktop (and the phone) together. */
export async function postCheckout(tier: CheckoutTier, period: CheckoutPeriod): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CHECKOUT_TIMEOUT_MS);
  try {
    const response = await authFetch("/billing/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, period }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`postCheckout failed: ${response.status}`);
    }
    const data = (await response.json()) as { checkout_url?: string };
    if (!data.checkout_url) {
      throw new Error("postCheckout: response missing checkout_url");
    }
    return data.checkout_url;
  } finally {
    clearTimeout(timeoutId);
  }
}
