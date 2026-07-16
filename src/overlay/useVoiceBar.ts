import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteParticipant } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { validateAgentDataMessage } from "../lib/agentData";
import { fetchVoiceToken, VoiceCapError } from "../lib/voice";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { logError, logInfo } from "../lib/log";
import { trackEvent } from "../lib/analytics";
import { micCaptureFailedCode, voiceCapReachedCode, voiceErrorMessageForCode } from "../lib/voiceErrorCopy";
import { shouldArmInitialAgentSilenceWatchdog } from "./voiceSessionTiming";

export type VoiceSessionStatus =
  | "disconnected"
  | "connecting"
  | "ready"
  | "listening"
  | "processing"
  | "speaking"
  | "ended"
  | "error";

// Both watchdogs turn a hung/gone-quiet call into a visible error instead of
// an endless spinner - direct port of the two timers `voice_session_service`
// drives, which is where `agent_join_timeout`/`agent_silent` actually
// originate (they're client-generated, not sent by the backend).
const AGENT_JOIN_TIMEOUT_MS = 30_000;
const SILENCE_WATCHDOG_MS = 15_000;

// Auto-retry budget for a failed call. Excludes mic-access codes below, since
// those need the user to fix something in OS settings - retrying immediately
// just fails identically and burns the whole budget for nothing. The voice-cap
// code is in the same boat: the daily counter only resets server-side, so a
// retry can't succeed until the user upgrades or the day rolls over.
const MAX_AUTO_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const NON_RETRYABLE_CODES = new Set<string>([
  "mic_permission_denied",
  micCaptureFailedCode,
  voiceCapReachedCode,
]);

// Direct port of `_mapAgentState` - the agent reports its own state via a
// LiveKit participant attribute (`lk.agent.state`), not a data message.
function mapAgentState(agentState: string): VoiceSessionStatus {
  switch (agentState) {
    case "listening":
      return "listening";
    case "thinking":
      return "processing";
    case "speaking":
      return "speaking";
    case "failed":
    case "disconnected":
      return "error";
    default:
      return "listening";
  }
}

function setVoiceActive(active: boolean) {
  invoke("set_voice_active", { active }).catch((err) => logError("useVoiceBar: set_voice_active", err));
}

export function useVoiceBar() {
  const [status, setStatus] = useState<VoiceSessionStatus>("disconnected");
  const [assistantCaption, setAssistantCaption] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  // Tracked in both a ref (synchronous "is a room already live" checks below)
  // and state (so useScreenSight, which needs to attach/detach its own
  // listeners whenever the room instance actually changes, has something it
  // can put in a dependency array).
  const roomRef = useRef<Room | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  // Set as soon as fetchVoiceToken resolves, purely so a logged error can be
  // cross-referenced against the backend/LiveKit dashboard for that room.
  const roomNameRef = useRef<string | null>(null);
  const joinWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const silenceWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors Flutter's _didEmitSessionReady/_didReceiveAssistantOutput - lets
  // an unexpected RoomEvent.Disconnected be classified as a clean end vs. an
  // early-drop error, since nothing over the wire distinguishes those.
  const didConnectRef = useRef(false);
  const didReceiveAssistantOutputRef = useRef(false);
  const didTrackFirstResponseRef = useRef(false);
  const sessionStartedAtRef = useRef<number | null>(null);
  // Consecutive auto-retry count since the last genuine success. Reset only
  // by markAssistantResponded() - deliberately not by startSession() itself,
  // since an auto-retry calling startSession() would otherwise wipe out its
  // own counter and retry forever.
  const retryAttemptRef = useRef(0);
  const startSessionRef = useRef<() => void>(() => {});
  // The user's intent is separate from LiveKit's current transport state.
  // A generation invalidates every in-flight await from an older start, so a
  // fast second toggle can never enable the microphone after the user ended.
  const desiredActiveRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const [desiredActive, setDesiredActive] = useState(false);

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
      try {
        clearWatchdogs();
        const activeRoom = roomRef.current;
        roomRef.current = null;
        setRoom(null);
        logError(
          "useVoiceBar: enterErrorState",
          `code=${code ?? "none"} room=${roomNameRef.current ?? "unknown"} message=${fallbackMessage ?? "(mapped from code)"}`,
        );
        trackEvent("voice_error", { code: code ?? "unknown" });
        setErrorMessage(voiceErrorMessageForCode({ code, fallbackMessage: fallbackMessage ?? null }));
        setLastErrorCode(code);
        setStatus("error");
        setVoiceActive(false);
        if (code !== null && NON_RETRYABLE_CODES.has(code)) {
          desiredActiveRef.current = false;
          sessionGenerationRef.current += 1;
          setDesiredActive(false);
        }
        activeRoom?.disconnect().catch((err) => logError("useVoiceBar: enterErrorState disconnect", err));
      } catch (err) {
        logError("useVoiceBar: enterErrorState", err);
      }
    },
    [clearWatchdogs],
  );

  const armSilenceWatchdog = useCallback(() => {
    if (silenceWatchdogRef.current) clearTimeout(silenceWatchdogRef.current);
    silenceWatchdogRef.current = setTimeout(() => {
      enterErrorState("agent_silent");
    }, SILENCE_WATCHDOG_MS);
  }, [enterErrorState]);

  // Re-arms only if a silence timer is already ticking - mirrors Flutter's
  // `_pokeReplyWatchdog`'s "only if awaiting" guard, using "is the timer
  // running" as the proxy instead of a separate boolean.
  const pokeSilenceWatchdog = useCallback(() => {
    if (silenceWatchdogRef.current) armSilenceWatchdog();
  }, [armSilenceWatchdog]);

  // Direct port of `_markAssistantResponded` - the agent actually produced
  // real output (audio or a transcript), so stop watching and reset the
  // retry budget.
  const markAssistantResponded = useCallback(() => {
    didReceiveAssistantOutputRef.current = true;
    retryAttemptRef.current = 0;
    clearWatchdogs();
    if (!didTrackFirstResponseRef.current) {
      didTrackFirstResponseRef.current = true;
      trackEvent("voice_first_response");
    }
  }, [clearWatchdogs]);

  // Shared by the live ParticipantConnected event and the already-present-
  // agent check right after connect (below) - both need to clear the join
  // watchdog and start waiting for the agent's first real output the same way.
  const handleAgentJoined = useCallback(
    (participant: RemoteParticipant, source: string) => {
      const shouldArm = shouldArmInitialAgentSilenceWatchdog(
        didReceiveAssistantOutputRef.current,
      );
      logInfo(
        "useVoiceBar: agent joined",
        `source=${source} identity=${participant.identity} initialSilenceWatchdog=${shouldArm ? "armed" : "skipped"}`,
      );
      clearWatchdogs();
      if (shouldArm) armSilenceWatchdog();
    },
    [armSilenceWatchdog, clearWatchdogs],
  );

  const endSession = useCallback(async () => {
    desiredActiveRef.current = false;
    sessionGenerationRef.current += 1;
    setDesiredActive(false);
    clearWatchdogs();
    const activeRoom = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    roomNameRef.current = null;
    const startedAt = sessionStartedAtRef.current;
    sessionStartedAtRef.current = null;
    if (startedAt !== null) {
      trackEvent("voice_session_ended", { durationSeconds: Math.round((Date.now() - startedAt) / 1000) });
    }
    // Native authorization and the updater gate close synchronously with the
    // user's toggle. Muting and disconnecting are best-effort cleanups after
    // that boundary, not prerequisites for it.
    setVoiceActive(false);
    activeRoom?.localParticipant
      .setMicrophoneEnabled(false)
      .catch((err) => logError("useVoiceBar: endSession disable microphone", err));
    try {
      await activeRoom?.disconnect();
    } catch (err) {
      logError("useVoiceBar: endSession disconnect", err);
    }
    setStatus("disconnected");
    setAssistantCaption("");
    setErrorMessage(null);
    setLastErrorCode(null);
  }, [clearWatchdogs]);

  const startSession = useCallback(async () => {
    if (!desiredActiveRef.current) {
      desiredActiveRef.current = true;
      sessionGenerationRef.current += 1;
      setDesiredActive(true);
    }
    const generation = sessionGenerationRef.current;
    if (roomRef.current) {
      logInfo("useVoiceBar: startSession", "ignored - a room is already live");
      return;
    }
    setStatus("connecting");
    setErrorMessage(null);
    setLastErrorCode(null);
    setAssistantCaption("");
    setVoiceActive(true);
    didConnectRef.current = false;
    didReceiveAssistantOutputRef.current = false;
    didTrackFirstResponseRef.current = false;

    const newRoom = new Room();
    roomRef.current = newRoom;
    setRoom(newRoom);
    const sessionStillWanted = () =>
      desiredActiveRef.current &&
      sessionGenerationRef.current === generation &&
      roomRef.current === newRoom;

    newRoom.on(RoomEvent.Disconnected, (reason) => {
      try {
        if (roomRef.current !== newRoom) return; // already handled by endSession()/enterErrorState()
        if (!didConnectRef.current) {
          // startSession's own catch block owns a failure before connect()
          // ever resolved.
          clearWatchdogs();
          roomRef.current = null;
          setRoom(null);
          return;
        }
        logInfo(
          "useVoiceBar: Disconnected",
          `reason=${reason ?? "unknown"} assistantResponded=${didReceiveAssistantOutputRef.current}`,
        );
        if (didReceiveAssistantOutputRef.current) {
          clearWatchdogs();
          roomRef.current = null;
          setRoom(null);
          desiredActiveRef.current = false;
          sessionGenerationRef.current += 1;
          setDesiredActive(false);
          const startedAt = sessionStartedAtRef.current;
          sessionStartedAtRef.current = null;
          if (startedAt !== null) {
            trackEvent("voice_session_ended", { durationSeconds: Math.round((Date.now() - startedAt) / 1000) });
          }
          setStatus("ended");
          setAssistantCaption("");
          setVoiceActive(false);
        } else {
          enterErrorState("agent_disconnected_early");
        }
      } catch (err) {
        logError("useVoiceBar: Disconnected handler", err);
      }
    });

    // Diagnostic only - none of these drive status/UI, they exist to show
    // what LiveKit itself sees during a hang (ICE/media state), since a
    // failure here would otherwise look identical to the agent just not
    // responding.
    newRoom.on(RoomEvent.ConnectionStateChanged, (state) => {
      try {
        logInfo("useVoiceBar: ConnectionStateChanged", `state=${state}`);
      } catch (err) {
        logError("useVoiceBar: ConnectionStateChanged handler", err);
      }
    });

    newRoom.on(RoomEvent.ParticipantConnected, (participant) => {
      try {
        logInfo(
          "useVoiceBar: ParticipantConnected",
          `identity=${participant.identity} sid=${participant.sid} isAgent=${participant.isAgent}`,
        );
        if (participant.isAgent) {
          handleAgentJoined(participant, "participant-connected");
        }
      } catch (err) {
        logError("useVoiceBar: ParticipantConnected handler", err);
      }
    });

    newRoom.on(RoomEvent.ParticipantDisconnected, (participant) => {
      try {
        logInfo("useVoiceBar: ParticipantDisconnected", `identity=${participant.identity}`);
      } catch (err) {
        logError("useVoiceBar: ParticipantDisconnected handler", err);
      }
    });

    // The agent's real state (listening/thinking/speaking) - a native
    // LiveKit participant attribute, not a data message.
    newRoom.on(RoomEvent.ParticipantAttributesChanged, (changedAttributes, participant) => {
      try {
        if (participant.isLocal) return;
        const agentState = changedAttributes["lk.agent.state"];
        if (agentState === undefined) return;
        logInfo("useVoiceBar: ParticipantAttributesChanged", `lk.agent.state=${agentState}`);
        if (agentState === "thinking" || agentState === "speaking") {
          pokeSilenceWatchdog();
        }
        const mapped = mapAgentState(agentState);
        if (mapped === "error") {
          enterErrorState("agent_state_failed");
          return;
        }
        setStatus(mapped);
      } catch (err) {
        logError("useVoiceBar: ParticipantAttributesChanged handler", err);
      }
    });

    // Live captions - LiveKit's native transcription feature, not a data
    // message either.
    newRoom.on(RoomEvent.TranscriptionReceived, (segments, participant) => {
      try {
        const isAssistant = participant ? !participant.isLocal : false;
        for (const seg of segments) {
          if (isAssistant) {
            markAssistantResponded();
            setAssistantCaption(seg.text);
          } else if (seg.final) {
            // User just finished a turn - start the clock on Buddy's reply.
            armSilenceWatchdog();
          }
        }
      } catch (err) {
        logError("useVoiceBar: TranscriptionReceived handler", err);
      }
    });

    newRoom.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
      try {
        logInfo("useVoiceBar: TrackSubscribed", `kind=${track.kind} from=${participant.identity}`);
        // A subscribed track is just bookkeeping - nothing plays until it's
        // attached to a media element. Without this, the agent's voice
        // arrives over the wire and is silently discarded.
        if (track.kind === Track.Kind.Audio) {
          track.attach();
          markAssistantResponded();
        }
      } catch (err) {
        logError("useVoiceBar: TrackSubscribed handler", err);
      }
    });

    newRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      try {
        if (track.kind === Track.Kind.Audio) {
          track.detach();
        }
      } catch (err) {
        logError("useVoiceBar: TrackUnsubscribed handler", err);
      }
    });

    newRoom.on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant) => {
      try {
        logInfo("useVoiceBar: TrackSubscriptionFailed", `trackSid=${trackSid} from=${participant.identity}`);
      } catch (err) {
        logError("useVoiceBar: TrackSubscriptionFailed handler", err);
      }
    });

    newRoom.on(RoomEvent.MediaDevicesError, (err) => {
      try {
        logInfo("useVoiceBar: MediaDevicesError", err.message);
      } catch (loggingErr) {
        logError("useVoiceBar: MediaDevicesError handler", loggingErr);
      }
    });

    newRoom.on(RoomEvent.LocalTrackPublished, (publication) => {
      try {
        logInfo("useVoiceBar: LocalTrackPublished", `kind=${publication.kind} source=${publication.source}`);
      } catch (err) {
        logError("useVoiceBar: LocalTrackPublished handler", err);
      }
    });

    newRoom.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      try {
        logInfo("useVoiceBar: AudioPlaybackStatusChanged", `canPlaybackAudio=${newRoom.canPlaybackAudio}`);
        if (!newRoom.canPlaybackAudio) {
          newRoom.startAudio().catch((err) => logError("useVoiceBar: startAudio retry", err));
        }
      } catch (err) {
        logError("useVoiceBar: AudioPlaybackStatusChanged handler", err);
      }
    });

    // Narrowed to the one genuine case sent over the data channel -
    // session.state/assistant.text.*/user.text.*/bare error/session.ended
    // are declared in the backend's protocol but never actually published;
    // session.error is the sole real message that arrives this way. Every
    // message is sender-validated first (agentData.ts): only the verified
    // agent participant can report a session error or keep the silence
    // watchdog fed - a hostile participant must not be able to end the call
    // OR keep a dead one looking alive.
    newRoom.on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
      try {
        const verdict = validateAgentDataMessage(payload, participant, topic);
        if (verdict.kind === "rejected") return;
        // Anything from the verified agent - including an unknown type from
        // a newer backend - is a sign of life (element.point and draft.*
        // share this same data channel).
        pokeSilenceWatchdog();
        if (verdict.kind !== "valid") return;
        logInfo("useVoiceBar: DataReceived", `type=${verdict.type}`);
        if (verdict.type === "session.error") {
          const code = typeof verdict.payload.code === "string" ? verdict.payload.code : null;
          enterErrorState(code, verdict.message ?? null);
        }
      } catch (err) {
        logError("useVoiceBar: DataReceived handler", err);
      }
    });

    try {
      logInfo("useVoiceBar: startSession", "requesting voice token");
      const { token, url, room: roomName } = await fetchVoiceToken();
      if (!sessionStillWanted()) {
        await newRoom.disconnect().catch((disconnectErr) =>
          logError("useVoiceBar: cancelled after token fetch", disconnectErr),
        );
        return;
      }
      roomNameRef.current = roomName;
      logInfo("useVoiceBar: startSession", `got token for room=${roomName}, connecting to LiveKit`);
      await newRoom.connect(url, token);
      if (!sessionStillWanted()) {
        await newRoom.disconnect().catch((disconnectErr) =>
          logError("useVoiceBar: cancelled after connect", disconnectErr),
        );
        return;
      }
      didConnectRef.current = true;
      sessionStartedAtRef.current = Date.now();
      logInfo("useVoiceBar: startSession", `connected to room=${roomName}, enabling microphone`);

      // Mirrors Flutter's local synthesis of session.ready on room-connect -
      // nothing over the wire signals "the local half of the call is up."
      setStatus("ready");
      trackEvent("voice_session_started", { room: roomName });

      const existingAgent = Array.from(newRoom.remoteParticipants.values()).find((p) => p.isAgent);
      if (existingAgent) {
        // The agent was already in the room before our connect() resolved -
        // ParticipantConnected never fires retroactively for it (confirmed
        // empirically), so the live-join listener above would never catch it.
        handleAgentJoined(existingAgent, "already-present");
      } else {
        joinWatchdogRef.current = setTimeout(() => {
          enterErrorState("agent_join_timeout");
        }, AGENT_JOIN_TIMEOUT_MS);
      }

      // Capturing the return value, not just awaiting it - it resolves to
      // undefined (not a thrown error) if the webview never actually got a
      // usable mic track, which would otherwise pass through here silently.
      const micPublication = await newRoom.localParticipant.setMicrophoneEnabled(true);
      if (!sessionStillWanted()) {
        await newRoom.localParticipant.setMicrophoneEnabled(false).catch((disableErr) =>
          logError("useVoiceBar: cancelled after microphone enable", disableErr),
        );
        await newRoom.disconnect().catch((disconnectErr) =>
          logError("useVoiceBar: cancelled microphone disconnect", disconnectErr),
        );
        return;
      }
      const mediaTrack = micPublication?.track?.mediaStreamTrack;
      logInfo(
        "useVoiceBar: startSession",
        `microphone enabled, waiting for agent to join room=${roomName} - publication=${micPublication ? "present" : "UNDEFINED"} muted=${micPublication?.isMuted} trackReadyState=${mediaTrack?.readyState} trackEnabled=${mediaTrack?.enabled}`,
      );
    } catch (err) {
      if (!sessionStillWanted()) {
        await newRoom.disconnect().catch((disconnectErr) =>
          logError("useVoiceBar: cancelled start cleanup", disconnectErr),
        );
        return;
      }
      if (err instanceof AuthRequiredError) {
        await endSession();
        await routeToDashboardForExpiredSession();
        return;
      }
      if (err instanceof VoiceCapError) {
        // Free-tier daily cap: a known state, not a failure. The code is
        // non-retryable, so this shows the capped message and stays put.
        enterErrorState(voiceCapReachedCode);
        return;
      }
      logError("useVoiceBar: startSession", err);
      enterErrorState(null, "Couldn't start the call. Give it another shot in a sec?");
    }
  }, [armSilenceWatchdog, clearWatchdogs, endSession, enterErrorState, handleAgentJoined, markAssistantResponded, pokeSilenceWatchdog]);

  const toggleSession = useCallback(() => {
    if (desiredActiveRef.current) {
      void endSession();
    } else {
      void startSession();
    }
  }, [endSession, startSession]);

  // Lets the retry effect below call the latest startSession without being a
  // dependency of it (would be circular - the effect reacts to error state
  // that startSession itself produces).
  useEffect(() => {
    startSessionRef.current = () => {
      void startSession();
    };
  }, [startSession]);

  // Automatic retry with exponential backoff. Only reacts to genuinely new
  // error episodes (status/lastErrorCode actually changing), so this can't
  // double-schedule for the same failure.
  useEffect(() => {
    if (status !== "error") return;
    if (!desiredActiveRef.current) return;
    const code = lastErrorCode;
    if (code !== null && NON_RETRYABLE_CODES.has(code)) {
      logInfo("useVoiceBar: retry", `not retrying - code=${code} requires user action`);
      return;
    }
    if (retryAttemptRef.current >= MAX_AUTO_RETRIES) {
      logInfo("useVoiceBar: retry", `exhausted after ${MAX_AUTO_RETRIES} attempts, code=${code ?? "none"}`);
      trackEvent("voice_retry_exhausted", { code: code ?? "unknown", attempts: MAX_AUTO_RETRIES });
      desiredActiveRef.current = false;
      sessionGenerationRef.current += 1;
      setDesiredActive(false);
      setVoiceActive(false);
      return;
    }
    retryAttemptRef.current += 1;
    const attempt = retryAttemptRef.current;
    const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
    logInfo("useVoiceBar: retry", `scheduling attempt=${attempt} delayMs=${delay} code=${code ?? "none"}`);
    trackEvent("voice_retry_attempt", { attempt, delayMs: delay, code: code ?? "unknown" });
    const timeoutId = setTimeout(() => {
      try {
        if (!desiredActiveRef.current) return;
        startSessionRef.current();
      } catch (err) {
        logError("useVoiceBar: retry", err);
      }
    }, delay);
    return () => clearTimeout(timeoutId);
  }, [status, lastErrorCode]);

  useEffect(() => {
    return () => {
      desiredActiveRef.current = false;
      sessionGenerationRef.current += 1;
      clearWatchdogs();
      roomRef.current?.disconnect().catch((err) => logError("useVoiceBar: unmount disconnect", err));
      setVoiceActive(false);
    };
  }, [clearWatchdogs]);

  const showMicSettingsHint = errorMessage === voiceErrorMessageForCode({ code: micCaptureFailedCode });
  // Rides the existing error status + code rather than a new VoiceSessionStatus
  // member: the bar renders the capped state as a neutral notice with an
  // Upgrade pointer instead of the error treatment.
  const isVoiceCapped = status === "error" && lastErrorCode === voiceCapReachedCode;

  return {
    status,
    assistantCaption,
    errorMessage,
    showMicSettingsHint,
    isVoiceCapped,
    desiredActive,
    startSession,
    endSession,
    toggleSession,
    room,
  };
}

export type VoiceBarState = ReturnType<typeof useVoiceBar>;
