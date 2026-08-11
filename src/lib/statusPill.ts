import { invoke } from "@tauri-apps/api/core";
import { logError, logInfo } from "./log";

export type StatusPillKind =
  | "voice-muted"
  | "voice-unmuted"
  | "voice-change-unconfirmed"
  | "screen-sight-on"
  | "screen-sight-off"
  | "guide-on"
  | "guide-off";

export function showStatusPill(kind: StatusPillKind): void {
  logInfo("statusPill: request", `kind=${kind}`);
  void invoke("show_status_pill", { kind }).catch((error) =>
    logError("statusPill: show", error),
  );
}
