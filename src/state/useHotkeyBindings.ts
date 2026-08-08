import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  loadHotkeyBindings,
  loadVoiceToggleKey,
  type HotkeyBinding,
  type VoiceToggleKeyStatus,
} from "../lib/hotkeys";
import { logError } from "../lib/log";

export function useHotkeyBindings() {
  const [bindings, setBindings] = useState<HotkeyBinding[]>([]);
  const [voice, setVoice] = useState<VoiceToggleKeyStatus | null>(null);

  useEffect(() => {
    loadHotkeyBindings().then(setBindings).catch((err) => logError("useHotkeyBindings: load", err));
    loadVoiceToggleKey().then(setVoice).catch((err) => logError("useHotkeyBindings: voice", err));
    let unlistenBindings: (() => void) | undefined;
    let unlistenVoice: (() => void) | undefined;
    listen<HotkeyBinding[]>("hotkey-bindings-changed", (event) => setBindings(event.payload))
      .then((fn) => { unlistenBindings = fn; })
      .catch((err) => logError("useHotkeyBindings: listen bindings", err));
    listen<VoiceToggleKeyStatus>("voice-toggle-key-changed", (event) => setVoice(event.payload))
      .then((fn) => { unlistenVoice = fn; })
      .catch((err) => logError("useHotkeyBindings: listen voice", err));
    return () => {
      unlistenBindings?.();
      unlistenVoice?.();
    };
  }, []);

  return { bindings, voice };
}
