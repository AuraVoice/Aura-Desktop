import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  loadHotkeyBindings,
  loadVoiceToggleKey,
  type HotkeyBinding,
  type VoiceToggleKeyStatus,
} from "../lib/hotkeys";
import { ShortcutEditorDialog } from "./ShortcutEditorDialog";
import { trackEvent } from "../lib/analytics";
import { trackOnboardingStepCompleted } from "../lib/acquisitionAnalytics";
import { recordDesktopOnboardingEvent } from "../lib/profile";
import { logError } from "../lib/log";
import "./HotkeyTourStep.css";

interface HotkeyTourStepProps {
  keyLabel?: string;
  onContinue: () => void;
}

/** Long enough for the key tile to visibly light up before the screen changes,
 * short enough that it does not feel like a stall. */
const SUCCESS_BEAT_MS = 750;

/** Display labels for the double-tap keys, which are whole labels rather than
 * the single characters the generic branch below assumes. Without these,
 * "Left Ctrl" fell through to heldCodes.has("KeyLeft Ctrl") and never matched,
 * so the key never lit up on the one binding that ships by default. */
const LABEL_CODES: Record<string, string[]> = {
  "Left Ctrl": ["ControlLeft"],
  "Right Ctrl": ["ControlRight"],
  "Left Shift": ["ShiftLeft"],
  "Right Shift": ["ShiftRight"],
};

function isDisplayedKeyHeld(key: string, heldCodes: Set<string>): boolean {
  const codes = LABEL_CODES[key];
  if (codes) return codes.some((code) => heldCodes.has(code));
  if (key === "Ctrl") return heldCodes.has("ControlLeft") || heldCodes.has("ControlRight");
  if (key === "Alt") return heldCodes.has("AltLeft") || heldCodes.has("AltRight");
  if (key === "Shift") return heldCodes.has("ShiftLeft") || heldCodes.has("ShiftRight");
  if (key === "Space" || /^F([1-9]|1[01])$/.test(key)) return heldCodes.has(key);
  if (/^[0-9]$/.test(key)) return heldCodes.has(`Digit${key}`);
  return heldCodes.has(`Key${key}`);
}

export function HotkeyTourStep({ keyLabel, onContinue }: HotkeyTourStepProps) {
  const [bindings, setBindings] = useState<HotkeyBinding[]>([]);
  const [voice, setVoice] = useState<VoiceToggleKeyStatus>({
    available: true,
    keyLabel: keyLabel || "Left Ctrl",
    accelerator: keyLabel === "Right Ctrl" ? "ControlRight" : "ControlLeft",
    keys: [keyLabel || "Left Ctrl"],
    gesture: "doubleTap",
  });
  const [screen, setScreen] = useState<"voice" | "chat" | "list">("voice");
  const [passed, setPassed] = useState(false);
  const [testReady, setTestReady] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [heldCodes, setHeldCodes] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; label: string } | null>(null);
  const advanceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chat = bindings.find((binding) => binding.id === "chat");
  const currentTestId = screen === "list" ? null : screen;
  const currentKeys = screen === "voice" ? voice.keys : chat?.keys ?? [];
  const currentAccelerator = screen === "voice" ? voice.accelerator : chat?.accelerator ?? "";
  const isDoubleTap = screen === "voice" && voice.gesture === "doubleTap";

  useEffect(() => {
    Promise.all([loadHotkeyBindings(), loadVoiceToggleKey()])
      .then(([nextBindings, nextVoice]) => {
        setBindings(nextBindings);
        setVoice(nextVoice);
      })
      .catch((err) => logError("HotkeyTourStep: load shortcuts", err));
  }, []);

  // Arm the native test only while a test screen is showing. Rust swallows the
  // action for the armed id, so a real press here never opens anything.
  useEffect(() => {
    if (!currentTestId) return;
    const owner = crypto.randomUUID();
    let cancelled = false;
    setHeldCodes(new Set());
    setTestReady(false);
    setTestError(null);
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const stopListening = await listen<string>("hotkey-test-pressed", (event) => {
          if (event.payload !== currentTestId) return;
          trackEvent("desktop_hotkey_test_passed", {
            hotkey_id: currentTestId,
            screen,
          });
          void recordDesktopOnboardingEvent(
            "desktop_hotkey_test_passed",
            {
              hotkey_id: currentTestId,
              screen,
            },
            `hotkey_test_passed_${currentTestId}`,
          );
          setPassed(true);
        });
        if (cancelled) {
          stopListening();
          return;
        }
        unlisten = stopListening;
        await invoke("begin_hotkey_test", { id: currentTestId, owner });
        if (cancelled) await invoke("end_hotkey_test", { owner });
        else setTestReady(true);
      } catch (err) {
        logError("HotkeyTourStep: prepare test", err);
        if (!cancelled) {
          setTestError("This shortcut could not be tested right now. You can skip it for now.");
        }
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      void invoke("end_hotkey_test", { owner });
    };
  }, [currentTestId, currentAccelerator]);

  // The press itself advances the step; the beat exists so the tile is seen lit.
  useEffect(() => {
    if (!passed || screen === "list") return;
    advanceRef.current = setTimeout(() => {
      setPassed(false);
      setScreen(screen === "voice" ? "chat" : "list");
    }, SUCCESS_BEAT_MS);
    return () => clearTimeout(advanceRef.current);
  }, [passed, screen]);

  // Held-key highlighting only makes sense for a chord you press and hold. The
  // double-tap trigger is lit by `passed` instead, which Rust emits from the
  // same classifier that decides to summon Buddy, so a single tap never lights
  // the tile and a double tap inside the threshold always does.
  useEffect(() => {
    if (isDoubleTap) return;
    const down = (event: KeyboardEvent) => {
      if (editing) return;
      setHeldCodes((previous) => new Set(previous).add(event.code));
    };
    const up = (event: KeyboardEvent) => {
      setHeldCodes((previous) => {
        const next = new Set(previous);
        next.delete(event.code);
        return next;
      });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [editing, isDoubleTap]);

  const shortcutLabel = currentKeys.join(" + ");
  const gestureCopy = screen === "voice"
    ? isDoubleTap
      ? `Double-tap ${voice.keyLabel} anywhere in Windows to start talking to Buddy. Double-tap ${voice.keyLabel} again when you're done.`
      : `Press ${shortcutLabel} anywhere in Windows to start talking to Buddy. Press ${shortcutLabel} again when you're done.`
    : `Press ${shortcutLabel} anywhere in Windows to open text chat with Buddy.`;
  const heading = screen === "voice" ? "Talk to Buddy" : "Type to Buddy";
  const currentAvailable = (screen === "voice" ? voice.available : Boolean(chat)) && !testError;

  const dialog = editing && (
    <ShortcutEditorDialog
      id={editing.id}
      label={editing.label}
      bindings={bindings}
      voice={voice}
      onSavedBindings={(next) => {
        setBindings(next);
        setPassed(false);
      }}
      onSavedVoice={(next) => {
        setVoice(next);
        // A new trigger has not been proven yet, so the user tries this one too.
        setPassed(false);
      }}
      onClose={() => setEditing(null)}
    />
  );

  return (
    <div className="onboarding-step hotkey-tour-step">
      <div className="hotkey-test-progress" aria-label={`Step ${screen === "voice" ? 1 : screen === "chat" ? 2 : 3} of 3`}>
        <span className={screen === "voice" ? "active" : "complete"} />
        <span className={screen === "chat" ? "active" : screen === "list" ? "complete" : ""} />
        <span className={screen === "list" ? "active" : ""} />
      </div>

      {screen !== "list" ? (
        <>
          <h2 className="hotkey-test-question">{heading}</h2>
          <p className="hotkey-test-purpose">{gestureCopy}</p>

          <div className="hotkey-test-card">
            <div className="hotkey-test-stage">
              <div className="hotkey-test-stage-keys">
                {currentKeys.map((key, keyIndex) => (
                  <span key={`${key}:${keyIndex}`} className="hotkey-test-stage-group">
                    {keyIndex > 0 && <span className="hotkey-test-stage-plus">+</span>}
                    <kbd className={passed || (!isDoubleTap && isDisplayedKeyHeld(key, heldCodes)) ? "active" : ""}>
                      <strong>{key}</strong>
                      {isDoubleTap && <small>twice</small>}
                    </kbd>
                  </span>
                ))}
              </div>
              <button
                type="button"
                className="hotkey-test-change"
                onClick={() => setEditing({
                  id: screen === "voice" ? "voice" : "chat",
                  label: screen === "voice" ? "Start or end voice" : chat?.label ?? "Open text chat",
                })}
              >
                Change
              </button>
            </div>

            <p className={`hotkey-test-prompt${passed ? " passed" : ""}`} aria-live="polite">
              {passed
                ? screen === "voice"
                  ? "That's it. Buddy is listening whenever you do that."
                  : "That's it. Text chat is one shortcut away."
                : !testReady
                  ? "Getting shortcut ready..."
                  : isDoubleTap ? "Double-tap it now" : "Press it now"}
            </p>

            {!currentAvailable && (
              <p className="hotkey-test-unavailable">
                {screen === "voice"
                  ? testError || voice.reason || "This voice trigger is unavailable. Choose a different one."
                  : testError || "The text chat shortcut is unavailable right now. You can skip it for now."}
              </p>
            )}

            <div className="hotkey-test-actions">
              <button
                type="button"
                className="hotkey-test-skip"
                onClick={() => {
                  trackEvent("desktop_hotkey_test_skipped", {
                    hotkey_id: currentTestId,
                    screen,
                  });
                  void recordDesktopOnboardingEvent(
                    "desktop_hotkey_test_skipped",
                    {
                      hotkey_id: currentTestId,
                      screen,
                    },
                    `hotkey_test_skipped_${currentTestId}`,
                  );
                  setPassed(false);
                  setScreen(screen === "voice" ? "chat" : "list");
                }}
              >
                Skip for now
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          <h2 className="hotkey-test-question">Your other shortcuts</h2>
          <p className="hotkey-test-purpose">
            These work anywhere in Windows while Aura is running. Change any of them now or later in Settings.
          </p>

          <div className="hotkey-test-card">
            <ul className="hotkey-list">
              {bindings.filter((binding) => binding.id !== "chat").map((binding) => (
                <li key={binding.id} className="hotkey-list-row">
                  <span className="hotkey-list-text">{binding.label}</span>
                  <span className="hotkey-list-keys">
                    {binding.keys.map((key, keyIndex) => <kbd key={`${key}:${keyIndex}`}>{key}</kbd>)}
                  </span>
                  <button
                    type="button"
                    className="hotkey-list-change"
                    onClick={() => setEditing({ id: binding.id, label: binding.label })}
                  >
                    Change
                  </button>
                </li>
              ))}
            </ul>

            <div className="hotkey-test-actions">
              <button
                type="button"
                className="hotkey-test-continue"
                onClick={() => {
                  trackEvent("desktop_hotkey_tour_completed", {
                    binding_count: bindings.length,
                  });
                  void recordDesktopOnboardingEvent(
                    "desktop_hotkey_tour_completed",
                    { binding_count: bindings.length },
                    "hotkey_tour_completed",
                  );
                  void trackOnboardingStepCompleted("hotkey_tour");
                  onContinue();
                }}
              >
                Continue
              </button>
            </div>
          </div>
        </>
      )}

      {dialog}
    </div>
  );
}
