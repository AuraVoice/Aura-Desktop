import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTauriEvent } from "../lib/useTauriEvent";
import { DICTATION_LEVEL, DICTATION_UPDATE } from "../lib/ipcEvents";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { GlassSurface } from "../overlay/GlassSurface";
import { BuddyAvatar, type BuddyMove } from "../components/BuddyAvatar";
import { dictationConsent } from "../lib/copy";
import { subscribeGeneralSettings } from "../lib/generalSettings";
import { logError, logInfo } from "../lib/log";
import type { NotchEdge } from "../overlay/notchEdge";
import { isRightCorner, type CompanionCorner } from "./companionCorner";
import { useDictationLevels } from "./useDictationLevels";
import { useDictationSounds } from "./useDictationSounds";
// This window renders DictationHud, not App, so it loads none of App's CSS.
// The glass tokens have to be pulled in explicitly or the surface falls back
// to raw chrome on a transparent background.
import "../theme/theme.css";
import "../overlay/GlassSurface.css";
import "./DictationHud.css";

/// Mirrors HudPhase in src-tauri/src/dictation/hud.rs.
export type DictationPhase =
  | "idle"
  | "listening"
  | "transcribing"
  | "inserted"
  | "action"
  | "error"
  | "recovery"
  | "pending"
  | "consent";

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
  /// True when Rust sized this window for Bolt in a corner rather than the
  /// pill at the edge. Stamped from the same read that sized the window, so
  /// the tree below never lays out for a mode Rust did not size for.
  companion: boolean;
  corner: CompanionCorner;
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
  companion: false,
  corner: "bottomLeft",
};

const COMPANION_SIZE = 64;

/// Bolt at rest and through a hold: idle in his corner, listening to the live
/// level, thinking while the words are typed, one cheer when they land. The
/// same component instance carries all four phases so his springs never reset
/// mid-hold. Hover is only meaningful at rest (every live phase is
/// click-through), and reports to Rust so the window widens for the hint.
function CompanionRest({
  phase,
  hotkey,
  corner,
  levelRef,
  cheerCount,
}: {
  phase: DictationPhase;
  hotkey: string;
  corner: CompanionCorner;
  levelRef: { current: number };
  cheerCount: number;
}) {
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // One wave when he first appears. BuddyAvatar plays a one-shot on a CHANGE
  // of the count, so it has to go 0 -> 1 after mount rather than start at 1.
  const [waveCount, setWaveCount] = useState(0);
  useEffect(() => {
    setWaveCount(1);
  }, []);
  // Rust closes the menu on any phase change (publish clears its flag); keep
  // the local state in step so it does not reopen stale on the way back.
  useEffect(() => {
    if (phase !== "idle") setMenuOpen(false);
  }, [phase]);

  const updateHover = (next: boolean) => {
    if (phase !== "idle") return;
    setHovered(next);
    if (menuOpen) {
      // The menu lives in this window, so the pointer leaving the window is
      // the "click elsewhere" that closes it.
      if (!next) toggleMenu(false);
      return;
    }
    void invoke("dictation_set_hud_hovered", { hovered: next }).catch(() => {
      setHovered(!next);
    });
  };

  const toggleMenu = (open: boolean) => {
    setMenuOpen(open);
    void invoke("dictation_companion_menu", { open }).catch((error) =>
      logError("DictationHud: companion menu", error),
    );
  };

  // Press and move drags him; press and release clicks him. The OS owns the
  // drag once startDragging runs and usually swallows the pointer-up, so Rust
  // watches the window's own move events and snaps him to the nearest corner
  // when they stop. Starting the drag only after real movement is what leaves
  // a plain click free to open the menu.
  const pressRef = useRef<{ x: number; y: number } | null>(null);
  const DRAG_THRESHOLD = 4;
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (phase !== "idle" || event.button !== 0 || menuOpen) return;
    if ((event.target as HTMLElement).closest(".dictation-companion-menu")) return;
    pressRef.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press) return;
    if (
      Math.abs(event.clientX - press.x) < DRAG_THRESHOLD &&
      Math.abs(event.clientY - press.y) < DRAG_THRESHOLD
    ) {
      return;
    }
    pressRef.current = null;
    void invoke("dictation_companion_drag_begin")
      .then(() => getCurrentWindow().startDragging())
      .catch((error) => logError("DictationHud: drag Bolt", error));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (pressRef.current) {
      pressRef.current = null;
      if ((event.target as HTMLElement).closest(".dictation-companion-menu")) return;
      toggleMenu(!menuOpen);
      return;
    }
    if (phase !== "idle") return;
    void invoke("dictation_companion_drag_end").catch((error) =>
      logError("DictationHud: drop Bolt", error),
    );
  };

  const snooze = (kind: "hour" | "tomorrow") => {
    const until = new Date();
    if (kind === "hour") {
      until.setTime(until.getTime() + 60 * 60 * 1000);
    } else {
      // Tomorrow morning in the user's own clock, which only this side knows.
      until.setHours(8, 0, 0, 0);
      if (until.getTime() <= Date.now()) until.setDate(until.getDate() + 1);
    }
    setMenuOpen(false);
    void invoke("dictation_companion_snooze", { untilMs: until.getTime() }).catch((error) =>
      logError("DictationHud: snooze Bolt", error),
    );
  };

  // "rest", not "idle": idle hops and glances every few seconds, which is
  // charming in a chat row and a distraction in the corner of someone's
  // screen all day. Rest only breathes and blinks; the eyes stay put.
  const move: BuddyMove =
    phase === "listening" ? "listening" : phase === "transcribing" ? "thinking" : "rest";
  const label =
    phase === "listening"
      ? "Dictation listening"
      : phase === "transcribing"
        ? "Dictation processing"
        : hotkey
          ? `Dictate with ${hotkey}`
          : "Dictate";
  return (
    <div
      className={`dictation-companion${isRightCorner(corner) ? " is-right" : ""}`}
      onPointerEnter={() => updateHover(true)}
      onPointerLeave={() => updateHover(false)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      role="status"
      aria-label={label}
    >
      <BuddyAvatar
        move={move}
        size={COMPANION_SIZE}
        tone="light"
        levelRef={levelRef}
        waveCount={waveCount}
        cheerCount={cheerCount}
        className="dictation-companion__bolt"
      />
      {menuOpen ? (
        <div className="dictation-companion-menu" role="menu" aria-label="Bolt">
          <button type="button" role="menuitem" onClick={() => snooze("hour")}>
            Hide for an hour
          </button>
          <button type="button" role="menuitem" onClick={() => snooze("tomorrow")}>
            Hide until tomorrow
          </button>
          <button type="button" role="menuitem" onClick={() => toggleMenu(false)}>
            Never mind
          </button>
        </div>
      ) : (
        hovered &&
        phase === "idle" && (
          <span className="dictation-companion__hint">
            Hold {hotkey ? <strong>{hotkey}</strong> : "the chord"} to dictate
          </span>
        )
      )}
    </div>
  );
}

/// A card phase with the companion on: the card keeps its own size and sits
/// on top, and Bolt stands under it with both arms up, holding it. He is
/// aligned to the corner's side so the card reads as held from the edge.
function CompanionCarry({
  corner,
  children,
}: {
  corner: CompanionCorner;
  children: ReactNode;
}) {
  return (
    <div className={`dictation-carry${isRightCorner(corner) ? " is-right" : ""}`}>
      <div className="dictation-carry__card">{children}</div>
      <BuddyAvatar move="hold" size={COMPANION_SIZE} tone="light" className="dictation-carry__bolt" />
    </div>
  );
}

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

/// The one-time online-dictation prompt. The only surface in the HUD with
/// buttons, and the only phase Rust lets receive clicks besides the resting
/// pill. Nothing has been captured at this point: Rust checks consent before it
/// opens the microphone, so declining costs the user nothing and accepting does
/// not retroactively send anything.
function DictationConsent() {
  const [busy, setBusy] = useState(false);

  const answer = (accepted: boolean) => {
    // Logged before the invoke so a click that reaches React but dies at the
    // bridge is distinguishable from one that never reached the DOM at all.
    logInfo("DictationConsent: answered", `accepted=${accepted}`);
    setBusy(true);
    void invoke("dictation_set_consent", { accepted }).catch(() => {
      // A consent write that failed must not look like it succeeded: leave the
      // prompt up so the next press asks again rather than silently streaming.
      setBusy(false);
    });
  };

  return (
    <GlassSurface className="dictation-consent" draggable={false}>
      <p className="dictation-consent__heading">{dictationConsent.heading}</p>
      <p className="dictation-consent__body">{dictationConsent.hudBody}</p>
      <div className="dictation-consent__actions">
        <button
          type="button"
          className="dictation-consent__decline"
          onClick={() => answer(false)}
          disabled={busy}
        >
          {dictationConsent.decline}
        </button>
        <button
          type="button"
          className="dictation-consent__accept"
          onClick={() => answer(true)}
          disabled={busy}
        >
          {dictationConsent.accept}
        </button>
      </div>
    </GlassSurface>
  );
}

/// The Copy button shared by the pending and recovery cards. `onCopied` runs
/// after the clipboard write succeeds, so a caller can end a hold only once
/// the words are actually somewhere the user can retrieve them.
function CopyTranscriptButton({
  text,
  site,
  onCopied,
}: {
  text: string;
  site: string;
  onCopied?: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyTranscript = () => {
    void writeText(text)
      .then(() => {
        setCopied(true);
        onCopied?.();
      })
      .catch((error) => logError(`${site}: copy transcript`, error));
  };

  return (
    <button type="button" className="dictation-message__copy" onClick={copyTranscript}>
      {copied && (
        <span className="dictation-message__copy-check" aria-hidden="true">
          ✓
        </span>
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function DictationRecovery({ text, message }: { text: string; message?: string }) {
  return (
    <GlassSurface className="dictation-message is-recovery" draggable={false}>
      <div className="dictation-message__row">
        <span className="dictation-message__dot" aria-hidden="true" />
        <span className="dictation-message__label">
          {message ?? "Aura could not type this."}
        </span>
      </div>
      <p className="dictation-message__text">{text}</p>
      <CopyTranscriptButton text={text} site="DictationRecovery" />
    </GlassSurface>
  );
}

/// Held text: the words are waiting for a text box, and the user can either
/// click into one (Rust types them there) or copy them now. Copying tells Rust
/// to end the hold, so a paste can never be followed by the same words typed a
/// second time.
function DictationPending({ text, message }: { text: string; message?: string }) {
  const endHold = () => {
    void invoke("dictation_held_text_copied").catch((error) =>
      logError("DictationPending: end hold after copy", error),
    );
  };

  return (
    <GlassSurface className="dictation-message is-pending" draggable={false}>
      <div className="dictation-message__row">
        <span className="dictation-message__dot" aria-hidden="true" />
        <span className="dictation-message__label">
          {message ?? "Waiting for a text box"}
        </span>
      </div>
      <p className="dictation-message__text">{text}</p>
      <CopyTranscriptButton text={text} site="DictationPending" onCopied={endHold} />
    </GlassSurface>
  );
}

/// The dictation HUD window: a persistent passive pill between holds, then the
/// same pill enlarged while the hotkey is held. The pill has no click action;
/// only the keyboard hook can start capture and recognition.
///
/// It stays wordless during live recognition. The waveform is enough proof that
/// Aura is listening, and the final transcript belongs in the focused field.
export function DictationHud() {
  const [update, setUpdate] = useState<DictationUpdate>(IDLE);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useDictationLevels(
    canvasRef,
    update.phase === "listening",
    update.edge === "left" || update.edge === "right",
  );
  useDictationSounds(update.phase);

  useTauriEvent<DictationUpdate>(DICTATION_UPDATE, setUpdate);

  // Bolt's ears and pupils follow the same level the waveform draws from. A
  // ref, never state: it arrives twenty times a second and nothing here needs
  // a re-render for it.
  const levelRef = useRef(0);
  useTauriEvent<number>(DICTATION_LEVEL, (level) => {
    levelRef.current = level;
  });

  // One cheer per insert. Counted rather than derived from the phase so a
  // second insert right after the first still plays.
  const [cheerCount, setCheerCount] = useState(0);
  useEffect(() => {
    if (update.phase === "inserted") setCheerCount((count) => count + 1);
  }, [update.phase]);

  // The companion switches live in the dashboard's settings store, which Rust
  // reads at every placement. Rust is not told when they change, so this
  // window asks for a re-placement on every settings write; the stamped
  // `companion` in the next update is what flips the tree below.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    subscribeGeneralSettings(() => {
      void invoke("dictation_refresh_hud").catch((error) =>
        logError("DictationHud: refresh after settings change", error),
      );
    })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((error) => logError("DictationHud: subscribe settings", error));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Nothing in this window is a web page: a right click on Bolt's canvas was
  // offering WebView2's "Save image / Copy image / Inspect", which is both
  // baffling and a way to pull focus into a window that must never take it.
  useEffect(() => {
    const block = (event: Event) => event.preventDefault();
    document.addEventListener("contextmenu", block);
    return () => document.removeEventListener("contextmenu", block);
  }, []);

  useEffect(() => {
    let live = true;
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
    };
  }, []);

  // Companion mode: Rust has sized this window for Bolt, so the pill and the
  // waveform never render here. The card phases keep their cards and he
  // holds them up; every other phase is him alone.
  const { companion, corner } = update;
  if (
    companion &&
    (update.phase === "idle" ||
      update.phase === "listening" ||
      update.phase === "transcribing" ||
      update.phase === "inserted")
  ) {
    return (
      <CompanionRest
        phase={update.phase}
        hotkey={update.chordLabel}
        corner={corner}
        levelRef={levelRef}
        cheerCount={cheerCount}
      />
    );
  }
  const carry = (card: ReactNode) =>
    companion ? <CompanionCarry corner={corner}>{card}</CompanionCarry> : card;

  if (update.phase === "idle") {
    return <DictationLauncher hotkey={update.chordLabel} edge={update.edge} />;
  }

  if (update.phase === "consent") {
    return carry(<DictationConsent />);
  }

  // Held text: the transcript is shown because the user has to know both that
  // something is waiting and what it says, with Copy available from the first
  // frame rather than only after the wait expires. Rust has already resized
  // the window to the card for this phase.
  if (update.phase === "pending") {
    return carry(<DictationPending text={update.text} message={update.message} />);
  }

  if (update.phase === "recovery") {
    return carry(<DictationRecovery text={update.text} message={update.message} />);
  }

  // A voice command was carried out instead of typing: one line naming what
  // happened, in the same caption card as an error but never styled as one.
  if (update.phase === "action") {
    return carry(
      <GlassSurface className="dictation-message is-action" draggable={false}>
        <span className="dictation-message__dot" aria-hidden="true" />
        <p className="dictation-message__text">{update.message ?? "Done."}</p>
      </GlassSurface>,
    );
  }

  // A failure is the only other thing worth words here.
  if (update.phase === "error") {
    return carry(
      <GlassSurface className="dictation-message" draggable={false}>
        <span className="dictation-message__dot" aria-hidden="true" />
        <p className="dictation-message__text">
          {update.message ?? "Nothing was typed."}
        </p>
      </GlassSurface>,
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
