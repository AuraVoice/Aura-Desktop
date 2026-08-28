import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { STATUS_PILL_UPDATE } from "../lib/ipcEvents";
import { GlassSurface } from "./GlassSurface";
import type { StatusPillKind } from "../lib/statusPill";
import { logError, logInfo } from "../lib/log";
import "../theme/theme.css";
import "./GlassSurface.css";
import "./StatusPill.css";

interface StatusPillPayload {
  kind: StatusPillKind;
  sequence: number;
}

const copy: Record<StatusPillKind, string> = {
  "voice-muted": "Voice muted",
  "voice-unmuted": "Voice unmuted",
  "voice-change-unconfirmed": "Voice change not confirmed",
  "screen-sight-on": "Screen Sight on",
  "screen-sight-off": "Screen Sight off",
  "guide-on": "Guide Mode on",
  "guide-off": "Guide Mode off",
};

export function StatusPill() {
  const [status, setStatus] = useState<StatusPillPayload | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<StatusPillPayload>(STATUS_PILL_UPDATE, (event) => {
      if (!disposed) {
        logInfo("StatusPill: update", `kind=${event.payload.kind} sequence=${event.payload.sequence}`);
        setStatus(event.payload);
      }
    })
      .then((fn) => {
        if (disposed) fn(); else unlisten = fn;
      })
      .catch((error) => logError("StatusPill: listen", error));
    invoke<StatusPillPayload | null>("status_pill_state")
      .then((payload) => {
        if (!disposed) {
          logInfo("StatusPill: initial state", `kind=${payload?.kind ?? "none"}`);
          setStatus(payload);
        }
      })
      .catch((error) => logError("StatusPill: initial state", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!status) return null;
  return (
    <div className="status-pill-root" role="status" aria-live="polite">
      <GlassSurface
        key={status.sequence}
        className={`status-pill status-pill-${status.kind}`}
        draggable={false}
      >
        <StatusIcon kind={status.kind} />
        <span>{copy[status.kind]}</span>
      </GlassSurface>
    </div>
  );
}

function StatusIcon({ kind }: { kind: StatusPillKind }) {
  if (kind === "voice-muted" || kind === "voice-unmuted" || kind === "voice-change-unconfirmed") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 9.5h4L13 5v14l-5-4.5H4z" />
        {kind === "voice-unmuted" ? (
          <path d="M16 9a4.5 4.5 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" />
        ) : (
          <path d="M16 9l5 6M21 9l-5 6" />
        )}
      </svg>
    );
  }
  if (kind === "screen-sight-on" || kind === "screen-sight-off") {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
        <circle cx="12" cy="12" r="2.5" />
        {kind === "screen-sight-off" && <path d="M4 4l16 16" />}
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 3l13 9-6 1.5L9.5 19z" />
      {kind === "guide-off" && <path d="M4 4l16 16" />}
    </svg>
  );
}
