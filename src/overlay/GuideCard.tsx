import type { GuideStep } from "./useGuideMode";
import "./GuideCard.css";

export const GUIDE_CARD_HEIGHT = 180;

interface GuideCardProps {
  step: GuideStep | null;
  stillChecking: boolean;
  blankWarning: boolean;
  onCheckNow: () => void;
  onStop: () => void;
}

export function GuideCard({
  step,
  stillChecking,
  blankWarning,
  onCheckNow,
  onStop,
}: GuideCardProps) {
  const instruction = blankWarning
    ? "Aura can't view this screen. Try another window or stop Guide Mode."
    : stillChecking
      ? "Still checking"
      : step?.instruction ?? "Watching for the next step";

  return (
    <section className="guide-card" aria-live="polite">
      <div className="guide-card-copy">
        <span className="guide-card-kicker">
          {step ? `Step ${step.stepIndex}` : "Guide Mode"}
        </span>
        <p>{instruction}</p>
      </div>
      <div className="guide-card-actions">
        <button type="button" onClick={onCheckNow}>Check now</button>
        <button type="button" onClick={onStop}>Stop</button>
      </div>
    </section>
  );
}
