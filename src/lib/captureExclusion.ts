import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";

/** Mirrors `CaptureExclusionStatus` in lib.rs. `state` is the platform's own
 * read-back value, not what the app asked for: "applied" means the window was
 * confirmed absent from screen captures and screen shares, "failed" means the
 * call or the read-back disagreed, and "unknown" means nobody has tried for
 * this window yet. */
export interface CaptureExclusionStatus {
  applied: boolean;
  state: "unknown" | "applied" | "failed";
  /** The native reason, present only when `state` is "failed". For logs and
   * support, never for the card: it is a Win32/AppKit string. */
  detail?: string;
}

/** Defaults to the overlay window, which hosts every card. */
export function loadCaptureExclusion(label?: string): Promise<CaptureExclusionStatus> {
  return invoke<CaptureExclusionStatus>("capture_exclusion_status", { label: label ?? null });
}

/** Fails CLOSED. A status that cannot be read is not evidence the window is
 * hidden, and the one consumer uses this to decide whether to warn the user
 * that Aura may be visible in a screen share. Claiming "hidden" on an invoke
 * error would make the warning silently unreachable, which is the exact
 * failure this whole path exists to remove. */
export async function captureExclusionApplied(label?: string): Promise<boolean> {
  try {
    return (await loadCaptureExclusion(label)).applied;
  } catch (error) {
    logError("captureExclusion: status read failed", error);
    return false;
  }
}
