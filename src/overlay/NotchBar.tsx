import { useRef } from "react";
import type { PointerEventHandler } from "react";
import { GlassSurface } from "./GlassSurface";
import type { VoiceBarState } from "./useVoiceBar";
import type { NotchEdge } from "./notchEdge";
import { useAudioLevels } from "./useAudioLevels";
import { KebabIcon } from "./icons";
import "./NotchBar.css";

// The compact waveform-only pill (subtitle removed): a "\_/" bucket silhouette
// authored in a fixed 184x29 logical space (40% of the old 460x72 bar, matching
// NOTCH_MAIN/NOTCH_CROSS in overlay.rs) with its flat side flush to the screen
// edge and its rounded side facing center. The per-edge rotation that hugs each
// edge lives in NotchBar.css (.notch-shell-<edge>); the shape is authored once
// here for the Top orientation and rotated as a whole.
// Exported because the dictation HUD renders the same silhouette in its own
// window. One path string, so the two notches cannot drift apart.
export const NOTCH_PATH =
  "M0,0 H184 V5.6 C184,18.4 172,28.8 153.6,28.8 H30.4 C12,28.8 0,18.4 0,5.6 Z";

// Pointer handlers the move gesture (useNotchMove) attaches to the pill so a
// press-and-drag can lift it into edge-picking. Optional so NotchBar still
// renders standalone (tests, onboarding) without the gesture wired.
export interface NotchDragHandlers {
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
}

interface NotchBarProps {
  voice: VoiceBarState;
  edge: NotchEdge;
  dragHandlers?: NotchDragHandlers;
  guideArmed?: boolean;
  guideActive?: boolean;
  menuOpen?: boolean;
  onMenuToggle?: () => void;
}

export function NotchBar({
  voice,
  edge,
  dragHandlers,
  guideArmed = false,
  guideActive = false,
  menuOpen = false,
  onMenuToggle,
}: NotchBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useAudioLevels(voice.room, voice.status, canvasRef);
  const showGuideStatus = guideArmed || guideActive;

  return (
    <div className={`notch-shell notch-shell-${edge}`} {...dragHandlers}>
      <GlassSurface className={`notch-bar notch-bar-${voice.status}`} draggable={false}>
        <div className="notch-shape">
          <div className={`notch-bar-inner${showGuideStatus ? " has-guide" : ""}`}>
            <div className="notch-recorder" aria-hidden="true">
              <canvas ref={canvasRef} className="notch-visualizer" />
            </div>
            {onMenuToggle && (
              <button
                type="button"
                className={`notch-menu-trigger${menuOpen ? " is-open" : ""}`}
                aria-label={menuOpen ? "Close Aura menu" : "Open Aura menu"}
                aria-expanded={menuOpen}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  onMenuToggle();
                }}
              >
                <KebabIcon />
              </button>
            )}
            {showGuideStatus && (
              <span
                className={`notch-guide-indicator ${
                  guideActive ? "is-active" : "is-starting"
                }`}
                aria-label={
                  guideActive
                    ? "Guide Mode is watching this screen"
                    : "Guide Mode is starting"
                }
                title={guideActive ? "Guide Mode active" : "Guide Mode starting"}
              />
            )}
          </div>
        </div>
        <svg
          className="notch-outline"
          viewBox="0 0 184 29"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="notch-stroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--glass-border-top)" />
              <stop offset="1" stopColor="var(--glass-border-bottom)" />
            </linearGradient>
          </defs>
          <path d={NOTCH_PATH} fill="none" stroke="url(#notch-stroke)" strokeWidth="1" />
        </svg>
      </GlassSurface>
    </div>
  );
}
