import { invoke } from "@tauri-apps/api/core";
import { DICTATION_STATUS_CHANGED } from "./ipcEvents";
import { isMac } from "./platformKeys";
import { useTauriMirroredState } from "./useTauriEvent";

export interface DictationStatus {
  available: boolean;
  chordLabel: string;
  reason?: string;
  /** Set when `reason` is an OS grant the UI can act on (macOS only today).
   * "inputMonitoring": the keystroke grant is missing. "relaunch": it was
   * granted after launch and only a restart picks it up. */
  blocker?: "inputMonitoring" | "relaunch";
}

export function loadDictationStatus(): Promise<DictationStatus> {
  return invoke<DictationStatus>("dictation_status");
}

/** Live mirror of Rust's dictation status (initial load + change events);
 * null until the first value lands. */
export function useDictationStatus(): DictationStatus | null {
  return useTauriMirroredState<DictationStatus>(
    DICTATION_STATUS_CHANGED,
    loadDictationStatus,
    "dictationStatus: mirror",
  );
}

/** Shown only in the instant between mount and the first `dictation_status`
 * reply. Rust's `DictationChord::label()` is the real source of truth (see
 * chord.rs: nothing may hardcode a chord string), so this exists once, here,
 * rather than as a literal in every page that renders the chord. */
const DICTATION_CHORD_FALLBACK = isMac() ? "Ctrl + Cmd" : "Ctrl + Win";

/** The chord as one string, e.g. "Ctrl + Win". */
function chordLabelOf(status: DictationStatus | null): string {
  return status?.chordLabel ?? DICTATION_CHORD_FALLBACK;
}

/** The chord split into its individual keys, for surfaces that render one
 * <kbd> chip per key. Kept here so the separator is known in exactly one
 * place, and so moving Rust to a structured key list later is a one-line
 * change rather than a hunt through the pages. */
export function chordKeysOf(status: DictationStatus | null): string[] {
  return chordLabelOf(status).split(" + ");
}
