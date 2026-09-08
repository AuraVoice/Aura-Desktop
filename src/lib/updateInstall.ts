import { invoke } from "@tauri-apps/api/core";
import { update as copy } from "./copy";
import { logError } from "./log";
import { trackEvent } from "./analytics";

/** Shared by the overlay notch banner (UpdateBanner) and the dashboard's
 * centered dialog (UpdateDialog). Both surfaces drive the same install, so the
 * state machine lives here once rather than being copied per surface. */
export type InstallPhase = "idle" | "installing" | "deferred" | "failed" | "blocked";

// The one install failure the user can act on, so updater.rs hands back a
// marker rather than an errno. See its read_only_bundle_hint.
const READ_ONLY_BUNDLE = "bundle-read-only";

export async function install(version: string, setPhase: (phase: InstallPhase) => void) {
  setPhase("installing");
  trackEvent("desktop_update_install_started", { version });
  try {
    const installed = await invoke<boolean>("install_update");
    if (installed) {
      // The process restarts right after this; the SDK flushes what it can.
      trackEvent("desktop_update_install_result", { version, phase: "installing" });
      return;
    }
    const pending = await invoke<string | null>("pending_update_version");
    const phase: InstallPhase = pending === version ? "deferred" : "failed";
    trackEvent("desktop_update_install_result", { version, phase });
    setPhase(phase);
  } catch (err) {
    logError("UpdateBanner: install update", err);
    const phase: InstallPhase = err === READ_ONLY_BUNDLE ? "blocked" : "failed";
    trackEvent("desktop_update_install_result", { version, phase });
    setPhase(phase);
  }
}

export async function dismiss(version: string) {
  try {
    await invoke("dismiss_update_banner", { version });
  } catch (err) {
    logError("UpdateBanner: dismiss update", err);
  }
}

export function messageFor(phase: InstallPhase): string {
  switch (phase) {
    case "installing":
      return copy.restarting;
    case "deferred":
      return "Finish your call or meeting, then try again.";
    case "failed":
      return copy.failed;
    case "blocked":
      return copy.blocked;
    default:
      return copy.laterHint;
  }
}
