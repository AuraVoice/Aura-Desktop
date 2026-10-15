import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "lucide-react";
import {
  BillingPortalError,
  PlanCatalogError,
  fetchBillingPortal,
  fetchPlans,
  type CheckoutFailure,
  type CheckoutPeriod,
  type PlanCatalog,
} from "../../lib/entitlement";
import { logError } from "../../lib/log";
import { useEntitlementState } from "../../state/EntitlementProvider";
import { type EntitlementState } from "../../state/useEntitlement";
import "./PlansDialog.css";

const CHECKOUT_FAILURE_COPY: Record<CheckoutFailure | "open_failed", string> = {
  already_subscribed: "This account already has a plan. Use Manage billing to change it.",
  billing_not_configured: "Buying a plan isn't available right now. Nothing was charged.",
  entitlement_unavailable: "Aura couldn't check your current plan, so checkout didn't open. Try again in a minute.",
  checkout_failed: "The payment page didn't open. Try again in a minute.",
  price_not_approved: "This plan is not available right now. Please pick another plan or contact support.",
  unavailable: "Checkout couldn't start. Check your connection and try again.",
  open_failed: "Your browser didn't open the payment page. Try again.",
};

function catalogErrorCopy(error: unknown): string {
  if (error instanceof PlanCatalogError && error.reason === "billing_not_configured") {
    return "Plans aren't available to buy right now. Your current plan is unaffected.";
  }
  return "Prices couldn't load. Check your connection and try again.";
}

function money(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      minimumFractionDigits: minor % 100 === 0 ? 0 : 2,
    }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

function shortDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** A note about the account's state, or "" when there is nothing to say. */
function accountNote(entitlement: EntitlementState): string {
  if (entitlement.trialDeniedReason === "install_trial_used") {
    return "This computer already used Aura's free trial with another account, so this account starts on Free. You can still pick a plan.";
  }
  if (entitlement.status === "expired" && entitlement.trialEndDate && !entitlement.isPurchased) {
    return `Your trial ended on ${shortDate(entitlement.trialEndDate)}. Everything you made is still here. Pick a plan to get the paid features back.`;
  }
  return "";
}

/**
 * The plans, side by side, priced live by Dodo through GET /billing/plans. Opened
 * from every "See plans" (the trial banner, the research paywall, a locked voice,
 * the Plans and billing page). Buying during the trial carries the remaining days
 * over, so the offer line says when the first charge lands.
 *
 * Portaled into .db-app so it inherits the dashboard tokens, and stacked above
 * the Settings dialog it usually opens from. Escape is taken in the capture phase
 * so it closes this dialog only, never Settings underneath.
 */
export function PlansDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const entitlement = useEntitlementState();
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const [portalError, setPortalError] = useState("");
  const [portalBusy, setPortalBusy] = useState(false);
  const [period, setPeriod] = useState<CheckoutPeriod>("monthly");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  const loadCatalog = useCallback(() => {
    const request = ++requestRef.current;
    setCatalog(null);
    setCatalogError(null);
    fetchPlans()
      .then((result) => { if (request === requestRef.current) setCatalog(result); })
      .catch((err) => {
        if (request !== requestRef.current) return;
        logError("PlansDialog: fetchPlans", err);
        setCatalogError(err);
      });
  }, []);

  useEffect(() => {
    if (!open) return;
    loadCatalog();
    // Account-specific offers are memory-only and refreshed while visible.
    const timer = window.setInterval(loadCatalog, 5 * 60 * 1000);
    return () => { window.clearInterval(timer); requestRef.current++; };
  }, [open, loadCatalog]);

  useEffect(() => {
    if (!open) return;
    const restore = document.activeElement as HTMLElement | null;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    panelRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey, true);
      restore?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const shared = catalog?.catalog;
  const annual = period === "yearly";
  const trialEnd = shortDate(catalog?.trialEndDate ?? entitlement.trialEndDate);
  const checkout = entitlement.checkout;
  const busyTier = checkout.phase === "opening" || checkout.phase === "polling" ? checkout.tier : null;
  const note = accountNote(entitlement);
  const purchased = catalog?.hasActiveSubscription === true;
  const accountKnown = catalog?.hasActiveSubscription !== null && catalog !== null;
  const currentTier = purchased ? catalog?.purchasedTier : "free";
  const currentPlan = shared?.plans.find(plan => plan.tier === currentTier);
  const currentOrder = currentPlan?.order ?? 0;

  const manageBilling = async () => {
    if (portalBusy) return;
    setPortalBusy(true);
    setPortalError("");
    try {
      await openUrl(catalog?.subscriptionSource === "apple"
        ? "https://apps.apple.com/account/subscriptions"
        : await fetchBillingPortal());
    } catch (err) {
      logError("PlansDialog: open billing portal", err);
      setPortalError(
        err instanceof BillingPortalError && err.reason === "no_billing_account"
          ? "This plan wasn't bought through Aura checkout, so there is no billing to manage."
          : "Billing couldn't open just now. Try again in a minute.",
      );
    } finally {
      setPortalBusy(false);
    }
  };

  const target = document.querySelector(".db-app") ?? document.body;

  return createPortal(
    <div className="db-plans-scrim" onClick={onClose}>
      <div
        ref={panelRef}
        className="db-plans-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="db-plans-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="db-plans-head">
          {accountKnown && currentPlan && <span className="db-plans-chip">Your plan: {currentPlan.name}</span>}
          <h2 id="db-plans-title">{shared?.headline ?? "Plans"}</h2>
          <div className="db-plans-toggle" role="group" aria-label="Billing period">
            <button type="button" aria-pressed={!annual} className={!annual ? "is-on" : ""} onClick={() => setPeriod("monthly")}>
              Monthly
            </button>
            <button type="button" aria-pressed={annual} className={annual ? "is-on" : ""} onClick={() => setPeriod("yearly")}>
              Annual
            </button>
          </div>
          <button type="button" className="db-plans-close" aria-label="Close plans" onClick={onClose}>
            <X size={18} aria-hidden />
          </button>
        </header>
        {shared && <p className="db-plans-subtitle">{shared.subtitle}</p>}
        {entitlement.isTrialing && <p className="db-plans-fine">
          Your existing trial continues{trialEnd ? ` until ${trialEnd}` : ""}. Purchased plan and trial access are shown separately.
        </p>}
        {!catalog && catalogError === null && <p role="status">Loading plans...</p>}
        {catalogError !== null && (
          <div className="db-plans-status" role="alert">
            <span>{catalogErrorCopy(catalogError)}</span>
            <button type="button" onClick={loadCatalog}>Try again</button>
          </div>
        )}
        {catalog && !catalog.checkoutAvailable && <div className="db-plans-status" role="status">
          <span>{catalog.checkoutError === "price_not_approved" ? "These prices aren't set up at checkout yet." : "Checkout prices are unavailable."} Your current plan and trial are unaffected.</span>
          <button type="button" onClick={loadCatalog}>Refresh prices</button>
        </div>}

        <div className="db-plans-grid">
          {shared?.plans.map((plan) => {
            const id = plan.tier;
            const paid = id !== "free";
            const option = catalog?.plans.find(price => price.tier === id && price.period === period);
            const featured = Boolean(plan.badge);
            const mine = busyTier === id;
            const current = accountKnown && currentTier === id;
            const inherited = shared.plans.find(other => other.tier === plan.inherits);
            let cta = plan.cta;
            let action: (() => void) | null = null;
            if (!accountKnown) {
              cta = "Plan status unavailable";
            } else if (current) {
              cta = "Current plan";
            } else if (purchased) {
              cta = plan.order > currentOrder ? "Upgrade" : "Switch plan";
              if (entitlement.billingManageable !== false || catalog?.subscriptionSource === "apple") {
                action = () => void manageBilling();
              }
            } else if (mine && checkout.phase === "opening") {
              cta = "Opening checkout...";
            } else if (mine && checkout.phase === "polling") {
              cta = "Waiting for payment...";
            } else if (paid) {
              cta = "Upgrade";
              if (option && catalog?.checkoutAvailable) action = () => entitlement.startCheckout(id, period);
            }
            const disabled = action === null || portalBusy || busyTier !== null;

            return (
              <article key={id} className={`db-plans-card${featured ? " is-featured" : ""}`}>
                <div className="db-plans-card-head">
                  <h3>{plan.name}</h3>
                  {plan.badge && <span className="db-plans-badge">{plan.badge}</span>}
                </div>
                <div className="db-plans-price">
                  <span className="db-plans-amount">
                    {paid ? (option ? money(option.priceMinor, option.currency) : "Unavailable")
                      : money(plan.marketing_price.amount_minor, plan.marketing_price.currency)}
                  </span>
                  {paid && option && <span className="db-plans-per">{annual ? "/year" : "/month"}</span>}
                </div>
                {paid && option && annual &&
                  <p className="db-plans-fine">About {money(Math.round(option.priceMinor / 12), option.currency)} a month, billed yearly.</p>}
                <p className="db-plans-offer">{plan.description}</p>
                {paid && option && !purchased && entitlement.isTrialing && trialEnd &&
                  <p className="db-plans-fine">First charge after your trial ends on {trialEnd}.</p>}
                <button
                  type="button"
                  className={`db-plans-cta${featured && paid && !purchased ? " is-primary" : ""}`}
                  disabled={disabled}
                  onClick={action ?? undefined}
                >
                  {cta}
                </button>
                {mine && checkout.phase === "polling" && (
                  <div className="db-plans-waiting">
                    <span>Finish in your browser. This updates by itself.</span>
                    <button type="button" onClick={entitlement.cancelCheckout}>Cancel</button>
                  </div>
                )}
                <div className="db-plans-features">
                  <span className="db-plans-features-head">{inherited ? `Everything in ${inherited.name}, plus:` : "What's included"}</span>
                  <ul>
                    {plan.features.map((feature) => (
                      <li key={feature}>
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
                          <path d="M3.2 8.4l3.1 3.1 6.5-7" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        <span>{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </article>
            );
          })}
        </div>

        {shared && <>
          <p className="db-plans-fine">{shared.footnote}</p>
          <details className="db-plans-comparison">
            <summary>Compare usage</summary>
            <div className="db-plans-grid">
              {shared.plans.map(plan => <section key={plan.tier}>
                <h3>{plan.name}</h3>
                <dl>{plan.allowances.map(allowance => <div key={allowance.id}>
                  <dt>{allowance.label}</dt><dd>{allowance.value}</dd>
                </div>)}</dl>
              </section>)}
            </div>
          </details>
          <details className="db-plans-comparison">
            <summary>Platform availability</summary>
            <div className="db-plans-grid">
              {shared.plans.map(plan => <section key={plan.tier}>
                <h3>{plan.name}</h3>
                <dl>{plan.availability.map(feature => <div key={feature.id}>
                  <dt>{feature.label}</dt>
                  <dd>{feature.platforms.map(id => shared.platforms.find(p => p.id === id)?.label ?? id).join(", ")}
                    {feature.note && <p>{feature.note}</p>}</dd>
                </div>)}</dl>
              </section>)}
            </div>
          </details>
          {shared.notices.map(notice => <p className="db-plans-fine" key={notice}>{notice}</p>)}
        </>}
        {purchased && (entitlement.billingManageable !== false || catalog?.subscriptionSource === "apple") &&
          <button type="button" className="db-plans-cta" disabled={portalBusy} onClick={() => void manageBilling()}>
            {portalBusy ? "Opening billing..." : "Manage billing"}
          </button>}
        {checkout.phase === "error" && (
          <p className="db-plans-status is-error" role="alert">{CHECKOUT_FAILURE_COPY[checkout.reason]}</p>
        )}
        {checkout.phase === "upgraded" && (
          <p className="db-plans-status" role="status">Your plan is active. Thanks for supporting Aura.</p>
        )}
        {portalError && <p className="db-plans-status is-error" role="alert">{portalError}</p>}
        {note && <p className="db-plans-status" role="status">{note}</p>}
        <p className="db-plans-fine">
          Paid prices come from Dodo Payments. Checkout confirms applicable taxes and the amount charged.
          Existing subscriptions keep their purchased terms. Manage billing with the provider you purchased from.
        </p>
      </div>
    </div>,
    target,
  );
}
