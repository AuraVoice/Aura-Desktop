import { useRef } from "react";
import { GlassSurface } from "./GlassSurface";
import type { VoiceBarState } from "./useVoiceBar";
import { useAudioLevels } from "./useAudioLevels";
import "./NotchBar.css";

// The "\_/" bucket silhouette: a full-width flush top (it hangs off the top
// screen edge) whose sides sweep inward to a flatter, rounded base. Authored in
// the bar's fixed 460x72 logical space (BAR_WIDTH/BAR_HEIGHT in overlay.rs), so
// the coordinates map 1:1 to CSS pixels at any display scale.
const NOTCH_PATH = "M0,0 H460 V14 C460,46 430,72 384,72 H76 C30,72 0,46 0,14 Z";

interface NotchBarProps {
  voice: VoiceBarState;
  notice?: string | null;
}

export function NotchBar({ voice, notice }: NotchBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const caption = (voice.errorMessage ?? notice ?? voice.assistantCaption).trim();
  useAudioLevels(voice.room, voice.status, canvasRef);

  return (
    <GlassSurface className={`notch-bar notch-bar-${voice.status}`} draggable={false}>
      <div className="notch-shape">
        <div className={`notch-bar-inner${caption ? " notch-bar-inner-captioned" : ""}`}>
          {caption && (
            <div className="notch-copy" aria-live="polite">
              <span className="notch-caption">{caption}</span>
            </div>
          )}
          <div className="notch-recorder" aria-hidden="true">
            <canvas ref={canvasRef} className="notch-visualizer" />
          </div>
        </div>
      </div>
      <svg
        className="notch-outline"
        viewBox="0 0 460 72"
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
  );
}
