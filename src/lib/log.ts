import { error as logErrorRaw, info as logInfoRaw } from "@tauri-apps/plugin-log";

/** Writes to the durable app log file under the app's data directory, not
 * just the (often-invisible, in a windowed release build) browser console.
 * Also lands in the terminal running `npm run tauri dev`, since logging.rs
 * registers a Stdout target alongside the log file for every level down to
 * Info. */
export function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logErrorRaw(`${context}: ${message}`).catch(() => {
    // Nowhere else durable to report a failure of the logger itself.
  });
}

/** Same durable/terminal destination as logError, for tracing normal
 * progress (not just failures) - e.g. the voice call lifecycle, so a hang
 * can be diagnosed from which step it never got past. */
export function logInfo(context: string, message: string): void {
  logInfoRaw(`${context}: ${message}`).catch(() => {
    // Nowhere else durable to report a failure of the logger itself.
  });
}
