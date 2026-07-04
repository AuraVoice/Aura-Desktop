import { error as logErrorRaw } from "@tauri-apps/plugin-log";

/** Writes to the durable app log file under the app's data directory, not
 * just the (often-invisible, in a windowed release build) browser console. */
export function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logErrorRaw(`${context}: ${message}`).catch(() => {
    // Nowhere else durable to report a failure of the logger itself.
  });
}
