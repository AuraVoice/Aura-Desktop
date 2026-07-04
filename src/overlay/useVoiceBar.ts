import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { fetchVoiceToken } from "../lib/voice";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { logError } from "../lib/log";
import { micCaptureFailedCode, voiceErrorMessageForCode } from "../lib/voiceErrorCopy";

export type VoiceSessionStatus =
  | "disconnected"
  | "connecting"
  | "ready"
  | "listening"
  | "processing"
  | "speaking"
  | "ended"
  | "error";

interface VoiceServerEvent {
  type: string;
  payload?: Record<string, unknown>;
  text?: string;
  message?: string;
}

// Both watchdogs turn a hung/gone-quiet call into a visible error instead of
// an endless spinner - direct port of the two timers `voice_session_service`
// drives, which is where `agent_join_timeout`/`agent_silent` actually
// originate (they're client-generated, not sent by the backend).
const AGENT_JOIN_TIMEOUT_MS = 20_000;
const SILENCE_WATCHDOG_MS = 15_000;

function setVoiceActive(active: boolean) {
  invoke("set_voice_active", { active }).catch((err) => logError("useVoiceBar: set_voice_active", err));
}

export function useVoiceBar() {
  const [status, setStatus] = useState<VoiceSessionStatus>("disconnected");
  const [assistantCaption, setAssistantCaption] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Tracked in both a ref (synchronous "is a room already live" checks below)
  // and state (so useScreenSight, which needs to attach/detach its own
  // DataReceived listener whenever the room instance actually changes, has
  // something it can put in a dependency array).
  const roomRef = useRef<Room | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const joinWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearWatchdogs = useCallback(() => {
    if (joinWatchdogRef.current) {
      clearTimeout(joinWatchdogRef.current);
      joinWatchdogRef.current = null;
    }
    if (silenceWatchdogRef.current) {
      clearTimeout(silenceWatchdogRef.current);
      silenceWatchdogRef.current = null;
    }
  }, []);

  // Clears the stale room reference along with showing the error - without
  // this, `startSession`'s `if (roomRef.current) return` guard would keep
  // blocking every retry tap after a call errors out.
  const enterErrorState = useCallback(
    (code: string | null, fallbackMessage?: string | null) => {
      clearWatchdogs();
      const activeRoom = roomRef.current;
      roomRef.current = null;
      setRoom(null);
      setErrorMessage(voiceErrorMessageForCode({ code, fallbackMessage: fallbackMessage ?? null }));
      setStatus("error");
      setVoiceActive(false);
      void activeRoom?.disconnect();
    },
    [clearWatchdogs],
  );

  const armSilenceWatchdog = useCallback(() => {
    if (silenceWatchdogRef.current) clearTimeout(silenceWatchdogRef.current);
    silenceWatchdogRef.current = setTimeout(() => {
      enterErrorState("agent_silent");
    }, SILENCE_WATCHDOG_MS);
  }, [enterErrorState]);

  const endSession = useCallback(async () => {
    clearWatchdogs();
    const activeRoom = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    await activeRoom?.disconnect();
    setStatus("disconnected");
    setAssistantCaption("");
    setErrorMessage(null);
    setVoiceActive(false);
  }, [clearWatchdogs]);

  const startSession = useCallback(async () => {
    if (roomRef.current) return;
    setStatus("connecting");
    setErrorMessage(null);
    setAssistantCaption("");
    setVoiceActive(true);

    const newRoom = new Room();
    roomRef.current = newRoom;
    setRoom(newRoom);

    joinWatchdogRef.current = setTimeout(() => {
      enterErrorState("agent_join_timeout");
    }, AGENT_JOIN_TIMEOUT_MS);

    newRoom.on(RoomEvent.Disconnected, () => {
      clearWatchdogs();
      setStatus("disconnected");
      roomRef.current = null;
      setRoom(null);
    });

    newRoom.on(RoomEvent.DataReceived, (payload) => {
      let event: VoiceServerEvent;
      try {
        event = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        return;
      }

      switch (event.type) {
        case "session.ready":
          clearWatchdogs();
          setStatus("ready");
          setErrorMessage(null);
          break;
        case "session.state":
          if (event.payload?.state === "listening") setStatus("listening");
          if (event.payload?.state === "speaking") setStatus("speaking");
          if (event.payload?.state === "processing") setStatus("processing");
          break;
        case "assistant.text.delta":
          armSilenceWatchdog();
          setStatus("speaking");
          setAssistantCaption(typeof event.text === "string" ? event.text : "");
          break;
        case "assistant.text.final":
          clearWatchdogs();
          setStatus("ready");
          break;
        case "user.text.delta":
          armSilenceWatchdog();
          setStatus("listening");
          break;
        case "user.text.final":
          armSilenceWatchdog();
          setStatus("processing");
          break;
        case "error":
        case "session.error": {
          const code = typeof event.payload?.code === "string" ? event.payload.code : null;
          enterErrorState(code, event.message ?? null);
          break;
        }
        case "session.ended":
          clearWatchdogs();
          setStatus("ended");
          setAssistantCaption("");
          setVoiceActive(false);
          break;
        default:
          break;
      }
    });

    try {
      const { token, url } = await fetchVoiceToken();
      await newRoom.connect(url, token);
      await newRoom.localParticipant.setMicrophoneEnabled(true);
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        clearWatchdogs();
        await routeToDashboardForExpiredSession();
        return;
      }
      logError("useVoiceBar: startSession", err);
      enterErrorState(null, "Couldn't start the call. Give it another shot in a sec?");
    }
  }, [armSilenceWatchdog, clearWatchdogs, enterErrorState]);

  useEffect(() => {
    return () => {
      clearWatchdogs();
      roomRef.current?.disconnect();
    };
  }, [clearWatchdogs]);

  const showMicSettingsHint = errorMessage === voiceErrorMessageForCode({ code: micCaptureFailedCode });

  return {
    status,
    assistantCaption,
    errorMessage,
    showMicSettingsHint,
    startSession,
    endSession,
    room,
  };
}

export type VoiceBarState = ReturnType<typeof useVoiceBar>;
