import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import "./DictationHud.css";

/// Mirrors HudPhase in src-tauri/src/dictation/hud.rs.
type DictationPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "inserted"
  | "error";

interface DictationUpdate {
  phase: DictationPhase;
  text: string;
  message?: string;
  /// Always rendered from the Rust side's DICTATION_CHORD.label(). Nothing in
  /// this file may hardcode a chord string.
  chordLabel: string;
}

const IDLE: DictationUpdate = { phase: "idle", text: "", chordLabel: "" };

function hint(update: DictationUpdate): string {
  switch (update.phase) {
    case "listening":
      return update.text
        ? `Release ${update.chordLabel} to type`
        : `Listening, hold ${update.chordLabel}`;
    case "transcribing":
      return "Finishing up";
    case "inserted":
      return "Typed";
    case "error":
      return update.message ?? "Nothing was typed";
    default:
      return "";
  }
}

/// The dictation HUD window. Click-through and never focused, so it is purely
/// a caption: no controls, no scroll container, no drag region. Long partials
/// are clamped in CSS rather than scrolled, which keeps a native OS scrollbar
/// off the transparent surface.
export function DictationHud() {
  const [update, setUpdate] = useState<DictationUpdate>(IDLE);

  useEffect(() => {
    const pending = listen<DictationUpdate>("dictation-update", (event) => {
      setUpdate(event.payload);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  return (
    <div className={`dictation-hud dictation-hud--${update.phase}`}>
      <div className="dictation-hud__row">
        <span className="dictation-hud__dot" aria-hidden="true" />
        <span className="dictation-hud__hint">{hint(update)}</span>
      </div>
      <p className="dictation-hud__text">{update.text}</p>
    </div>
  );
}

export default DictationHud;
