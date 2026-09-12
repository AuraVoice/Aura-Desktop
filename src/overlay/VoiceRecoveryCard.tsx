import { useState } from "react";
import { Loader2, MicOff, TriangleAlert, X } from "lucide-react";
import { GlassSurface } from "./GlassSurface";
import "./VoiceRecoveryCard.css";

export type VoiceRecoveryVariant = "mic" | "error" | "connecting";

interface VoiceRecoveryCardProps {
  variant: VoiceRecoveryVariant;
  title: string;
  message: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  onPrimary?: () => Promise<void> | void;
  onSecondary?: () => Promise<void> | void;
  onClose: () => Promise<void> | void;
}

/** Must fit the rendered CSS (Rust grows the window by exactly this many
 * logical px): the 11px inset that leaves room for the corner X, 12px
 * padding, the 24px header, an 8px gap, the 28px action row, 12px padding. */
export const VOICE_RECOVERY_CARD_HEIGHT = 95;

function variantIcon(variant: VoiceRecoveryVariant) {
  if (variant === "mic") return <MicOff size={14} strokeWidth={2} aria-hidden="true" />;
  if (variant === "connecting")
    return <Loader2 size={14} strokeWidth={2} aria-hidden="true" className="voice-recovery-spin" />;
  return <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />;
}

export function VoiceRecoveryCard({
  variant,
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
      <div className="voice-recovery-clip">
        <div className="voice-recovery-inner" role="status" aria-live="polite">
          <div className="voice-recovery-header">
            <span className="voice-recovery-icon">{variantIcon(variant)}</span>
            <span className="voice-recovery-text">
              <span className="voice-recovery-title">{title}</span>
              <span className="voice-recovery-message" title={message}>
                {message}
              </span>
            </span>
          </div>
          {((primaryLabel && onPrimary) || (secondaryLabel && onSecondary)) && (
          <div className="voice-recovery-actions">
            {secondaryLabel && onSecondary && (
              <button
                type="button"
                className="voice-recovery-secondary"
                disabled={busy}
                onClick={() => void run(onSecondary)}
              >
                {secondaryLabel}
              </button>
            )}
            {primaryLabel && onPrimary && (
              <button
                type="button"
                className="voice-recovery-primary"
                disabled={busy}
                onClick={() => void run(onPrimary)}
              >
                {primaryLabel}
              </button>
            )}
          </div>
          )}
        </div>
      </div>
      <button
        type="button"
        className="voice-recovery-close"
        disabled={busy}
        onClick={() => void run(onClose)}
        aria-label="Dismiss"
      >
        <X size={12} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </GlassSurface>
  );
}
