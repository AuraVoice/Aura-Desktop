import { invoke } from "@tauri-apps/api/core";

/**
 * Typed client for the local dictation history (`dictation/history.rs`).
 *
 * The store is entirely local: an encrypted SQLite file plus encrypted FLAC
 * clips under the app's data directory, sealed with the same dictation key as
 * the vocabulary. Nothing here talks to the backend, which is why these go
 * through `invoke` and not `authFetch`.
 *
 * `uid` is passed explicitly on every call rather than read in Rust, mirroring
 * `interviewSessions.ts`: the webview already knows which account it is
 * rendering, and Rust filters every query on it regardless.
 */

/** Mirrors `DictationHistoryEntry` in src-tauri/src/dictation/history.rs. */
export interface DictationHistoryEntry {
  id: string;
  recordedAtMs: number;
  text: string;
  wordCount: number;
  durationMs: number;
  /** False once the clip has aged out of the size budget. Expected, not an error. */
  hasAudio: boolean;
  flagged: boolean;
  /** The transcript as it left speech recognition, present only when AI polish
   * changed the text. Null means `text` IS the raw transcript. */
  rawText: string | null;
}

/** Mirrors `HistorySettings` in src-tauri/src/dictation/history.rs. */
export interface DictationHistorySettings {
  enabled: boolean;
  audioBytes: number;
  entryCount: number;
}

/** Every stored dictation, newest first. Runs the retention sweep first. */
export function listDictationHistory(uid: string): Promise<DictationHistoryEntry[]> {
  return invoke<DictationHistoryEntry[]>("dictation_history_list", { uid });
}

/**
 * Decrypted FLAC bytes for one clip, as an object URL the caller owns and must
 * revoke. Raw bytes rather than a file path: what is on disk is ciphertext, so
 * the asset protocol would hand `<audio>` garbage.
 */
export async function loadDictationAudioUrl(uid: string, id: string): Promise<string> {
  const raw = await invoke<ArrayBuffer>("dictation_history_audio", { uid, id });
  return URL.createObjectURL(new Blob([new Uint8Array(raw)], { type: "audio/flac" }));
}

export function setDictationFlag(uid: string, id: string, flagged: boolean): Promise<void> {
  return invoke("dictation_history_set_flag", { uid, id, flagged });
}

export function deleteDictationEntry(uid: string, id: string): Promise<void> {
  return invoke("dictation_history_delete", { uid, id });
}

export function clearDictationHistory(uid: string): Promise<void> {
  return invoke("dictation_history_clear", { uid });
}

/** Writes a decrypted copy to Downloads and returns its path, for `openPath`. */
export function exportDictationAudio(uid: string, id: string): Promise<string> {
  return invoke<string>("dictation_history_export_audio", { uid, id });
}

export function exportDictationText(uid: string, id: string): Promise<string> {
  return invoke<string>("dictation_history_export_text", { uid, id });
}

export function loadDictationHistorySettings(uid: string): Promise<DictationHistorySettings> {
  return invoke<DictationHistorySettings>("dictation_history_settings", { uid });
}

/**
 * Turning history off stops future capture only. Existing entries are kept -
 * "stop recording me" and "erase what you have" are different requests, and
 * `clearDictationHistory` is the second one.
 */
export function setDictationHistoryEnabled(
  uid: string,
  enabled: boolean,
): Promise<DictationHistorySettings> {
  return invoke<DictationHistorySettings>("dictation_history_set_settings", { uid, enabled });
}
