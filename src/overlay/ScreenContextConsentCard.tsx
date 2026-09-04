import { GlassSurface } from "./GlassSurface";
import { screenContextConsent as copyStrings } from "../lib/copy";
import "./ScreenContextConsentCard.css";

/**
 * Consent prompt for an agent-requested screen-context enable
 * (screen_context.request, published by the voice worker's
 * enable_screen_context tool). Rendered by OverlayRoot in the below-bar slot.
 * The Allow button is the ONLY thing that flips the voiceScreenContext
 * setting: the agent can ask, never enable. Real <button>s per the
 * drag-region rule.
 */
export function ScreenContextConsentCard({
  onAllow,
  onDismiss,
}: {
  onAllow: () => void;
  onDismiss: () => void;
}) {
  return (
    <GlassSurface className="screen-context-consent-card" draggable={false}>
      <div className="screen-context-consent-inner">
        <span className="screen-context-consent-title">{copyStrings.title}</span>
        <p className="screen-context-consent-body">{copyStrings.body}</p>
        <div className="screen-context-consent-actions">
          <button
            type="button"
            className="screen-context-consent-allow"
            onClick={onAllow}
          >
            {copyStrings.allow}
          </button>
          <button
            type="button"
            className="screen-context-consent-dismiss"
            onClick={onDismiss}
          >
            {copyStrings.dismiss}
          </button>
        </div>
      </div>
    </GlassSurface>
  );
}
