import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { update as copy } from "./lib/copy";
import { logError } from "./lib/log";
import { GlassSurface } from "./overlay/GlassSurface";
import "./UpdateBanner.css";

type InstallPhase = "idle" | "installing" | "deferred" | "failed" | "blocked";

// The one install failure the user can act on, so updater.rs hands back a
// marker rather than an errno. See its read_only_bundle_hint.
const READ_ONLY_BUNDLE = "bundle-read-only";

export function UpdateBanner({
  version,
  updatedVersion = null,
  surface,
}: {
  version: string | null;
  updatedVersion?: string | null;
  surface: "overlay" | "dashboard";
}) {
  const [phase, setPhase] = useState<InstallPhase>("idle");

  if (!version && !updatedVersion) return null;

  const content = updatedVersion ? (
    <div className="update-banner-copy" role="status">
      <strong>{copy.updatedNotice(updatedVersion)}</strong>
    </div>
  ) : version ? (
    <>
      <div
        className="update-banner-copy"
        role={phase === "failed" || phase === "blocked" ? "alert" : "status"}
      >
        <strong>{copy.ready(version)}</strong>
        <span>{messageFor(phase)}</span>
      </div>
      <div className="update-banner-actions">
        <button
          type="button"
          className="update-banner-primary"
          disabled={phase === "installing"}
          onClick={() => void install(version, setPhase)}
        >
          {phase === "installing" ? copy.restartBusy : copy.restartIdle}
        </button>
        <button
          type="button"
          className="update-banner-secondary"
          disabled={phase === "installing"}
          onClick={() => void dismiss(version)}
        >
          {copy.later}
        </button>
      </div>
    </>
  ) : null;

  if (surface === "overlay") {
    return (
      <GlassSurface className="update-banner update-banner-overlay" draggable={false}>
        {content}
      </GlassSurface>
    );
  }

  return <section className="update-banner update-banner-dashboard">{content}</section>;
}

async function install(version: string, setPhase: (phase: InstallPhase) => void) {
  setPhase("installing");
  try {
    const installed = await invoke<boolean>("install_update");
    if (installed) return;
    const pending = await invoke<string | null>("pending_update_version");
    setPhase(pending === version ? "deferred" : "failed");
  } catch (err) {
    logError("UpdateBanner: install update", err);
    setPhase(err === READ_ONLY_BUNDLE ? "blocked" : "failed");
  }
}

async function dismiss(version: string) {
  try {
    await invoke("dismiss_update_banner", { version });
  } catch (err) {
    logError("UpdateBanner: dismiss update", err);
  }
}

function messageFor(phase: InstallPhase): string {
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
