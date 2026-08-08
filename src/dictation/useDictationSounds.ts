import { useEffect, useRef } from "react";
import startCue from "../assets/dictation-start.wav?url";
import stopCue from "../assets/dictation-stop.wav?url";
import {
  DEFAULT_GENERAL_SETTINGS,
  loadGeneralSettings,
  subscribeGeneralSettings,
} from "../lib/generalSettings";
import { logError } from "../lib/log";
import type { DictationPhase } from "./DictationHud";

// Imported with Vite's `?url` rather than a runtime path, for the same reason
// AvatarPill.tsx does it for the DRACO decoder: a hand-built path resolves to
// nothing once the dev server's pre-bundler moves things around, and the 404
// comes back as index.html instead of an error.
const CUES: Partial<Record<DictationPhase, string>> = {
  listening: startCue,
  inserted: stopCue,
};

/**
 * Short audio cues at the two ends of a dictation hold, gated on
 * Settings > System > Sound.
 *
 * Fires on the phase TRANSITION, never on the phase itself, so repeated state
 * publishes cannot machine-gun the start cue for the whole hold.
 */
export function useDictationSounds(phase: DictationPhase) {
  const enabledRef = useRef(DEFAULT_GENERAL_SETTINGS.dictationSounds);
  const previousPhase = useRef<DictationPhase | null>(null);

  useEffect(() => {
    let live = true;
    let unsubscribe: (() => void) | undefined;
    loadGeneralSettings()
      .then((settings) => {
        if (live) enabledRef.current = settings.dictationSounds;
      })
      .catch((err) => logError("useDictationSounds: load settings", err));
    subscribeGeneralSettings((settings) => {
      enabledRef.current = settings.dictationSounds;
    })
      .then((off) => {
        if (live) unsubscribe = off;
        else off();
      })
      .catch((err) => logError("useDictationSounds: subscribe", err));
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const changed = previousPhase.current !== phase;
    previousPhase.current = phase;
    if (!changed || !enabledRef.current) return;
    const src = CUES[phase];
    if (!src) return;
    const audio = new Audio(src);
    audio.volume = 0.35;
    // A cue is decoration. If the webview blocks or fails playback there is
    // nothing to recover, and the HUD itself already shows the same state.
    void audio.play().catch(() => {});
  }, [phase]);
}
