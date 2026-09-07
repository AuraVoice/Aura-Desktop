import { useState } from "react";
import { update as copy } from "./lib/copy";
import { GlassSurface } from "./overlay/GlassSurface";
import { dismiss, install, messageFor, type InstallPhase } from "./lib/updateInstall";
import "./UpdateBanner.css";

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
