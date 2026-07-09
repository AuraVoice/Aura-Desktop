import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError } from "../lib/log";

interface UpdateReadyPayload {
  version: string;
}

const UPDATED_NOTICE_MS = 6000;

export interface UpdateReadyState {
  /** Version of a downloaded, ready-to-install update - never set before the
   * download finishes, so acting on it is always instant. */
  version: string | null;
  /** Version we just updated to, for a one-time confirmation caption. */
  updatedNotice: string | null;
}

/** Tracks the background updater (see src-tauri/src/updater.rs). */
export function useUpdateReady(): UpdateReadyState {
  const [version, setVersion] = useState<string | null>(null);
  const [updatedNotice, setUpdatedNotice] = useState<string | null>(null);
  const noticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<UpdateReadyPayload>("update-ready", (event) => {
      setVersion(event.payload.version);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("useUpdateReady: listen update-ready", err));

    // Covers the race where the download finished before this hook mounted,
    // same idiom as OverlayRoot's current_overlay_state query.
    invoke<string | null>("pending_update_version")
      .then((pending) => {
        if (pending) setVersion(pending);
      })
      .catch((err) => logError("useUpdateReady: pending_update_version", err));

    // Consumed on the Rust side, so a remount can't replay the caption.
    invoke<string | null>("just_updated_version")
      .then((updated) => {
        if (!updated) return;
        setUpdatedNotice(updated);
        noticeTimeoutRef.current = setTimeout(() => setUpdatedNotice(null), UPDATED_NOTICE_MS);
      })
      .catch((err) => logError("useUpdateReady: just_updated_version", err));

    return () => {
      unlisten?.();
      if (noticeTimeoutRef.current) clearTimeout(noticeTimeoutRef.current);
    };
  }, []);

  return { version, updatedNotice };
}
