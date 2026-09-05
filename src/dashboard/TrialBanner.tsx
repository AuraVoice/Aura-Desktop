import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Store } from "@tauri-apps/plugin-store";
import { desktopTrialBannerDismissedForUidKey, overlayStorePath, subscription as copy } from "../lib/copy";
import { logError } from "../lib/log";
import { useEntitlementState } from "../state/EntitlementProvider";
import "./TrialBanner.css";

/** Trial countdown milestones. Dismissal is remembered per milestone, so the
 * banner comes back as the trial actually runs down instead of nagging on every
 * launch or vanishing for all 45 days after one click. */
function trialBucket(daysLeft: number): string {
  if (daysLeft > 14) return "early";
  if (daysLeft > 7) return "14";
  if (daysLeft > 3) return "7";
  if (daysLeft > 1) return "3";
  return "last";
}

export function TrialBanner({ uid }: { uid: string }) {
  const entitlement = useEntitlementState();
  const navigate = useNavigate();
  // `undefined` means the store read is still in flight. Rendering nothing until
  // it lands is what stops a dismissed banner flashing on every dashboard open.
  const [dismissedBucket, setDismissedBucket] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setDismissedBucket(undefined);
    Store.load(overlayStorePath)
      .then((store) => store.get<string>(desktopTrialBannerDismissedForUidKey(uid)))
      .then((bucket) => {
        if (!cancelled) setDismissedBucket(bucket ?? null);
      })
      .catch((err) => {
        logError("TrialBanner: read dismissed", err);
        if (!cancelled) setDismissedBucket(null);
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  const daysLeft = entitlement.trialDaysLeft;
  // Never claim a trial we cannot actually see: a failed read shows nothing. An
  // expired trial shows nothing either, Plans and Billing stays the place for
  // that.
  const eligible = entitlement.known && entitlement.isTrialing && daysLeft > 0;
  const bucket = trialBucket(daysLeft);

  if (!eligible || dismissedBucket === undefined || dismissedBucket === bucket) return null;

  const dismiss = () => {
    // Hide locally first: a store write failure must never leave an
    // undismissable banner.
    setDismissedBucket(bucket);
    Store.load(overlayStorePath)
      .then(async (store) => {
        await store.set(desktopTrialBannerDismissedForUidKey(uid), bucket);
        await store.save();
      })
      .catch((err) => logError("TrialBanner: persist dismissed", err));
  };

  return (
    <section className="db-trial-banner" role="status">
      <div className="db-trial-banner-copy">
        <strong>{daysLeft <= 1 ? copy.trialLastDay : copy.trialDaysLeft(daysLeft)}</strong>
        <span>{copy.trialBannerBody}</span>
      </div>
      <div className="db-trial-banner-actions">
        <button type="button" className="db-trial-banner-primary" onClick={() => navigate("/billing")}>
          {copy.trialBannerCta}
        </button>
        <button type="button" className="db-trial-banner-dismiss" onClick={dismiss}>
          {copy.trialBannerDismiss}
        </button>
      </div>
    </section>
  );
}
