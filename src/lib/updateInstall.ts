import { invoke } from "@tauri-apps/api/core";
import { update as copy } from "./copy";
import { logError } from "./log";
import { trackEvent } from "./analytics";

/** Shared by the overlay notch banner (UpdateBanner) and the dashboard's
 * centered dialog (UpdateDialog). Both surfaces drive the same install, so the
 * state machine lives here once rather than being copied per surface. */
export type InstallPhase = "idle" | "installing" | "deferred" | "failed" | "blocked" | "timeout";

// The one install failure the user can act on, so updater.rs hands back a
// marker rather than an errno. See its read_only_bundle_hint.
const READ_ONLY_BUNDLE = "bundle-read-only";

// On Windows a working install exits the process within seconds, and it never
// resolves this invoke. Without a deadline, a stuck installer launch left the
// dialog on "Restarting..." with every way out disabled (2026-09-15). This does
// not cancel the Rust side, which cannot be cancelled; it only hands the user
// back a dialog and the one step that helps. Long enough to cover a UAC prompt
// or the macOS admin password fallback.
const INSTALL_DEADLINE_MS = 60_000;
const TIMED_OUT = Symbol("timed-out");

export async function install(version: string, setPhase: (phase: InstallPhase) => void) {
  setPhase("installing");
  trackEvent("desktop_update_install_started", { version });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), INSTALL_DEADLINE_MS);
  });
  const attempt = invoke<boolean>("install_update");
  try {
    const installed = await Promise.race([attempt, deadline]);
    if (installed === TIMED_OUT) {
      // A late rejection after the deadline must not surface as unhandled, and
      // must not overwrite the timeout copy with a generic failure.
      attempt.catch((err) => logError("UpdateBanner: install update (after deadline)", err));
      trackEvent("desktop_update_install_result", { version, phase: "timeout" });
      setPhase("timeout");
      return;
    }
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
  } finally {
    clearTimeout(timer);
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
    case "timeout":
      return copy.timedOut;
    default:
      return copy.laterHint;
  }
}
