import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError, logInfo } from "../lib/log";

interface VoiceToggleRequested {
  sequence: number;
}

interface VoiceToggleKeyStatus {
  available: boolean;
  keyLabel: string;
  reason?: string;
}

export interface VoiceToggleKeyState extends VoiceToggleKeyStatus {
  checking: boolean;
}

export function useVoiceToggleKey(
  signedIn: boolean,
  toggleSession: () => void,
): VoiceToggleKeyState {
  const [state, setState] = useState<VoiceToggleKeyState>({
    available: false,
    keyLabel: "",
    checking: true,
  });
  const signedInRef = useRef(signedIn);
  const toggleSessionRef = useRef(toggleSession);
  const lastSequenceRef = useRef(0);
  signedInRef.current = signedIn;
  toggleSessionRef.current = toggleSession;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    listen<VoiceToggleRequested>("aura-toggle", (event) => {
      const sequence = event.payload?.sequence;
      if (!Number.isSafeInteger(sequence) || sequence <= lastSequenceRef.current) {
        return;
      }
      lastSequenceRef.current = sequence;
      logInfo("useVoiceToggleKey: handling toggle", `sequence=${sequence}`);

      if (!signedInRef.current) {
        logInfo("useVoiceToggleKey: signed out toggle", `sequence=${sequence}`);
        invoke("summon").catch((err) =>
          logError("useVoiceToggleKey: summon signed-out setup", err),
        );
        return;
      }
      toggleSessionRef.current();
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) => logError("useVoiceToggleKey: listen", err));

    invoke<VoiceToggleKeyStatus>("voice_toggle_key_status")
      .then((status) => {
        if (!disposed) setState({ ...status, checking: false });
      })
      .catch((err) => {
        logError("useVoiceToggleKey: status", err);
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
