import { hotkeyTour as copy, hotkeyHints } from "../lib/copy";
import { HotkeyHint } from "./HotkeyHint";

interface HotkeyTourStepProps {
  /** The real double-tap key from voice_toggle_key_status, if resolved, so the
   * caption matches the user's actual configured key instead of a hardcode. */
  keyLabel?: string;
  onContinue: () => void;
}

/** Post-sign-in step that teaches the global shortcuts with keycap UI before the
 * live demo. Pure presentation - the combos come from hotkeyHints. */
export function HotkeyTourStep({ keyLabel, onContinue }: HotkeyTourStepProps) {
  const voiceKeys = keyLabel ? [`${keyLabel} twice`] : hotkeyHints.voice.keys;

  return (
    <div className="onboarding-step">
      <h2 className="onboarding-heading">{copy.heading}</h2>
      <p className="onboarding-body">{copy.body}</p>
      <div className="onboarding-hotkey-list">
        <HotkeyHint keys={voiceKeys} action={hotkeyHints.voice.action} />
        <HotkeyHint keys={hotkeyHints.summon.keys} action={hotkeyHints.summon.action} />
        <HotkeyHint keys={hotkeyHints.dashboard.keys} action={hotkeyHints.dashboard.action} />
        <HotkeyHint keys={hotkeyHints.screenSight.keys} action={hotkeyHints.screenSight.action} />
      </div>
      <button type="button" className="onboarding-primary-button" onClick={onContinue}>
        {copy.button}
      </button>
    </div>
  );
}
