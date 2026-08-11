import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { logError } from "../lib/log";
import { showStatusPill } from "../lib/statusPill";

export function useStatusPillEvents(): void {
  useEffect(() => {
    let unlistenScreenSight: (() => void) | undefined;
    let unlistenGuide: (() => void) | undefined;
    let disposed = false;

    listen<{ armed: boolean }>("screen-sight-armed", (event) => {
      showStatusPill(event.payload.armed ? "screen-sight-on" : "screen-sight-off");
    })
      .then((fn) => {
        if (disposed) fn(); else unlistenScreenSight = fn;
      })
      .catch((error) => logError("useStatusPillEvents: screen sight", error));

    listen<{ armed: boolean }>("guide-armed", (event) => {
      showStatusPill(event.payload.armed ? "guide-on" : "guide-off");
    })
      .then((fn) => {
        if (disposed) fn(); else unlistenGuide = fn;
      })
      .catch((error) => logError("useStatusPillEvents: guide", error));

    return () => {
      disposed = true;
      unlistenScreenSight?.();
      unlistenGuide?.();
    };
  }, []);
}
