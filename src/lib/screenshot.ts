import { invoke } from "@tauri-apps/api/core";

/** Captures the monitor the app window is on and returns a base64 JPEG (no
 * `data:` prefix). Only ever called from an explicit user gesture. */
export async function captureScreenshot(): Promise<string> {
  return invoke<string>("capture_screenshot");
}
