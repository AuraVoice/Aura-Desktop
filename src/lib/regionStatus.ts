import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DICTATION_STATUS_CHANGED } from "./ipcEvents";
import { logError } from "./log";
import { isMac } from "./platformKeys";
import { useTauriEvent } from "./useTauriEvent";

/** Mirrors region/mod.rs RegionStatus (rename_all = "camelCase"). */
export interface RegionStatus {
  available: boolean;
  chordLabel: string;
  reason?: string;
  blocker?: "inputMonitoring" | "relaunch" | "screenRecording";
}

export function loadRegionStatus(): Promise<RegionStatus> {
  return invoke<RegionStatus>("region_status");
}

/** Live region status; null until the first read lands. There is no region
 * status event: both chords ride one keyboard listener, and its health changes
 * are already announced on the dictation status event, so that event is the
 * refresh trigger rather than a second event carrying the same fact. */
export function useRegionStatus(): RegionStatus | null {
  const [status, setStatus] = useState<RegionStatus | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    loadRegionStatus()
      .then((next) => {
        if (mountedRef.current) setStatus(next);
      })
      .catch((err) => logError("regionStatus: load", err));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useTauriEvent(DICTATION_STATUS_CHANGED, refresh, "regionStatus: listen dictation-status-changed");
  return status;
}

/** Shown only until the first `region_status` reply. Rust's
 * `DictationChord::label()` is the source of truth, as for dictation. */
const REGION_CHORD_FALLBACK = isMac() ? "Cmd + Option" : "Win + Alt";

/** The chord split into its keys, one <kbd> chip each. */
export function regionKeysOf(status: RegionStatus | null): string[] {
  return (status?.chordLabel ?? REGION_CHORD_FALLBACK).split(" + ");
}
