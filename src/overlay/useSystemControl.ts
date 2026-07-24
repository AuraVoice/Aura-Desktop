import { useEffect } from "react";
import { Room, RoomEvent, type RemoteParticipant } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { validateAgentDataMessage } from "../lib/agentData";
import { DESKTOP_CAPABILITIES } from "../lib/desktopCapabilities";
import { logError, logInfo } from "../lib/log";

/**
 * Turns an inbound `desktop.run` agent message into a single native command.
 * Structural sibling of useScreenSight's `onDataReceived` (same
 * sender/topic/schema validation via agentData.ts), narrowed to the one
 * message type desktop control uses.
 *
 * No verb-specific branching lives here: the verb is `payload.id`, looked up
 * in the client capability registry (desktopCapabilities.ts) and validated
 * before the one `run_desktop_capability` invoke. Native authorization
 * (signed-in + live voice) and the per-verb allowlist are enforced in Rust
 * (security.rs / system_control.rs) - this hook is not a trust boundary.
 */
export function useSystemControl(room: Room | null) {
  useEffect(() => {
    if (!room) return;

    function handleDesktopRun(payload: Record<string, unknown>) {
      try {
        const id = typeof payload?.id === "string" ? payload.id : "";
        const capability = DESKTOP_CAPABILITIES.get(id);
        if (!capability) {
          // Unknown verb from a newer backend: dropped here, but the message
          // already counted as agent liveness in useVoiceBar's DataReceived
          // handler, so the call never looks dead over version skew.
          logInfo("useSystemControl: unknown capability", `id=${id || "(none)"}`);
          return;
        }
        const rawArgs = payload?.args;
        const args = capability.validate(
          rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
            ? (rawArgs as Record<string, unknown>)
            : {},
        );
        if (!args) {
          logInfo("useSystemControl: rejected args", `id=${id}`);
          return;
        }
        invoke("run_desktop_capability", { id, args }).catch((err) =>
          logError("useSystemControl: run_desktop_capability", err),
        );
      } catch (err) {
        logError("useSystemControl: handleDesktopRun", err);
      }
    }

    function onDataReceived(
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) {
      try {
        const verdict = validateAgentDataMessage(payload, participant, topic);
        if (verdict.kind !== "valid") return;
        if (verdict.type === "desktop.run") handleDesktopRun(verdict.payload);
      } catch (err) {
        logError("useSystemControl: onDataReceived", err);
      }
    }

    room.on(RoomEvent.DataReceived, onDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room]);
}
