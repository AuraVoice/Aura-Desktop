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
  /** Process stem of the app the hold was aimed at ("code", "chrome"). Null
   * for rows written before the column existed. */
  appStem: string | null;
  /** "inserted", "focus_changed", "keys_held", "blocked", "no_text_field" or
   * "command". Null for rows written before the column existed. */
  insertOutcome: string | null;
}

/** Process stems whose obvious capitalisation is not their product name. */
const APP_STEM_LABELS: Record<string, string> = {
  code: "VS Code",
  "code - insiders": "VS Code Insiders",
  cursor: "Cursor",
  windowsterminal: "Windows Terminal",
  wt: "Windows Terminal",
  chrome: "Chrome",
  msedge: "Edge",
  firefox: "Firefox",
  brave: "Brave",
  arc: "Arc",
  notepad: "Notepad",
  winword: "Word",
  outlook: "Outlook",
  olk: "Outlook",
  excel: "Excel",
  powerpnt: "PowerPoint",
  onenote: "OneNote",
  slack: "Slack",
  discord: "Discord",
  teams: "Teams",
  "ms-teams": "Teams",
  notion: "Notion",
  obsidian: "Obsidian",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  zoom: "Zoom",
  explorer: "File Explorer",
  applicationframehost: "Windows app",
};

/** "code" -> "VS Code", "someapp" -> "Someapp". */
export function appStemLabel(stem: string): string {
  const key = stem.toLowerCase();
  const known = APP_STEM_LABELS[key];
  if (known) return known;
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** The short reason a dictation never reached its field, or null when it did
 * (or when the row predates the outcome column). */
export function insertOutcomeLabel(outcome: string | null): string | null {
  switch (outcome) {
    case "focus_changed":
      return "Not typed: focus changed";
    case "keys_held":
      return "Not typed: keys still held";
    case "blocked":
      return "Not typed: app blocked input";
    case "no_text_field":
      return "Not typed: no text box";
    case "command":
      return "Ran as a command";
    default:
      return null;
  }
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
 * The decrypted clip for one dictation as an object URL the caller owns and
 * must revoke. Raw bytes rather than a file path: what is on disk is
 * ciphertext, so the asset protocol would hand `<audio>` garbage.
 *
 * WAV, not the stored FLAC: WKWebView cannot decode FLAC, so this played on
 * Windows and failed on every Mac. The command transcodes on the way out.
 */
export async function loadDictationAudioUrl(uid: string, id: string): Promise<string> {
  const raw = await invoke<ArrayBuffer>("dictation_history_audio", { uid, id });
  return URL.createObjectURL(new Blob([new Uint8Array(raw)], { type: "audio/wav" }));
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
