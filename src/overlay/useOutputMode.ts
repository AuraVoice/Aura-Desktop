import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { OUTPUT_MUTE_TOGGLE_REQUESTED } from "../lib/ipcEvents";
import { type Room } from "livekit-client";
import { useAgentDataMessage } from "../lib/useAgentDataMessage";
import { publishOutputMode } from "../lib/clientControl";
import { logError, logInfo } from "../lib/log";
import { showStatusPill } from "../lib/statusPill";
import {
  loadOutputMode,
  outputMuted,
  setOutputMuted,
  subscribeOutputMode,
} from "../lib/outputMode";

// How long to wait for the worker's output.mode_ack before calling the mute
// client-side only. Generous next to a data-channel round trip, because the
// consequence of giving up early is a warning indicator on a mute that did in
// fact apply.
const ACK_TIMEOUT_MS = 3_000;

export type OutputAckState = "idle" | "pending" | "applied" | "unconfirmed";

export interface OutputModeState {
  muted: boolean;
  ackState: OutputAckState;
}

interface UseOutputModeOptions {
  room: Room | null;
}

/**
 * Owns the output-mute bit end to end: the Ctrl+Alt+M hotkey, persistence
 * (lib/outputMode.ts), the control published to a live worker, and the
 * acknowledgement that says server-side suppression actually happened.
 *
 * The client mutes its own playback the instant the bit flips, so the mute is
 * never at the mercy of the round trip. The ack decides only whether Aura is
 * ALSO silent at the source - which is what saves the TTS latency and the
 * Cartesia spend. An unacked mute is still a mute, just a more expensive one,
 * and the indicator says so rather than looking identical to the good case.
 */
export function useOutputMode({
  room,
}: UseOutputModeOptions): OutputModeState {
  const [muted, setMuted] = useState(outputMuted());
  const [ackState, setAckState] = useState<OutputAckState>("idle");
  const pendingGenerationRef = useRef<number | null>(null);
  const ackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const roomRef = useRef<Room | null>(room);
  roomRef.current = room;

  const clearAckTimer = useCallback(() => {
    if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    ackTimerRef.current = null;
  }, []);

  // Mirrors the module store into React state. Fires immediately on subscribe,
  // so the indicator is correct after a webview reload with the bit already set.
  useEffect(() => subscribeOutputMode((next) => setMuted(next)), []);

  useEffect(() => {
    void loadOutputMode();
  }, []);

  const publish = useCallback(
    (targetRoom: Room, generation: number, mode: "voice" | "text") => {
      pendingGenerationRef.current = generation;
      setAckState("pending");
      clearAckTimer();
      ackTimerRef.current = setTimeout(() => {
        ackTimerRef.current = null;
        if (pendingGenerationRef.current !== generation) return;
        pendingGenerationRef.current = null;
        setAckState("unconfirmed");
        showStatusPill("voice-change-unconfirmed");
        logInfo(
          "useOutputMode: no acknowledgement",
          `generation=${generation} mode=${mode} - muted on this device only, the worker is still synthesizing speech`,
        );
      }, ACK_TIMEOUT_MS);
      void publishOutputMode(targetRoom, { mode, generation }).catch((err) => {
        logError("useOutputMode: publish", err);
      });
    },
    [clearAckTimer],
  );

  // A mode set before the call started already rode the token metadata, so a
  // fresh room needs no control message. It does need an ack though, and the
  // worker publishes an unsolicited one at session start for exactly that.
  useEffect(() => {
    if (!room) {
      pendingGenerationRef.current = null;
      clearAckTimer();
      setAckState("idle");
    }
  }, [room, clearAckTimer]);

  useAgentDataMessage(
    room,
    "output.mode_ack",
    (event) => {
      const generation = event.payload.generation as number;
      const applied = event.payload.applied === true;
      const mode = event.payload.mode as string;
      // Generation 0 is the token-stamped mode the worker resolved on its own;
      // anything else must match the toggle still waiting for an answer, so a
      // late ack for a superseded toggle cannot repaint the indicator.
      const pending = pendingGenerationRef.current;
      if (generation !== 0 && generation !== pending) return;
      if (generation !== 0) pendingGenerationRef.current = null;
      clearAckTimer();
      setAckState(applied ? "applied" : "unconfirmed");
      logInfo(
        "useOutputMode: acknowledged",
        `generation=${generation} mode=${mode} applied=${applied}`,
      );
    },
    "useOutputMode: DataReceived handler",
  );

  const toggle = useCallback(() => {
    const next = !outputMuted();
    const generation = setOutputMuted(next);
    showStatusPill(next ? "voice-muted" : "voice-unmuted");
    const targetRoom = roomRef.current;
    if (targetRoom) {
      publish(targetRoom, generation, next ? "text" : "voice");
    } else {
      // No room to tell. The next /voice/token carries the mode instead, which
      // is the only way to beat the worker's first speech anyway.
      pendingGenerationRef.current = null;
      clearAckTimer();
      setAckState("idle");
    }
  }, [clearAckTimer, publish]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen(OUTPUT_MUTE_TOGGLE_REQUESTED, () => {
      toggle();
    })
      .then((fn) => {
        if (disposed) fn(); else unlisten = fn;
      })
      .catch((err) => logError("useOutputMode: listen output-mute-toggle-requested", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [toggle]);

  useEffect(
    () => () => {
      if (ackTimerRef.current) clearTimeout(ackTimerRef.current);
    },
    [],
  );

  return { muted, ackState };
}
