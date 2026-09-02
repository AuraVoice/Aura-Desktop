import { useRef } from "react";
import type { PointerEventHandler } from "react";
import { altLabel } from "../lib/platformKeys";
import { GlassSurface } from "./GlassSurface";
import type { VoiceBarState } from "./useVoiceBar";
import type { NotchEdge } from "./notchEdge";
import { useAudioLevels } from "./useAudioLevels";
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
  outputMuted?: boolean;
}

export function NotchBar({
  voice,
  edge,
  dragHandlers,
  guideArmed = false,
  guideActive = false,
  outputMuted = false,
}: NotchBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useAudioLevels(voice.room, voice.status, canvasRef);
  const showGuideStatus = guideArmed || guideActive;

  return (
    <div className={`notch-shell notch-shell-${edge}`} {...dragHandlers}>
      <GlassSurface className={`notch-bar notch-bar-${voice.status}`} draggable={false}>
        <div className="notch-shape">
          <div className={`notch-bar-inner${showGuideStatus ? " has-guide" : ""}${outputMuted ? " has-output-mute" : ""}`}>
            <div className="notch-recorder" aria-hidden="true">
              <canvas ref={canvasRef} className="notch-visualizer" />
            </div>
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
            {outputMuted && (
              <span
                className="notch-mute-indicator"
                aria-label="Voice muted"
                title={`Voice muted. Ctrl+${altLabel()}+M`}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 9.5h4L13 5v14l-5-4.5H4z" />
                  <path d="M16 9l5 6M21 9l-5 6" />
                </svg>
              </span>
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
