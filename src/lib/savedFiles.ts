import { invoke } from "@tauri-apps/api/core";

/** Opens a file the user saved through a Save As dialog this session, or shows it in its
 *  folder. Rust (save_dialog.rs) only opens paths its own dialog returned, so a file saved
 *  anywhere on disk works without widening the opener plugin's scope. */
export function openSavedFile(path: string, reveal = false): Promise<void> {
  return invoke<void>("open_saved_file", { path, reveal });
}

/** The last part of a saved path, for a "Saved as ..." line. */
export function savedFileName(path: string): string {
  return path.split(/[\/]/).filter(Boolean).pop() ?? path;
}

/** The folder a saved path sits in, by name ("Documents"), for "saved in ..." copy. */
export function savedFolderName(path: string): string {
  const parts = path.split(/[\/]/).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 2] : path;
}
