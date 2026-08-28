import { Room } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { useAgentDataMessage } from "../lib/useAgentDataMessage";
import { DESKTOP_CAPABILITIES } from "../lib/desktopCapabilities";
import { logError, logInfo } from "../lib/log";

/**
 * Turns an inbound `desktop.run` agent message into a single native command.
 * Sender/topic/schema validation is the shared useAgentDataMessage ceremony
 * (agentData.ts), narrowed to the one message type desktop control uses.
 *
 * No verb-specific branching lives here: the verb is `payload.id`, looked up
 * in the client capability registry (desktopCapabilities.ts) and validated
 * before the one `run_desktop_capability` invoke. Native authorization
 * (signed-in + live voice) and the per-verb allowlist are enforced in Rust
 * (security.rs / system_control.rs) - this hook is not a trust boundary.
 */
export function useSystemControl(room: Room | null) {
  useAgentDataMessage(
    room,
    "desktop.run",
    (event) => handleDesktopRun(event.payload),
    "useSystemControl: onDataReceived",
  );
}

function handleDesktopRun(payload: Record<string, unknown>) {
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
}
