import { invoke } from "@tauri-apps/api/core";
import { bar as copy } from "../lib/copy";
import { logError } from "../lib/log";
import { EyeIcon } from "./icons";
import type { VoiceBarState } from "./useVoiceBar";
import iconUrl from "../assets/icons/Aura-Icon.png";
import "./GlassPill.css";

interface GlassPillProps {
  voice: VoiceBarState;
  screenSight: { armed: boolean; toggleArmed: () => void };
}

export function GlassPill({ voice, screenSight }: GlassPillProps) {
  const caption = voice.errorMessage || voice.assistantCaption || copy.pillFallbackCaption;

  function activate() {
    invoke("pill_activated").catch((err) => logError("GlassPill: pill_activated", err));
  }

  // A plain <div> rather than <button>: a real button tag always blocks
  // Tauri's drag-region detection unless it carries its own drag-region
  // attribute, and this element needs to support both a stationary click
  // (expand) and a drag (move the window) - the same tension a taskbar icon
  // or dock item resolves the same way.
  return (
    <div
      className="glass-pill"
      role="button"
      tabIndex={0}
      data-tauri-drag-region="deep"
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      }}
    >
      <img src={iconUrl} alt="" className="glass-pill-icon" />
      <span className="glass-pill-caption">{caption}</span>
      {screenSight.armed && (
        <span className="glass-pill-sight-indicator">
          <EyeIcon />
        </span>
      )}
    </div>
  );
}
