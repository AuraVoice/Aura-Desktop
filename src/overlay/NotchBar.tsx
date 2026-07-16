import { useRef } from "react";
import { GlassSurface } from "./GlassSurface";
import type { VoiceBarState } from "./useVoiceBar";
import { useAudioLevels } from "./useAudioLevels";
import "./NotchBar.css";

interface NotchBarProps {
  voice: VoiceBarState;
  notice?: string | null;
}

export function NotchBar({ voice }: NotchBarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const caption = voice.assistantCaption.trim();
  useAudioLevels(voice.room, voice.status, canvasRef);

  return (
    <GlassSurface className={`notch-bar notch-bar-${voice.status}`} draggable={false}>
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
    </GlassSurface>
  );
}
