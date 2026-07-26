import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import {
  fetchBillingPortal,
  fetchEntitlement,
  type Entitlement,
} from "../../lib/entitlement";
import { DataView } from "../DataView";
import { useAsyncData } from "../useAsyncData";

function statusLabel(entitlement: Entitlement): string {
  if (entitlement.status === "trialing") return "Trial";
  if (entitlement.status === "gracePeriod") return "Payment issue";
  if (entitlement.status === "expired") return "Expired";
  return "Active";
}

export function BillingPage() {
  const state = useAsyncData(() => fetchEntitlement(), "entitlement");
  const [portalBusy, setPortalBusy] = useState(false);
  const [portalError, setPortalError] = useState(false);

  const openBillingPortal = async () => {
    if (portalBusy) return;
    setPortalBusy(true);
    setPortalError(false);
    try {
      await openUrl(await fetchBillingPortal());
    } catch {
      setPortalError(true);
    } finally {
      setPortalBusy(false);
    }
  };

  return (
    <div className="db-page">
      <DataView state={state} isEmpty={() => false} emptyLabel="">
        {(entitlement) => (
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
                <span className="db-details-value">{new Date(entitlement.trialEndDate).toLocaleDateString()}</span>
              </div>
            )}
            {entitlement.cancelAtPeriodEnd && (
              <p className="db-muted db-details-note">Your plan will end at the close of the current billing period.</p>
            )}
            {entitlement.tier !== "free" && (
              <button
                type="button"
                className="db-primary-btn"
                disabled={portalBusy}
                onClick={() => void openBillingPortal()}
              >
                {portalBusy ? "Opening billing..." : "Manage billing"}
              </button>
            )}
            {portalError && (
              <p className="db-muted db-details-note" role="alert">
                Billing could not open just now. Try again.
              </p>
            )}
          </div>
        )}
      </DataView>
    </div>
  );
}
