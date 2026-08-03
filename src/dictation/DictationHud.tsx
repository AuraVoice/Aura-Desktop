import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { GlassSurface } from "../overlay/GlassSurface";
import type { NotchEdge } from "../overlay/notchEdge";
import { useDictationLevels } from "./useDictationLevels";
// This window renders DictationHud, not App, so it loads none of App's CSS.
// The glass tokens have to be pulled in explicitly or the surface falls back
// to raw chrome on a transparent background.
import "../theme/theme.css";
import "../overlay/GlassSurface.css";
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
  /// The edge Rust docked this window to. Geometry is Rust's; this only stamps
  /// the matching dock class.
  edge: NotchEdge;
}

interface DictationLauncherProps {
  hotkey: string;
  edge: NotchEdge;
}

const IDLE: DictationUpdate = {
  phase: "idle",
  text: "",
  chordLabel: "",
  edge: "top",
};

function DictationLauncher({ hotkey, edge }: DictationLauncherProps) {
  const [hovered, setHovered] = useState(false);

  const updateHover = (next: boolean) => {
    setHovered(next);
    void invoke("dictation_set_hud_hovered", { hovered: next }).catch(() => {
      setHovered(!next);
    });
  };

  const label = hotkey ? `Dictate with ${hotkey}` : "Dictate";
  return (
    <div
      className={`dictation-launcher dictation-launcher-${edge}`}
      onPointerEnter={() => updateHover(true)}
      onPointerLeave={() => updateHover(false)}
      role="status"
      aria-label={label}
    >
      {hovered ? (
        <div className="dictation-launcher__hover">
          <GlassSurface className="dictation-launcher__hint" draggable={false}>
            <span>Dictate</span>
            {hotkey && <strong>{hotkey}</strong>}
          </GlassSurface>
          <GlassSurface className="dictation-launcher__mic" draggable={false}>
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <rect x="8.5" y="2.5" width="7" height="13" rx="3.5" />
              <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7" />
            </svg>
          </GlassSurface>
        </div>
      ) : (
        <GlassSurface className="dictation-launcher__surface" draggable={false}>
          {null}
        </GlassSurface>
      )}
    </div>
  );
}

/// The dictation HUD window: a persistent passive pill between holds, then the
/// same pill enlarged while the hotkey is held. The pill has no click action;
/// only the keyboard hook can start capture and recognition.
///
/// It is deliberately wordless. The partial transcript is not shown, because
/// the words are already landing in the app being typed into, and a second copy
/// on screen is just something to read instead of the real thing. The one
/// exception is a failure, which has nowhere else to go.
export function DictationHud() {
  const [update, setUpdate] = useState<DictationUpdate>(IDLE);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useDictationLevels(canvasRef, update.phase === "listening", true);

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
    return <DictationLauncher hotkey={update.chordLabel} edge={update.edge} />;
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
    <div
      className={`dictation-launcher dictation-launcher-${update.edge} is-active`}
      role="status"
      aria-label={update.phase === "listening" ? "Dictation listening" : "Dictation processing"}
    >
      <GlassSurface className="dictation-launcher__surface" draggable={false}>
        <canvas ref={canvasRef} className="dictation-listening-visualizer" aria-hidden="true" />
      </GlassSurface>
    </div>
  );
}

export default DictationHud;
