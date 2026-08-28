import { useEffect, useRef } from "react";
import { Room, RoomEvent, type RemoteParticipant } from "livekit-client";
import {
  validateAgentDataMessage,
  type KnownAgentEventType,
  type ValidAgentEvent,
} from "./agentData";
import { logError } from "./log";

/** Subscribes to the room's data channel and dispatches ONLY messages that
 * validateAgentDataMessage accepts with the given type. The shared ceremony
 * (on/off, try/catch, verdict + type filter) lives here once; required-field
 * semantics stay in each caller, which already narrows per feature. Consumers
 * that fan out over several types or track agent liveness keep their own
 * DataReceived handler. */
export function useAgentDataMessage(
  room: Room | null,
  type: KnownAgentEventType,
  onValid: (event: ValidAgentEvent) => void,
  errorLabel?: string,
): void {
  const onValidRef = useRef(onValid);
  onValidRef.current = onValid;
  const errorLabelRef = useRef(errorLabel);
  errorLabelRef.current = errorLabel;

  useEffect(() => {
    if (!room) return;
    function onDataReceived(
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) {
      try {
        const verdict = validateAgentDataMessage(payload, participant, topic);
        if (verdict.kind !== "valid" || verdict.type !== type) return;
        onValidRef.current(verdict);
      } catch (err) {
        logError(errorLabelRef.current ?? `useAgentDataMessage: ${type}`, err);
      }
    }
    room.on(RoomEvent.DataReceived, onDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room, type]);
}
