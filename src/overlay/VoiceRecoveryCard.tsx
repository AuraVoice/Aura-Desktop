import { useState } from "react";
import { GlassSurface } from "./GlassSurface";
import "./VoiceRecoveryCard.css";

interface VoiceRecoveryCardProps {
  title: string;
  message: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary?: () => Promise<void> | void;
  onSecondary?: () => Promise<void> | void;
  onClose: () => Promise<void> | void;
}

export const VOICE_RECOVERY_CARD_HEIGHT = 132;

export function VoiceRecoveryCard({
  title,
  message,
  primaryLabel,
  secondaryLabel,
  onPrimary,
  onSecondary,
  onClose,
}: VoiceRecoveryCardProps) {
  const [busy, setBusy] = useState(false);

  async function run(action: (() => Promise<void> | void) | undefined) {
    if (!action || busy) return;
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  return (
    <GlassSurface className="voice-recovery-card" draggable={false}>
      <div className="voice-recovery-inner" role="status" aria-live="polite">
        <span className="voice-recovery-title">{title}</span>
        <p className="voice-recovery-message">{message}</p>
        <div className="voice-recovery-actions">
          {primaryLabel && onPrimary && (
            <button type="button" className="voice-recovery-primary" disabled={busy} onClick={() => void run(onPrimary)}>
              {primaryLabel}
            </button>
          )}
          {secondaryLabel && onSecondary && (
            <button type="button" className="voice-recovery-secondary" disabled={busy} onClick={() => void run(onSecondary)}>
              {secondaryLabel}
            </button>
          )}
          <button type="button" className="voice-recovery-close" disabled={busy} onClick={() => void run(onClose)}>
            Close
          </button>
        </div>
      </div>
    </GlassSurface>
  );
}
