import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { Store } from "@tauri-apps/plugin-store";
import { Check, Keyboard } from "lucide-react";
import { setDictationConsent } from "../lib/dictationConsent";
import { chordKeysOf, useDictationStatus } from "../lib/dictationStatus";
import { dictationConsent, overlayStorePath } from "../lib/copy";
import { isMac, openInputMonitoringSettings } from "../lib/platformKeys";
import { trackEvent } from "../lib/analytics";
import { logError } from "../lib/log";
import "./PrivacySetupStep.css";

/** Where the keystroke grant stands (`input_monitoring_state` in Rust). */
interface InputMonitoringState {
  required: boolean;
  granted: boolean;
  listening: boolean;
}

type Phase = "checking" | "intro" | "waiting" | "restart" | "ready";

/** Set right before the restart this step asks for, so onboarding comes back
 * here instead of starting over at the hotkey tour. */
const RESUME_KEY = "onboarding_resume_dictation";

/** How often the step re-reads the grant while the user is in System Settings.
 * The read is a silent TCC check, and it also starts the listener once the
 * switch is on, so the step turns ready without a restart when macOS allows it. */
const POLL_MS = 1_000;

export async function takeDictationResume(): Promise<boolean> {
  try {
    const store = await Store.load(overlayStorePath);
    const resume = (await store.get<boolean>(RESUME_KEY)) === true;
    if (resume) {
      await store.delete(RESUME_KEY);
      await store.save();
    }
    return resume;
  } catch (err) {
    logError("DictationSetupStep: read resume flag", err);
    return false;
  }
}

async function markDictationResume(): Promise<void> {
  const store = await Store.load(overlayStorePath);
  await store.set(RESUME_KEY, true);
  await store.save();
}

function loadInputMonitoring(): Promise<InputMonitoringState> {
  return invoke<InputMonitoringState>("input_monitoring_state");
}

/** macOS only: dictation's keys reach Aura through an event tap that needs
 * Input Monitoring, which nothing else in onboarding asks for. Without this
 * step the first thing a new Mac user saw was "Dictation needs Input
 * Monitoring" on Home, behind a consent prompt that cannot appear until the
 * grant exists. */
export function DictationSetupStep({ onContinue }: { onContinue: () => void }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [busy, setBusy] = useState(false);
  const dictationStatus = useDictationStatus();
  const continuedRef = useRef(false);

  const continueOnce = () => {
    if (continuedRef.current) return;
    continuedRef.current = true;
    onContinue();
  };

  // Windows needs no grant, and a Mac that already listens has nothing to do.
  useEffect(() => {
    if (!isMac()) {
      continueOnce();
      return;
    }
    let cancelled = false;
    loadInputMonitoring()
      .then((state) => {
        if (cancelled) return;
        if (state.listening) continueOnce();
        else setPhase(state.granted ? "restart" : "intro");
      })
      .catch((err) => {
        logError("DictationSetupStep: input monitoring state", err);
        if (!cancelled) setPhase("intro");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (phase !== "waiting") return;
    let stopped = false;
    const tick = () => {
      loadInputMonitoring()
        .then((state) => {
          if (stopped || !state.granted) return;
          trackEvent("desktop_permission_result", {
            permission: "input_monitoring",
            granted: true,
            surface: "onboarding_dictation",
          });
          setPhase(state.listening ? "ready" : "restart");
        })
        .catch((err) => logError("DictationSetupStep: poll input monitoring", err));
    };
    const timer = window.setInterval(tick, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [phase]);

  async function turnOn() {
    setBusy(true);
    try {
      // Consent is what Rust raises the Input Monitoring prompt for, so the
      // two can never drift apart. The pane opens too: macOS shows its own
      // prompt only once per install, and after that the pane is the only way.
      await setDictationConsent(true);
      setPhase("waiting");
      await openInputMonitoringSettings().catch((err) =>
        logError("DictationSetupStep: open input monitoring", err),
      );
    } catch (err) {
      logError("DictationSetupStep: turn on dictation", err);
    } finally {
      setBusy(false);
    }
  }

  async function restart() {
    setBusy(true);
    try {
      await markDictationResume();
    } catch (err) {
      // Restarting still lands the grant; onboarding just starts from the tour.
      logError("DictationSetupStep: mark resume", err);
    }
    await relaunch().catch((err) => {
      logError("DictationSetupStep: relaunch", err);
      setBusy(false);
    });
  }

  if (phase === "checking") return null;

  const chord = chordKeysOf(dictationStatus);

  return (
    <div className="onboarding-step privacy-setup-step">
      <div className="privacy-setup-heading">
        <div>
          <h2>Dictate in any app</h2>
          <p>
            Hold {chord.join(" + ")} anywhere and Aura types what you say. macOS asks you to let
            Aura hear those keys first.
          </p>
        </div>
      </div>

      <section className="privacy-setup-section" aria-labelledby="dictation-setup-heading">
        <div className="privacy-section-heading">
          <h3 id="dictation-setup-heading">Input Monitoring</h3>
        </div>
        <div className="privacy-feature-list">
          <div className="privacy-feature-row">
            <span className="privacy-row-icon"><Keyboard size={20} aria-hidden="true" /></span>
            <span className="privacy-row-copy">
              <strong>
                {phase === "ready"
                  ? "Dictation is ready"
                  : phase === "restart"
                    ? "Restart Aura to finish"
                    : phase === "waiting"
                      ? "Turn on Aura in System Settings"
                      : "Turn on dictation"}
              </strong>
              <small>
                {phase === "ready"
                  ? `Hold ${chord.join(" + ")} in any app and speak. Let go and the words appear.`
                  : phase === "restart"
                    ? "Input Monitoring is on. macOS applies it after Aura restarts, and setup picks up right here."
                    : phase === "waiting"
                      ? "In Privacy & Security > Input Monitoring, switch on Aura Desktop. This screen updates on its own."
                      : dictationConsent.body}
              </small>
            </span>
            {phase === "intro" && (
              <button type="button" className="privacy-permission-button" disabled={busy} onClick={() => void turnOn()}>
                Turn on
              </button>
            )}
            {phase === "waiting" && (
              <button
                type="button"
                className="privacy-permission-button"
                onClick={() =>
                  void openInputMonitoringSettings().catch((err) =>
                    logError("DictationSetupStep: reopen input monitoring", err),
                  )
                }
              >
                Open System Settings
              </button>
            )}
            {phase === "restart" && (
              <button type="button" className="privacy-permission-button" disabled={busy} onClick={() => void restart()}>
                Restart Aura
              </button>
            )}
            {phase === "ready" && (
              <span className="privacy-permission-button is-ready">
                <Check size={15} aria-hidden="true" />
                Ready
              </span>
            )}
          </div>
        </div>
      </section>

      <div className="privacy-setup-actions">
        {phase !== "ready" && (
          <button type="button" className="privacy-skip-button" onClick={continueOnce}>
            Skip for now
          </button>
        )}
        {phase === "ready" && (
          <button type="button" className="privacy-continue-button" onClick={continueOnce}>
            Continue
          </button>
        )}
      </div>
    </div>
  );
}
