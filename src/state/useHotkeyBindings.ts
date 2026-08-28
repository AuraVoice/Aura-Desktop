import {
  HOTKEY_BINDINGS_CHANGED,
  VOICE_TOGGLE_KEY_CHANGED,
} from "../lib/ipcEvents";
import {
  loadHotkeyBindings,
  loadVoiceToggleKey,
  type HotkeyBinding,
  type VoiceToggleKeyStatus,
} from "../lib/hotkeys";
import { useTauriMirroredState } from "../lib/useTauriEvent";

// Stable identity for the pre-load render, so consumers' dep arrays do not
// churn while the first load is in flight.
const NO_BINDINGS: HotkeyBinding[] = [];

export function useHotkeyBindings() {
  const bindings = useTauriMirroredState<HotkeyBinding[]>(
    HOTKEY_BINDINGS_CHANGED,
    loadHotkeyBindings,
    "useHotkeyBindings: bindings",
  );
  const voice = useTauriMirroredState<VoiceToggleKeyStatus>(
    VOICE_TOGGLE_KEY_CHANGED,
    loadVoiceToggleKey,
    "useHotkeyBindings: voice",
  );

  return { bindings: bindings ?? NO_BINDINGS, voice };
}
