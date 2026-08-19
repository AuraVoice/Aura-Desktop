import { invoke } from "@tauri-apps/api/core";

export interface DictationStatus {
  available: boolean;
  chordLabel: string;
  reason?: string;
}

export function loadDictationStatus(): Promise<DictationStatus> {
  return invoke<DictationStatus>("dictation_status");
}
