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
  type CheckoutTier,
  type PlanCatalog,
} from "../../lib/entitlement";
import { logError } from "../../lib/log";
import { useEntitlementState } from "../../state/EntitlementProvider";
import { type EntitlementState } from "../../state/useEntitlement";
import "./PlansDialog.css";

/** What each plan includes. Every line is what juno-backend actually enforces
 * (services/fair_use.py ceilings, meetings/fields.py caps, research credits,
 * agent quotas), and the website's pricing page says the same. Change both. */
const PLAN_DETAILS: Record<"free" | CheckoutTier, { lead: string; stat: string; statLabel: string; features: string[] }> = {
  free: {
    lead: "To get started:",
    stat: "10 min",
    statLabel: "of voice with Buddy a day",
    features: [
      "25 chats a day",
      "10 web searches a day",
      "Memory and reminders",
      "5 meeting notes a month, kept 7 days",
      "Dictation in any app",
    ],
  },
  companion: {
    lead: "Everything in Free, and:",
    stat: "3 hours",
    statLabel: "of voice a day, chat within fair use",
    features: [
      "Unlimited web search",
      "Calendar and posting to X",
      "Premium voices",
      "20 meeting notes a month",
      "Deep research, 5 a day",
      "Browser agent, 300 steps a month",
    ],
  },
  pro: {
    lead: "Everything in Companion, and:",
    stat: "Unlimited",
    statLabel: "meeting notes, kept forever",
    features: [
      "4 hours of voice a day",
      "Deep research, 10 a day",
      "Browser agent, 600 steps a month",
      "Desktop Operator, 5,000 steps a month",
      "Higher daily fair-use limits",
    ],
  },
};

const PLAN_NAMES: Record<"free" | CheckoutTier, string> = { free: "Free", companion: "Companion", pro: "Pro" };

const CHECKOUT_FAILURE_COPY: Record<CheckoutFailure | "open_failed", string> = {
  already_subscribed: "This account already has a plan. Use Manage plan to change it.",
  billing_not_configured: "Buying a plan isn't available right now. Nothing was charged.",
  entitlement_unavailable: "Aura couldn't check your current plan, so checkout didn't open. Try again in a minute.",
  checkout_failed: "The payment page didn't open. Try again in a minute.",
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

/** "Your plan: ..." for the header chip. */
function currentPlanChip(entitlement: EntitlementState): string {
  if (entitlement.isTrialing) {
    return entitlement.trialDaysLeft > 0
      ? `Your plan: Pro trial, ${entitlement.trialDaysLeft} ${entitlement.trialDaysLeft === 1 ? "day" : "days"} left`
      : "Your plan: Pro trial";
  }
  if (entitlement.isPurchased) return `Your plan: ${PLAN_NAMES[entitlement.tier === "pro" ? "pro" : "companion"]}`;
  return "Your plan: Free";
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
  const [period, setPeriod] = useState<CheckoutPeriod>("monthly");
  const [catalog, setCatalog] = useState<PlanCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<unknown>(null);
  const [portalError, setPortalError] = useState("");
  const [portalBusy, setPortalBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const loadCatalog = useCallback(() => {
    setCatalogError(null);
    fetchPlans()
      .then(setCatalog)
      .catch((err) => {
        logError("PlansDialog: fetchPlans", err);
        setCatalogError(err);
      });
  }, []);

  useEffect(() => {
    if (open && !catalog) loadCatalog();
  }, [open, catalog, loadCatalog]);

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

  const annual = period === "yearly";
  const trialing = entitlement.isTrialing;
  const trialEnd = shortDate(catalog?.trialEndDate ?? entitlement.trialEndDate);
  const checkout = entitlement.checkout;
  const busyTier = checkout.phase === "opening" || checkout.phase === "polling" ? checkout.tier : null;
  const note = accountNote(entitlement);

  const manageBilling = async () => {
    if (portalBusy) return;
    setPortalBusy(true);
    setPortalError("");
    try {
      await openUrl(await fetchBillingPortal());
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

  const priceOf = (tier: CheckoutTier) =>
    catalog?.plans.find((plan) => plan.tier === tier && plan.period === period) ?? null;
  const monthlyOf = (tier: CheckoutTier) =>
    catalog?.plans.find((plan) => plan.tier === tier && plan.period === "monthly") ?? null;

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
          <span className="db-plans-chip">{currentPlanChip(entitlement)}</span>
          <h2 id="db-plans-title">One plan for Aura on your computer and phone.</h2>
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

        {catalogError !== null && (
          <div className="db-plans-status" role="alert">
            <span>{catalogErrorCopy(catalogError)}</span>
            <button type="button" onClick={loadCatalog}>Try again</button>
          </div>
        )}

        <div className="db-plans-grid">
          {(["free", "companion", "pro"] as const).map((id) => {
            const details = PLAN_DETAILS[id];
            const paid = id !== "free";
            const option = paid ? priceOf(id) : null;
            const monthly = paid ? monthlyOf(id) : null;
            const featured = id === "companion";
            const mine = busyTier === id;
            let offer = "";
            if (id === "free") offer = "Yours to keep, no card needed";
            else if (option && trialing && trialEnd) {
              offer = `Free until ${trialEnd}, then ${money(option.priceMinor, option.currency)} ${annual ? "a year" : "a month"}`;
            } else if (option && annual && monthly) {
              const saved = Math.round((1 - option.priceMinor / (monthly.priceMinor * 12)) * 100);
              offer = `About ${money(Math.round(option.priceMinor / 12), option.currency)} a month${saved > 0 ? `, ${saved}% off` : ""}`;
            } else if (option) {
              offer = "Billed monthly. Cancel anytime.";
            }

            let cta: string;
            let action: (() => void) | null = null;
            if (!paid) {
              cta = entitlement.isPurchased ? "Free plan" : trialing ? "Included after your trial" : "Your current plan";
            } else if (entitlement.isPurchased) {
              cta = entitlement.tier === id ? "Manage plan" : `Switch to ${PLAN_NAMES[id]}`;
              action = () => void manageBilling();
            } else if (mine && checkout.phase === "opening") {
              cta = "Opening checkout...";
            } else if (mine && checkout.phase === "polling") {
              cta = "Waiting for payment...";
            } else {
              cta = `Get ${PLAN_NAMES[id]}`;
              action = () => entitlement.startCheckout(id, period);
            }
            const disabled = action === null || (busyTier !== null && !entitlement.isPurchased) || (paid && !option && !entitlement.isPurchased);

            return (
              <article key={id} className={`db-plans-card${featured ? " is-featured" : ""}`}>
                <div className="db-plans-card-head">
                  <h3>{PLAN_NAMES[id]}</h3>
                  {featured && <span className="db-plans-badge">Most popular</span>}
                </div>
                <div className="db-plans-price">
                  <span className="db-plans-amount">
                    {paid ? (option ? money(option.priceMinor, option.currency) : "...") : "$0"}
                  </span>
                  <span className="db-plans-per">{annual ? "/year" : "/month"}</span>
                </div>
                <p className="db-plans-offer">{offer}</p>
                <button
                  type="button"
                  className={`db-plans-cta${featured && paid && !entitlement.isPurchased ? " is-primary" : ""}`}
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
                <div className="db-plans-stat">
                  <span className="db-plans-lead">{details.lead}</span>
                  <span className="db-plans-stat-value">{details.stat}</span>
                  <span>{details.statLabel}</span>
                </div>
                <div className="db-plans-features">
                  <span className="db-plans-features-head">What's included</span>
                  <ul>
                    {details.features.map((feature) => (
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

        {checkout.phase === "error" && (
          <p className="db-plans-status is-error" role="alert">{CHECKOUT_FAILURE_COPY[checkout.reason]}</p>
        )}
        {checkout.phase === "upgraded" && (
          <p className="db-plans-status" role="status">Your plan is active. Thanks for supporting Aura.</p>
        )}
        {portalError && <p className="db-plans-status is-error" role="alert">{portalError}</p>}
        {note && <p className="db-plans-status" role="status">{note}</p>}

        <p className="db-plans-fine">
          Prices are in {catalog?.plans[0]?.currency ?? "USD"} and don't include taxes where they apply. Plans renew
          automatically until you cancel. Cancel anytime from Manage plan, at least 24 hours before renewal, and you
          keep your plan until the period ends. Every plan has a daily fair-use limit set well above normal use; if you
          reach it, Aura tells you when it resets. Payments are handled by Dodo Payments.
        </p>
      </div>
    </div>,
    target,
  );
}
