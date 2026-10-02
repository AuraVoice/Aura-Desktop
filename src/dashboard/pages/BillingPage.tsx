import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { BillingPortalError, fetchBillingPortal } from "../../lib/entitlement";
import { logError } from "../../lib/log";
import { useEntitlementState } from "../../state/EntitlementProvider";
import { type EntitlementState } from "../../state/useEntitlement";
import { DataView } from "../DataView";
import {
  SettingsPageLayout,
  SettingsSection,
} from "../components/SettingsPageLayout";
import { type AsyncState } from "../useAsyncData";

/** Copy for each reason the billing portal could not open. "Try again" only
 * where a retry can actually succeed. */
function portalErrorCopy(error: unknown): string {
  if (error instanceof BillingPortalError) {
    if (error.reason === "no_billing_account") {
      return "Your plan wasn't bought through Aura checkout, so there is no billing to manage here.";
    }
    if (error.reason === "billing_not_configured") {
      return "Billing isn't available on Aura right now. Your plan is unaffected.";
    }
    if (error.reason === "portal_failed") {
      return "The billing provider didn't respond. Try again in a minute.";
    }
  }
  return "Billing could not open just now. Check your connection and try again.";
}

function statusLabel(entitlement: EntitlementState): string {
  if (entitlement.status === "unknown") return "Unknown";
  if (entitlement.status === "trialing") return "Trial";
  if (entitlement.status === "gracePeriod") return "Payment issue";
  if (entitlement.status === "expired") return "Expired";
  return "Active";
}

export function BillingPage() {
  const entitlement = useEntitlementState();
  // The same four states DataView renders everywhere else, sourced from the
  // shared entitlement rather than a second GET /entitlement. `loaded && !known`
  // is the real error case: the fetch failed AND no cached copy was inside the
  // 7 day offline grace.
  const state: AsyncState<EntitlementState> = {
    data: entitlement.known ? entitlement : null,
    loading: !entitlement.loaded,
    error: entitlement.loaded && !entitlement.known,
    reload: entitlement.refresh,
  };
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState("");

  const openBillingPortal = async () => {
    if (portalBusy) return;
    setPortalBusy(true);
    setPortalError("");
    try {
      await openUrl(await fetchBillingPortal());
    } catch (err) {
      logError("BillingPage: open billing portal", err);
      setPortalError(portalErrorCopy(err));
    } finally {
      setPortalBusy(false);
    }
  };

  return (
    <SettingsPageLayout
      title="Your plan"
      description="View the plan connected to your Aura account."
    >
      <DataView state={state} isEmpty={() => false} emptyLabel="">
        {(entitlement) => (
          <>
            <div className="db-panel db-billing-summary">
              <div>
                <span className="db-eyebrow">Current plan</span>
                <h3>{entitlement.effectiveTier}</h3>
                <p>One subscription covers Aura on desktop and mobile.</p>
              </div>
              <span className={`db-status-pill${
                entitlement.status === "active" || entitlement.status === "trialing"
                  ? " is-positive"
                  : entitlement.status === "gracePeriod"
                    ? " is-warning"
                    : ""
              }`}>
                {statusLabel(entitlement)}
              </span>
            </div>

            <SettingsSection
              title="Plan details"
              description="Your live subscription status from Aura."
            >
              <div className="db-panel db-details">
                <div className="db-details-row">
                  <span className="db-details-label">Plan</span>
                  <span className="db-details-value">{entitlement.effectiveTier}</span>
                </div>
                <div className="db-details-row">
                  <span className="db-details-label">Status</span>
                  <span className="db-details-value">{statusLabel(entitlement)}</span>
                </div>
                {entitlement.trialEndDate && (
                  <div className="db-details-row">
                    <span className="db-details-label">Trial ends</span>
                    <span className="db-details-value">
                      {new Date(entitlement.trialEndDate).toLocaleDateString()}
                    </span>
                  </div>
                )}
                {entitlement.cancelAtPeriodEnd && (
                  <p className="db-muted db-details-note">
                    Your plan will end at the close of the current billing period.
                  </p>
                )}
                {entitlement.tier !== "free" && entitlement.billingManageable !== false && (
                  <button
                    type="button"
                    className="db-primary-btn"
                    disabled={portalBusy}
                    onClick={() => void openBillingPortal()}
                  >
                    {portalBusy ? "Opening billing..." : "Manage billing"}
                  </button>
                )}
                {entitlement.tier !== "free" && entitlement.billingManageable === false && (
                  <p className="db-muted db-details-note">
                    This plan wasn't bought through Aura checkout, so there is no billing to manage.
                  </p>
                )}
                {portalError && (
                  <p className="db-settings-inline-error" role="alert">
                    {portalError}
                  </p>
                )}
              </div>
            </SettingsSection>
          </>
        )}
      </DataView>
    </SettingsPageLayout>
  );
}
