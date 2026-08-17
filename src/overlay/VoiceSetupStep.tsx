import { useState } from "react";
import type { BuddyVoice } from "../lib/buddyVoices";
import { VoicePickerCards } from "../voice/VoicePickerCards";
import "./VoiceSetupStep.css";

export function VoiceSetupStep({ onContinue }: { onContinue: () => void }) {
  const [saving, setSaving] = useState(false);
  const [lockedVoice, setLockedVoice] = useState<BuddyVoice | null>(null);

  return (
    <div className="onboarding-step voice-setup-step">
      <div className="voice-setup-heading">
        <h2 className="onboarding-heading">Choose Buddy's voice</h2>
        <p className="onboarding-body">
          Tap play to hear one. Your choice starts with your next call and follows you across devices.
        </p>
      </div>
      <VoicePickerCards
        surface="onboarding"
        onLockedVoice={setLockedVoice}
        onSavingChange={setSaving}
      />
      {lockedVoice && (
        <p className="voice-picker-locked-note" role="status">
          {lockedVoice.label} is available with a paid plan. You can switch after onboarding in Plans and Billing.
        </p>
      )}
      <button
        type="button"
        className="onboarding-primary-button voice-setup-continue"
        disabled={saving}
        onClick={onContinue}
      >
        Continue
      </button>
    </div>
  );
}
