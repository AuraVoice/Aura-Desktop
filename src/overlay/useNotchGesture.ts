import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError, logInfo } from "../lib/log";
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
): NotchGestureState {
  const [state, setState] = useState<NotchGestureState>({
    available: false,
    keyLabel: "",
    checking: true,
  });
  const signedInRef = useRef(signedIn);
  const voiceRef = useRef(voice);
  const pointingRef = useRef(pointing);
  const sessionActiveRef = useRef(voice.desiredActive);
  const lastSequenceRef = useRef(0);
  signedInRef.current = signedIn;
  voiceRef.current = voice;
  pointingRef.current = pointing;

  useEffect(() => {
    sessionActiveRef.current = voice.desiredActive;
  }, [voice.desiredActive]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    listen<AuraTogglePayload>("aura-toggle", (event) => {
      const sequence = event.payload?.sequence;
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequenceRef.current) {
        return;
      }
      lastSequenceRef.current = sequence;
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

      if (sessionActiveRef.current) {
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
        invoke("summon_bar")
          .then(() => {
            logInfo(
              "useNotchGesture: bar summoned",
              `sequence=${sequence} elapsedMs=${Date.now() - actionStartedAtMs}`,
            );
          })
          .catch((err) => logError("useNotchGesture: summon_bar", err));
        void currentVoice
          .startSession()
          .then(() => {
            logInfo(
              "useNotchGesture: start settled",
              `sequence=${sequence} elapsedMs=${Date.now() - actionStartedAtMs} status=${voiceRef.current.status}`,
            );
          })
          .catch((err) => logError("useNotchGesture: startSession", err));
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
    };
  }, []);

  return state;
}
