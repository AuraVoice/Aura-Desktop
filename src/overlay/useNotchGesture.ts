import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError, logInfo } from "../lib/log";
import { outputMuted } from "../lib/outputMode";
import type { VoiceBarState } from "./useVoiceBar";

interface AuraTogglePayload {
  sequence: number;
  emittedAtMs?: number;
}

interface VoiceToggleKeyStatus {
  available: boolean;
  keyLabel: string;
  reason?: string;
}

export interface NotchGestureState extends VoiceToggleKeyStatus {
  checking: boolean;
}

export function useNotchGesture(
  signedIn: boolean,
  voice: VoiceBarState,
  pointing: boolean,
  overlayVisible: boolean,
): NotchGestureState {
  const [state, setState] = useState<NotchGestureState>({
    available: false,
    keyLabel: "",
    checking: true,
  });
  const signedInRef = useRef(signedIn);
  const voiceRef = useRef(voice);
  const pointingRef = useRef(pointing);
  // Whether ANY on-screen call/notch surface is currently visible (bar, pill, or
  // moving notch). The dismiss decision keys off this, not the voice session: a
  // surface deliberately stays visible for the ended/error/voice-capped states
  // where desiredActive is already false, and without this a double-tap in any of
  // those states would re-summon (or restart a call) instead of closing the
  // surface the user is trying to get rid of.
  //
  // "disconnected" is the one visible state this must NOT dismiss on. A bar left
  // over from a call that already finished sits at disconnected with nothing to
  // hang up, so treating it as a surface to close spent the user's first
  // double-tap clearing it and only started a call on the second. Error and
  // voice-capped report their own statuses and still take the stop branch.
  const overlayVisibleRef = useRef(overlayVisible);
  const sessionActiveRef = useRef(voice.desiredActive);
  const lastSequenceRef = useRef(0);
  const actionGenerationRef = useRef(0);
  signedInRef.current = signedIn;
  voiceRef.current = voice;
  pointingRef.current = pointing;
  overlayVisibleRef.current = overlayVisible;

  useEffect(() => {
    sessionActiveRef.current = voice.desiredActive;
  }, [voice.desiredActive]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenKeyChange: (() => void) | undefined;
    let disposed = false;

    listen<AuraTogglePayload>("aura-toggle", (event) => {
      const sequence = event.payload?.sequence;
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequenceRef.current) {
        return;
      }
      lastSequenceRef.current = sequence;
      actionGenerationRef.current += 1;
      const actionGeneration = actionGenerationRef.current;
      const receivedAtMs = Date.now();
      const emittedAtMs = event.payload?.emittedAtMs;
      const latencyMs =
        typeof emittedAtMs === "number" && Number.isFinite(emittedAtMs)
          ? Math.max(0, receivedAtMs - emittedAtMs)
          : null;
      const currentVoice = voiceRef.current;
      logInfo(
        "useNotchGesture: toggle received",
        `sequence=${sequence} latencyMs=${latencyMs ?? "unknown"} status=${currentVoice.status} desiredActive=${sessionActiveRef.current}`,
      );

      if (pointingRef.current) {
        logInfo("useNotchGesture: ignored during pointing", `sequence=${sequence}`);
        return;
      }
      if (!signedInRef.current) {
        logInfo("useNotchGesture: action", `sequence=${sequence} action=summon-setup`);
        invoke("summon").catch((err) =>
          logError("useNotchGesture: summon signed-out setup", err),
        );
        return;
      }

      if (
        sessionActiveRef.current ||
        (overlayVisibleRef.current && currentVoice.status !== "disconnected")
      ) {
        sessionActiveRef.current = false;
        logInfo("useNotchGesture: action", `sequence=${sequence} action=stop`);
        const actionStartedAtMs = Date.now();
        void currentVoice
          .endSession()
          .then(() => {
            logInfo(
              "useNotchGesture: stop complete",
              `sequence=${sequence} elapsedMs=${Date.now() - actionStartedAtMs}`,
            );
          })
          .catch((err) => logError("useNotchGesture: endSession", err));
        invoke("dismiss_bar")
          .then(() => {
            logInfo(
              "useNotchGesture: bar dismissed",
              `sequence=${sequence} elapsedMs=${Date.now() - actionStartedAtMs}`,
            );
          })
          .catch((err) => logError("useNotchGesture: dismiss_bar", err));
      } else {
        sessionActiveRef.current = true;
        logInfo("useNotchGesture: action", `sequence=${sequence} action=start`);
        const actionStartedAtMs = Date.now();
        currentVoice.noteTapTimestamp(
          typeof emittedAtMs === "number" && Number.isFinite(emittedAtMs) ? emittedAtMs : receivedAtMs,
        );
        // Bridged pre-dispatch: the instant OpenAI Realtime leg opens the mic and speaks
        // immediately, while LiveKit warms in parallel and hands off when ready (see
        // bridgeCoordinator.ts). startBridgedSession falls back to the normal cold LiveKit
        // path on its own if Realtime is unavailable, so this stays the single entry point.
        // Unlike the old flow, there is no separate activateSession() step: the coordinator
        // owns the microphone (Realtime now, LiveKit at handover), so summon_bar below only
        // has to make the notch visible.
        // Output mute skips the bridge entirely: the Realtime leg is audio-only
        // and plays through its own element, so bridging a muted call would buy
        // latency the user cannot hear (lib/outputMode.ts). The token also
        // refuses `bridged` in text mode, so this only avoids the wasted mint.
        if (outputMuted()) {
          void currentVoice.startSession();
        } else {
          void currentVoice.startBridgedSession();
        }
        void (async () => {
          try {
            await invoke("summon_bar");
            logInfo(
              "useNotchGesture: bar summoned",
              `sequence=${sequence} elapsedMs=${Date.now() - actionStartedAtMs}`,
            );
            // A second toggle may have stopped this request while native window
            // operations were still in flight. Never resurrect that cancelled
            // attempt after the notch becomes visible - the stop toggle's
            // endSession() already tore down the prepared room and bridge.
            if (
              actionGenerationRef.current !== actionGeneration ||
              !sessionActiveRef.current
            ) {
              await invoke("dismiss_bar").catch((err) =>
                logError("useNotchGesture: dismiss cancelled start", err),
              );
              return;
            }
            logInfo(
              "useNotchGesture: start settled",
              `sequence=${sequence} elapsedMs=${Date.now() - actionStartedAtMs} status=${voiceRef.current.status}`,
            );
          } catch (err) {
            sessionActiveRef.current = false;
            logError("useNotchGesture: summon/start", err);
            // The notch never appeared, but prepareSession may already have a
            // room connecting - tear it down so an invisible call can't run.
            void currentVoice.endSession().catch((endErr) =>
              logError("useNotchGesture: end after failed summon", endErr),
            );
          }
        })();
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => logError("useNotchGesture: listen", err));

    listen<VoiceToggleKeyStatus>("voice-toggle-key-changed", (event) => {
      if (!disposed) setState({ ...event.payload, checking: false });
    })
      .then((fn) => {
        if (disposed) fn(); else unlistenKeyChange = fn;
      })
      .catch((err) => logError("useNotchGesture: listen key change", err));

    invoke<VoiceToggleKeyStatus>("voice_toggle_key_status")
      .then((status) => {
        if (!disposed) setState({ ...status, checking: false });
      })
      .catch((err) => {
        logError("useNotchGesture: status", err);
        if (!disposed) {
          setState({
            available: false,
            keyLabel: "",
            checking: false,
            reason: "The voice shortcut listener could not be checked.",
          });
        }
      });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenKeyChange?.();
    };
  }, []);

  return state;
}
