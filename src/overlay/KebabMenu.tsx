import { useEffect, useRef, useState } from "react";
import { GlassSurface } from "./GlassSurface";
import { CalendarIcon, DashboardIcon, FeedbackIcon, SignOutIcon } from "./icons";
import { kebabMenu as copy } from "../lib/copy";
import { sendFeedback } from "../lib/feedback";
import { openDashboard } from "../lib/dashboardLink";
import { logError } from "../lib/log";
import "./KebabMenu.css";

const FEEDBACK_SENT_FLASH_MS = 2500;

/**
 * The overflow menu behind the bar's kebab, rendered below the bar in the
 * shared slot (it can't live inside VoiceBar's 64px subtree). Calendar and Sign
 * out are coordinated by OverlayRoot (Calendar opens the agenda card; Sign out
 * puts VoiceBar into its existing confirm takeover); Dashboard and Feedback are
 * self-contained. Every row is a real <button> (drag-region rule).
 */
export function KebabMenu({
  voiceStatus,
  onCalendar,
  onSignOut,
}: {
  voiceStatus: string;
  onCalendar: () => void;
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

  return (
    <GlassSurface className="kebab-menu" draggable={false}>
      <div className="kebab-menu-inner">
        <button type="button" className="kebab-menu-item" onClick={onCalendar}>
          <CalendarIcon />
          <span>{copy.calendar}</span>
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
  );
}
