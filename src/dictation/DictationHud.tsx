import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { GlassSurface } from "../overlay/GlassSurface";
import { NOTCH_PATH } from "../overlay/NotchBar";
import type { NotchEdge } from "../overlay/notchEdge";
import { useDictationLevels } from "./useDictationLevels";
// This window renders DictationHud, not App, so it loads none of App's CSS.
// The glass tokens and the notch geometry have to be pulled in explicitly or
// the surface falls back to raw chrome on a transparent background.
import "../theme/theme.css";
import "../overlay/GlassSurface.css";
import "../overlay/NotchBar.css";
import "./DictationHud.css";

/// Mirrors HudPhase in src-tauri/src/dictation/hud.rs.
type DictationPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "inserted"
  | "error"
  | "pending";

interface DictationUpdate {
  phase: DictationPhase;
  text: string;
  message?: string;
  /// Always rendered from the Rust side's DICTATION_CHORD.label(). Nothing in
  /// this file may hardcode a chord string.
  chordLabel: string;
  /// The edge Rust docked this window to. Geometry is Rust's; this only picks
  /// the matching rotation class.
  edge: NotchEdge;
}

const IDLE: DictationUpdate = {
  phase: "idle",
  text: "",
  chordLabel: "",
  edge: "top",
};

/// The notch has no status styling of its own, but the class is applied for
/// parity with the voice bar so a future style hooks both surfaces at once.
function statusFor(phase: DictationPhase): string {
  switch (phase) {
    case "listening":
      return "listening";
    case "transcribing":
      return "processing";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

/// The dictation HUD window: a persistent passive pill between holds, then the
/// same notch the voice bar uses while the hotkey is held. The pill has no click
/// action; only the keyboard hook can start capture and recognition.
///
/// It is deliberately wordless. The partial transcript is not shown, because
/// the words are already landing in the app being typed into, and a second copy
/// on screen is just something to read instead of the real thing. The one
/// exception is a failure, which has nowhere else to go.
export function DictationHud() {
  const [update, setUpdate] = useState<DictationUpdate>(IDLE);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const listening = update.phase === "listening";

  useDictationLevels(canvasRef, listening);

  useEffect(() => {
    let live = true;
    const pending = listen<DictationUpdate>("dictation-update", (event) => {
      setUpdate(event.payload);
    });
    // Pull the current state once so startup does not depend on winning a race
    // with the first event. A later event always wins: the listener overwrites
    // whatever this resolves to.
    void invoke<DictationUpdate>("dictation_hud_state")
      .then((current) => {
        if (live) {
          setUpdate((previous) =>
            previous.phase === "idle" && !previous.text ? current : previous,
          );
        }
      })
      .catch(() => {
        // A HUD that cannot read its own state still renders from events.
      });
    return () => {
      live = false;
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  if (update.phase === "idle") {
    const hint = update.chordLabel
      ? `Dictate\nHold ${update.chordLabel}`
      : "Dictate";
    return (
      <div
        className={`dictation-launcher dictation-launcher-${update.edge}`}
        title={hint}
        role="status"
        aria-label={hint.replace("\n", ". ")}
      >
        <GlassSurface className="dictation-launcher__surface" draggable={false}>
          <svg
            className="dictation-launcher__power"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path d="M12 3v8" />
            <path d="M7.4 5.8a8 8 0 1 0 9.2 0" />
          </svg>
        </GlassSurface>
      </div>
    );
  }

  // Held text: the only place the transcript is shown, because the user has to
  // know both that something is waiting and what it says. Rust has already
  // resized the window to the taller pill for this phase.
  if (update.phase === "pending") {
    return (
      <GlassSurface className="dictation-message is-pending" draggable={false}>
        <div className="dictation-message__row">
          <span className="dictation-message__dot" aria-hidden="true" />
          <span className="dictation-message__label">
            {update.message ?? "Waiting for a text box"}
          </span>
        </div>
        <p className="dictation-message__text">{update.text}</p>
      </GlassSurface>
    );
  }

  // A failure is the only other thing worth words here.
  if (update.phase === "error") {
    return (
      <GlassSurface className="dictation-message" draggable={false}>
        <span className="dictation-message__dot" aria-hidden="true" />
        <p className="dictation-message__text">
          {update.message ?? "Nothing was typed."}
        </p>
      </GlassSurface>
    );
  }

  return (
    <div className={`notch-shell notch-shell-${update.edge} dictation-active`}>
      <GlassSurface
        className={`notch-bar notch-bar-${statusFor(update.phase)}`}
        draggable={false}
      >
        <div className="notch-shape">
          <div className="notch-bar-inner is-bare">
            <div className="notch-recorder" aria-hidden="true">
              <canvas ref={canvasRef} className="notch-visualizer" />
            </div>
          </div>
        </div>
        <svg
          className="notch-outline"
          viewBox="0 0 184 29"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="dictation-notch-stroke" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--glass-border-top)" />
              <stop offset="1" stopColor="var(--glass-border-bottom)" />
            </linearGradient>
          </defs>
          <path
            d={NOTCH_PATH}
            fill="none"
            stroke="url(#dictation-notch-stroke)"
            strokeWidth="1"
          />
        </svg>
      </GlassSurface>
    </div>
  );
}

export default DictationHud;
