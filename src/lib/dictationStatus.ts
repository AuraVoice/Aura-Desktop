import { invoke } from "@tauri-apps/api/core";

export interface DictationStatus {
  available: boolean;
  chordLabel: string;
  reason?: string;
}

export function loadDictationStatus(): Promise<DictationStatus> {
  return invoke<DictationStatus>("dictation_status");
}

/** Shown only in the instant between mount and the first `dictation_status`
 * reply. Rust's `DictationChord::label()` is the real source of truth (see
 * chord.rs: nothing may hardcode a chord string), so this exists once, here,
 * rather than as a literal in every page that renders the chord. */
export const DICTATION_CHORD_FALLBACK = "Ctrl + Win";

/** The chord as one string, e.g. "Ctrl + Win". */
export function chordLabelOf(status: DictationStatus | null): string {
  return status?.chordLabel ?? DICTATION_CHORD_FALLBACK;
}

/** The chord split into its individual keys, for surfaces that render one
 * <kbd> chip per key. Kept here so the separator is known in exactly one
 * place, and so moving Rust to a structured key list later is a one-line
 * change rather than a hunt through the pages. */
export function chordKeysOf(status: DictationStatus | null): string[] {
  return chordLabelOf(status).split(" + ");
}
