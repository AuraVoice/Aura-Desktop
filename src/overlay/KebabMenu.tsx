import { useEffect, useRef, useState } from "react";
import { GlassSurface } from "./GlassSurface";
import { CalendarIcon, DashboardIcon, FeedbackIcon, RecordDotIcon, SignOutIcon } from "./icons";
import { kebabMenu as copy, subscription as subCopy } from "../lib/copy";
import { meetingNotes as notesCopy } from "../lib/meetingCopy";
import { sendFeedback } from "../lib/feedback";
import { openDashboard } from "../lib/dashboardLink";
import { logError } from "../lib/log";
import type { CheckoutPhase, EntitlementState } from "../state/useEntitlement";
import "./KebabMenu.css";

const FEEDBACK_SENT_FLASH_MS = 2500;

// The desktop's single upgrade default: Companion, yearly (the featured,
// best-value plan across mobile + web). The Dodo-hosted page and the web
// pricing/dashboard cover Pro and monthly for anyone who wants them.
const UPGRADE_TIER = "companion" as const;
const UPGRADE_PERIOD = "yearly" as const;

/**
 * The overflow menu behind the bar's kebab, rendered below the bar in the
 * shared slot (it can't live inside VoiceBar's 64px subtree). It's a compact
 * popover anchored to the slot's top-right (under the kebab icon); the rest of
 * the slot stays a transparent drag region so grabbing below the bar still
 * moves the window. A plan line + Upgrade button sit at the top (subscription
 * state), then Calendar and Sign out are coordinated by OverlayRoot; Dashboard
 * and Feedback are self-contained. Every row is a real <button> (drag-region
 * rule).
 */
export function KebabMenu({
  voiceStatus,
  entitlement,
  onCalendar,
  onCaptureNow,
  capturing,
  onSignOut,
}: {
  voiceStatus: string;
  entitlement: EntitlementState;
  onCalendar: () => void;
  /** Manual meeting-notes capture (the Google Meet path, no auto-detect). */
  onCaptureNow: () => void;
  capturing: boolean;
  onSignOut: () => void;
}) {
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackJustSent, setFeedbackJustSent] = useState(false);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    },
    [],
  );

  function handleFeedback() {
    if (feedbackSending) return;
    setFeedbackSending(true);
    sendFeedback(voiceStatus)
      .then(() => {
        setFeedbackJustSent(true);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFeedbackJustSent(false), FEEDBACK_SENT_FLASH_MS);
      })
      .catch((err) => logError("KebabMenu: sendFeedback", err))
      .finally(() => setFeedbackSending(false));
  }

  const showPlan = entitlement.loaded && entitlement.status !== "unknown";
  const checkoutBusy =
    entitlement.checkout.phase === "opening" || entitlement.checkout.phase === "polling";

  function handleUpgrade() {
    if (checkoutBusy || entitlement.checkout.phase === "upgraded") return;
    entitlement.startCheckout(UPGRADE_TIER, UPGRADE_PERIOD);
  }

  return (
    <div className="kebab-menu-slot" data-tauri-drag-region="deep">
      <GlassSurface className="kebab-menu" draggable={false}>
        <div className="kebab-menu-inner">
          {showPlan && (
            <>
              <div className="kebab-menu-plan">
                <span className="kebab-menu-plan-line">{planLineFor(entitlement)}</span>
                {!entitlement.isPurchased && (
                  <button
                    type="button"
                    className="kebab-menu-upgrade"
                    onClick={handleUpgrade}
                    disabled={checkoutBusy || entitlement.checkout.phase === "upgraded"}
                  >
                    {upgradeLabelFor(entitlement.checkout)}
                  </button>
                )}
              </div>
              <div className="kebab-menu-sep" />
            </>
          )}
          <button type="button" className="kebab-menu-item" onClick={onCalendar}>
            <CalendarIcon />
            <span>{copy.calendar}</span>
          </button>
          <button
            type="button"
            className="kebab-menu-item"
            onClick={onCaptureNow}
            disabled={capturing}
          >
            <RecordDotIcon />
            <span>{capturing ? notesCopy.captureNowBusy : notesCopy.captureNow}</span>
          </button>
          <button type="button" className="kebab-menu-item" onClick={() => void openDashboard()}>
            <DashboardIcon />
            <span>{copy.dashboard}</span>
          </button>
          <button
            type="button"
            className="kebab-menu-item"
            onClick={handleFeedback}
            disabled={feedbackSending}
          >
            <FeedbackIcon />
            <span>{feedbackJustSent ? copy.feedbackSent : copy.feedback}</span>
          </button>
          <button
            type="button"
            className="kebab-menu-item kebab-menu-item-danger"
            onClick={onSignOut}
          >
            <SignOutIcon />
            <span>{copy.signOut}</span>
          </button>
        </div>
      </GlassSurface>
    </div>
  );
}

function planLineFor(entitlement: EntitlementState): string {
  if (entitlement.status === "trialing") {
    return entitlement.trialDaysLeft <= 1
      ? subCopy.trialLastDay
      : subCopy.trialDaysLeft(entitlement.trialDaysLeft);
  }
  const name = entitlement.tier === "pro" ? "Pro" : entitlement.tier === "companion" ? "Companion" : null;
  if (!name) return subCopy.freePlan;
  return entitlement.status === "gracePeriod" ? subCopy.paymentIssue(name) : subCopy.paidPlan(name);
}

function upgradeLabelFor(checkout: CheckoutPhase): string {
  switch (checkout.phase) {
    case "opening":
      return subCopy.upgradeOpening;
    case "polling":
      return subCopy.upgradeWaiting;
    case "upgraded":
      return subCopy.upgraded;
    case "error":
      return subCopy.upgradeFailed;
    default:
      return subCopy.upgrade;
  }
}
