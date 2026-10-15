import { authFetchWithTimeout } from "./api";

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
  /** Whether Manage billing has a billing account to open. Null when the
   * backend predates the field, which keeps the old behaviour (show it). */
  billingManageable: boolean | null;
  /** Whether a checkout can actually be created right now (Dodo configured). */
  checkoutAvailable: boolean | null;
  /** "install_trial_used" when this computer already used the free trial with
   * another account, so this one started on Free. Null otherwise. */
  trialDeniedReason: string | null;
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
    billingManageable: typeof obj.billing_manageable === "boolean" ? obj.billing_manageable : null,
    checkoutAvailable: typeof obj.checkout_available === "boolean" ? obj.checkout_available : null,
    trialDeniedReason:
      typeof obj.trial_denied_reason === "string" && obj.trial_denied_reason ? obj.trial_denied_reason : null,
    raw: json,
  };
}

/** GET /entitlement: the account's subscription state. Throws on a transport
 * failure, a non-2xx, or a malformed body (AuthRequiredError on 401/403, from
 * authFetch). */
export async function fetchEntitlement(): Promise<Entitlement> {
  const response = await authFetchWithTimeout("/entitlement", undefined, FETCH_TIMEOUT_MS);
  if (!response.ok) {
    throw new Error(`fetchEntitlement failed: ${response.status}`);
  }
  const parsed = parseEntitlement(await response.json());
  if (!parsed) {
    throw new Error("fetchEntitlement: malformed response");
  }
  return parsed;
}

/** Why POST /billing/checkout refused, from the backend's `error` field, so the
 * Plans dialog says the real cause. Only checkout_failed and unavailable are
 * worth a retry. */
export type CheckoutFailure =
  | "already_subscribed"
  | "billing_not_configured"
  | "entitlement_unavailable"
  | "checkout_failed"
  | "unavailable";

export class CheckoutError extends Error {
  constructor(readonly reason: CheckoutFailure, status: number) {
    super(`postCheckout failed: ${status} ${reason}`);
    this.name = "CheckoutError";
  }
}

const CHECKOUT_FAILURES: readonly string[] = [
  "already_subscribed",
  "billing_not_configured",
  "entitlement_unavailable",
  "checkout_failed",
];

/** POST /billing/checkout: returns the Dodo hosted-checkout URL to open in the
 * system browser. The backend binds the caller's uid into the session metadata,
 * so paying on the web unlocks this desktop (and the phone) together. During a
 * trial the remaining days carry over, so the first charge lands when it ends. */
export async function postCheckout(tier: CheckoutTier, period: CheckoutPeriod): Promise<string> {
  const response = await authFetchWithTimeout(
    "/billing/checkout",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tier, period }),
    },
    CHECKOUT_TIMEOUT_MS,
  );
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : "";
    const reason = (CHECKOUT_FAILURES.includes(code) ? code : "unavailable") as CheckoutFailure;
    throw new CheckoutError(reason, response.status);
  }
  const data = (await response.json()) as { checkout_url?: string };
  if (!data.checkout_url) {
    throw new Error("postCheckout: response missing checkout_url");
  }
  return data.checkout_url;
}

/** One purchasable plan, priced by Dodo (the merchant of record), so a card can
 * never show a price other than the one charged. */
export interface PlanOption {
  tier: CheckoutTier;
  period: CheckoutPeriod;
  /** In the currency's smallest unit (cents for USD), after the product's discount. */
  priceMinor: number;
  currency: string;
}

export interface MarketingPlan {
  tier: EntitlementTier;
  name: string;
  order: number;
  description: string;
  inherits: string | null;
  features: string[];
  cta: string;
  badge: string | null;
  marketing_price: { amount_minor: number; currency: string; period: "monthly" };
  yearly_price: { amount_minor: number; currency: string; period: "yearly" } | null;
  allowances: { id: string; label: string; value: string }[];
  availability: { id: string; label: string; platforms: string[]; note: string }[];
}

export interface MarketingCatalog {
  schema_version: 1;
  headline: string;
  subtitle: string;
  footnote: string;
  plans: MarketingPlan[];
  platforms: { id: string; label: string }[];
  notices: string[];
}

function parseMarketingCatalog(value: unknown): MarketingCatalog {
  const catalog = value as MarketingCatalog | null;
  if (!catalog || catalog.schema_version !== 1 ||
      typeof catalog.headline !== "string" || typeof catalog.subtitle !== "string" ||
      typeof catalog.footnote !== "string" || !Array.isArray(catalog.plans) ||
      catalog.plans.length !== 3 || !Array.isArray(catalog.platforms) ||
      !catalog.platforms.every(p => p && typeof p.id === "string" && typeof p.label === "string") ||
      !Array.isArray(catalog.notices) || !catalog.notices.every(n => typeof n === "string")) {
    throw new PlanCatalogError("catalog_unavailable", 200);
  }
  const tiers = new Set<string>();
  for (const plan of catalog.plans) {
    if (!plan || !TIERS.includes(plan.tier) || tiers.has(plan.tier) ||
        typeof plan.name !== "string" || !Number.isFinite(plan.order) ||
        typeof plan.description !== "string" || typeof plan.cta !== "string" ||
        (plan.inherits !== null && typeof plan.inherits !== "string") ||
        (plan.badge !== null && typeof plan.badge !== "string") ||
        !Array.isArray(plan.features) || !plan.features.every(f => typeof f === "string") ||
        !plan.marketing_price || !Number.isSafeInteger(plan.marketing_price.amount_minor) ||
        plan.marketing_price.amount_minor < 0 || plan.marketing_price.currency !== "USD" ||
        plan.marketing_price.period !== "monthly" ||
        (plan.yearly_price !== null && (!plan.yearly_price ||
          !Number.isSafeInteger(plan.yearly_price.amount_minor) || plan.yearly_price.amount_minor <= 0 ||
          plan.yearly_price.currency !== "USD" || plan.yearly_price.period !== "yearly")) ||
        !Array.isArray(plan.allowances) || !plan.allowances.every(a =>
          a && typeof a.id === "string" && typeof a.label === "string" && typeof a.value === "string") ||
        !Array.isArray(plan.availability) || !plan.availability.every(a =>
          a && typeof a.id === "string" && typeof a.label === "string" && typeof a.note === "string" &&
          Array.isArray(a.platforms) && a.platforms.every(p => typeof p === "string"))) {
      throw new PlanCatalogError("catalog_unavailable", 200);
    }
    tiers.add(plan.tier);
  }
  return { ...catalog, plans: [...catalog.plans].sort((a, b) => a.order - b.order) };
}

export interface PlanCatalog {
  plans: PlanOption[];
  catalog: MarketingCatalog;
  checkoutAvailable: boolean;
  checkoutError: string | null;
  purchasedTier: EntitlementTier | null;
  hasActiveSubscription: boolean | null;
  subscriptionSource: string | null;
  /** Days a purchase now would carry over before its first charge; null when the
   * backend could not read the account's trial. */
  trialDaysRemaining: number | null;
  trialEndDate: string | null;
}

/** Why GET /billing/plans refused. */
export type PlanCatalogFailure = "billing_not_configured" | "catalog_unavailable" | "unavailable";

export class PlanCatalogError extends Error {
  constructor(readonly reason: PlanCatalogFailure, status: number) {
    super(`fetchPlans failed: ${status} ${reason}`);
    this.name = "PlanCatalogError";
  }
}

/** GET /billing/plans: the plans the Plans dialog offers. Throws PlanCatalogError. */
export async function fetchPlans(): Promise<PlanCatalog> {
  const response = await authFetchWithTimeout("/billing/plans", undefined, FETCH_TIMEOUT_MS);
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || !body) {
    const code = typeof body?.error === "string" ? body.error : "";
    const reason: PlanCatalogFailure =
      code === "billing_not_configured" || code === "catalog_unavailable" ? code : "unavailable";
    throw new PlanCatalogError(reason, response.status);
  }
  const plans: PlanOption[] = [];
  for (const item of Array.isArray(body.plans) ? body.plans : []) {
    const row = item as Record<string, unknown>;
    const tier = row.tier;
    const period = row.period;
    const priceMinor = row.price_minor;
    if (
      (tier === "companion" || tier === "pro") &&
      (period === "monthly" || period === "yearly") &&
      typeof priceMinor === "number" && Number.isSafeInteger(priceMinor) && priceMinor > 0 &&
      typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency)
    ) {
      plans.push({
        tier,
        period,
        priceMinor,
        currency: row.currency as string,
      });
    }
  }
  return {
    plans,
    catalog: parseMarketingCatalog(body.catalog),
    checkoutError: typeof body.checkout_error === "string" ? body.checkout_error : null,
    checkoutAvailable: body.checkout_available === true,
    purchasedTier: typeof body.purchased_tier === "string" && TIERS.includes(body.purchased_tier) ? body.purchased_tier as EntitlementTier : null,
    hasActiveSubscription: typeof body.has_active_subscription === "boolean" ? body.has_active_subscription : null,
    subscriptionSource: typeof body.subscription_source === "string" ? body.subscription_source : null,
    trialDaysRemaining: typeof body.trial_days_remaining === "number" ? body.trial_days_remaining : null,
    trialEndDate: typeof body.trial_end_date === "string" ? body.trial_end_date : null,
  };
}

/** Why GET /billing/portal refused, from the backend's `error` field. Each one
 * needs different copy: only `portal_failed` and `unavailable` are worth a retry. */
export type BillingPortalReason =
  | "no_billing_account"
  | "billing_not_configured"
  | "portal_failed"
  | "unavailable";

export class BillingPortalError extends Error {
  constructor(readonly reason: BillingPortalReason, status: number) {
    super(`fetchBillingPortal failed: ${status} ${reason}`);
    this.name = "BillingPortalError";
  }
}

export async function fetchBillingPortal(): Promise<string> {
  const response = await authFetchWithTimeout("/billing/portal", undefined, CHECKOUT_TIMEOUT_MS);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    const code = typeof body?.error === "string" ? body.error : "";
    const reason: BillingPortalReason =
      code === "no_billing_account" || code === "billing_not_configured" || code === "portal_failed"
        ? code
        : "unavailable";
    throw new BillingPortalError(reason, response.status);
  }
  const data = (await response.json()) as { portal_url?: unknown };
  if (typeof data.portal_url !== "string" || !data.portal_url) {
    throw new Error("fetchBillingPortal: response missing portal_url");
  }
  const url = new URL(data.portal_url);
  if (url.protocol !== "https:") {
    throw new Error("fetchBillingPortal: portal URL is not HTTPS");
  }
  return data.portal_url;
}
