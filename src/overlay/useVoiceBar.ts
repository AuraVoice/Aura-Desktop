import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, type RemoteParticipant, type RemoteTrack } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { validateAgentDataMessage } from "../lib/agentData";
import { fetchVoiceToken, VoiceCapError, type VoiceSessionMode } from "../lib/voice";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { logError, logInfo } from "../lib/log";
import { trackEvent } from "../lib/analytics";
import { micCaptureFailedCode, voiceCapReachedCode, voiceErrorMessageForCode } from "../lib/voiceErrorCopy";
import { shouldArmInitialAgentSilenceWatchdog } from "./voiceSessionTiming";
import { startRealtimeLeg, type RealtimeActivity } from "../lib/realtime";
import { outputMuted, subscribeOutputMode } from "../lib/outputMode";
import { BridgeCoordinator } from "./bridgeCoordinator";

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
// Realtime is the fast first-turn leg, but it must never delay the normal voice
// path when its session mint or WebRTC negotiation is unhealthy. LiveKit is warmed
// in parallel, so this is the maximum extra time we are willing to wait before
// handing the already-prepared room the microphone.
// TEMP (diagnostic): bumped from 5_000 so the Realtime leg has room to actually
// connect and we can observe true TTFT instead of always tripping the race. Revert
// to a real budget (and move the mint outside the race) once measured.
const REALTIME_STARTUP_TIMEOUT_MS = 20_000;

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
  const sessionModeRef = useRef<VoiceSessionMode>("standard");
  // The user's intent is separate from LiveKit's current transport state.
  // A generation invalidates every in-flight await from an older start, so a
  // fast second toggle can never enable the microphone after the user ended.
  const desiredActiveRef = useRef(false);
  const sessionGenerationRef = useRef(0);
  const [desiredActive, setDesiredActive] = useState(false);
  const [realtimeActivity, setRealtimeActivity] = useState<RealtimeActivity | null>(null);
  const [realtimeVisualizerTrack, setRealtimeVisualizerTrack] = useState<MediaStreamTrack | null>(null);
  // The in-flight (or settled) prepareSession promise - activateSession awaits
  // it so the gesture hook can run prepare in parallel with the native summon.
  const preparePromiseRef = useRef<Promise<void> | null>(null);
  // Timing marks for the connect pipeline. tapAtMs comes from the gesture hook
  // (the native double-tap timestamp), the other two are set during prepare.
  const tapAtMsRef = useRef<number | null>(null);
  const connectResolvedAtRef = useRef<number | null>(null);
  const agentJoinMsRef = useRef<number | null>(null);
  // Content-free funnel fields folded into the voice_first_response event: the
  // token/connect timings and which transport actually served the first response
  // (cold LiveKit vs the Realtime bridge, or why the bridge fell back). No
  // transcript, screen, or room/identity content ever rides this event.
  const lastTokenMsRef = useRef<number | null>(null);
  const lastConnectMsRef = useRef<number | null>(null);
  const bridgeOutcomeRef = useRef<string>("cold");
  // Realtime bridge overlay (see bridgeCoordinator.ts). bridgedRef marks the current
  // session as bridged so the room event handlers route agent audio/data to the
  // coordinator instead of the normal cold path; bridgeRef holds the live coordinator.
  // Both null/false for every non-bridge session, so the standard flow is untouched.
  const bridgedRef = useRef(false);
  const bridgeRef = useRef<BridgeCoordinator | null>(null);
  // bridgedRef flips true before LiveKit even connects, but bridgeRef isn't built
  // until after the Realtime handshake finishes - the agent can join and subscribe
  // its audio track in that gap (seen as agentJoinMs=0 in the logs). If that track
  // hit the unmuted `track.attach()` path it played concurrently with the live
  // Realtime leg, i.e. the two-voices-at-once bug. Stash it here and hand it to the
  // coordinator the moment it exists instead.
  const pendingAgentTrackRef = useRef<RemoteTrack | null>(null);
  // LiveKit and Realtime start concurrently. A warm worker can publish
  // hold_ready before the Realtime promise resolves and before bridgeRef is
  // constructed. Retain only verified bridge controls across that short gap,
  // then replay them in arrival order once the coordinator exists.
  const pendingBridgeControlsRef = useRef<Record<string, unknown>[]>([]);
  const realtimeAudioElRef = useRef<HTMLAudioElement | null>(null);
  const liveKitAudioElRef = useRef<HTMLAudioElement | null>(null);
  // Output mute's local half (lib/outputMode.ts). The worker stops synthesizing
  // from the next turn, which is what saves the TTS latency and spend, but the
  // sentence already in flight was handed to its audio sink before the mode
  // changed. Silencing playback here is what makes "mute" mean "quiet now".
  // Three surfaces, because the bridge does not use LiveKit tracks: subscribed
  // agent tracks, the Realtime leg's element, and the bridge's LiveKit element.
  const agentAudioTracksRef = useRef<Set<RemoteTrack>>(new Set());

  const applyOutputMuteToTrack = (track: RemoteTrack, muted: boolean): void => {
    try {
      const remoteAudio = track as RemoteTrack & { setVolume?: (volume: number) => void };
      remoteAudio.setVolume?.(muted ? 0 : 1);
    } catch (err) {
      logError("useVoiceBar: applyOutputMuteToTrack", err);
    }
  };

  const ensureAudioEl = (ref: React.MutableRefObject<HTMLAudioElement | null>): HTMLAudioElement => {
    if (!ref.current) {
      const el = new Audio();
      el.autoplay = true;
      ref.current = el;
    }
    ref.current.muted = outputMuted();
    return ref.current;
  };

  useEffect(
    () =>
      subscribeOutputMode((muted) => {
        for (const track of agentAudioTracksRef.current) {
          applyOutputMuteToTrack(track, muted);
        }
        if (realtimeAudioElRef.current) realtimeAudioElRef.current.muted = muted;
        if (liveKitAudioElRef.current) liveKitAudioElRef.current.muted = muted;
      }),
    [],
  );

  const teardownBridge = useCallback(() => {
    bridgeRef.current?.teardown();
    bridgeRef.current = null;
    bridgedRef.current = false;
    pendingAgentTrackRef.current = null;
    pendingBridgeControlsRef.current = [];
    setRealtimeActivity(null);
    setRealtimeVisualizerTrack(null);
  }, []);

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
        teardownBridge();
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
    [clearWatchdogs, teardownBridge],
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
    // Captured before the reset below so the funnel event records which retry
    // attempt actually produced the first response (0 = first try).
    const retryAttemptAtResponse = retryAttemptRef.current;
    retryAttemptRef.current = 0;
    clearWatchdogs();
    if (!didTrackFirstResponseRef.current) {
      didTrackFirstResponseRef.current = true;
      // Measured from the user's actual keypress, so it spans summon, token,
      // connect, agent join, and the first spoken/streamed output - the number
      // the warm-pool + pre-dispatch work is supposed to shrink. Consumed once
      // so an auto-retry's first response doesn't reuse a stale tap.
      const tapAtMs = tapAtMsRef.current;
      tapAtMsRef.current = null;
      const tapToFirstResponseMs = tapAtMs !== null ? Math.max(0, Date.now() - tapAtMs) : null;
      logInfo(
        "useVoiceBar: first response",
        `tapToFirstResponseMs=${tapToFirstResponseMs ?? "unknown"} agentJoinMs=${agentJoinMsRef.current ?? "unknown"}`,
      );
      const timing: Record<string, unknown> = { path: bridgeOutcomeRef.current };
      if (tapToFirstResponseMs !== null) timing.tapToFirstResponseMs = tapToFirstResponseMs;
      if (agentJoinMsRef.current !== null) timing.agentJoinMs = agentJoinMsRef.current;
      if (lastTokenMsRef.current !== null) timing.tokenMs = lastTokenMsRef.current;
      if (lastConnectMsRef.current !== null) timing.connectMs = lastConnectMsRef.current;
      timing.retryAttempt = retryAttemptAtResponse;
      trackEvent("voice_first_response", timing);
      // Default the next session to cold; a bridge attempt re-labels it in
      // startBridgedSession before its first response is tracked.
      bridgeOutcomeRef.current = "cold";
    }
  }, [clearWatchdogs]);

  // Called by the gesture hook with the native double-tap timestamp from
  // voice_toggle_key.rs before it starts a session.
  const noteTapTimestamp = useCallback((tapAtMs: number | null) => {
    tapAtMsRef.current = tapAtMs;
  }, []);

  // Shared by the live ParticipantConnected event and the already-present-
  // agent check right after connect (below) - both need to clear the join
  // watchdog and start waiting for the agent's first real output the same way.
  const handleAgentJoined = useCallback(
    (participant: RemoteParticipant, source: string) => {
      const shouldArm = shouldArmInitialAgentSilenceWatchdog(
        didReceiveAssistantOutputRef.current,
      );
      const agentJoinMs =
        connectResolvedAtRef.current !== null
          ? Math.max(0, Date.now() - connectResolvedAtRef.current)
          : null;
      if (agentJoinMs !== null) agentJoinMsRef.current = agentJoinMs;
      logInfo(
        "useVoiceBar: agent joined",
        `source=${source} identity=${participant.identity} agentJoinMs=${agentJoinMs ?? "unknown"} initialSilenceWatchdog=${shouldArm ? "armed" : "skipped"}`,
      );
      clearWatchdogs();
      if (shouldArm) armSilenceWatchdog();
      bridgeRef.current?.onAgentReady();
    },
    [armSilenceWatchdog, clearWatchdogs],
  );

  const endSession = useCallback(async () => {
    desiredActiveRef.current = false;
    sessionGenerationRef.current += 1;
    setDesiredActive(false);
    clearWatchdogs();
    teardownBridge();
    const activeRoom = roomRef.current;
    roomRef.current = null;
    setRoom(null);
    roomNameRef.current = null;
    preparePromiseRef.current = null;
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
  }, [clearWatchdogs, teardownBridge]);

  // Transport-only half of session start: token fetch, room creation, and
  // connect - everything that dispatches the agent but nothing the user can
  // perceive. Split from activateSession so the gesture hook can run this in
  // parallel with the native summon, shaving the token+connect+agent-join
  // window off tap-to-first-response. The returned promise never rejects;
  // failures land in enterErrorState exactly as they did before the split.
  const prepareSession = useCallback(
    (
      requestedMode?: VoiceSessionMode,
      onRealtimeBridgeCapability?: (enabled: boolean) => void,
    ): Promise<void> => {
      const mode = requestedMode ?? (desiredActiveRef.current ? sessionModeRef.current : "standard");
      let bridgeCapabilityReported = false;
      const reportRealtimeBridgeCapability = (enabled: boolean) => {
        if (bridgeCapabilityReported) return;
        bridgeCapabilityReported = true;
        onRealtimeBridgeCapability?.(enabled);
      };
      if (!desiredActiveRef.current) {
        sessionModeRef.current = mode;
        desiredActiveRef.current = true;
        sessionGenerationRef.current += 1;
        setDesiredActive(true);
      }
      const generation = sessionGenerationRef.current;
      if (roomRef.current) {
        logInfo("useVoiceBar: prepareSession", "ignored - a room is already live");
        reportRealtimeBridgeCapability(false);
        return preparePromiseRef.current ?? Promise.resolve();
      }
      setStatus("connecting");
      setErrorMessage(null);
      setLastErrorCode(null);
      setAssistantCaption("");
      didConnectRef.current = false;
      didReceiveAssistantOutputRef.current = false;
      didTrackFirstResponseRef.current = false;
      connectResolvedAtRef.current = null;
      agentJoinMsRef.current = null;

    agentAudioTracksRef.current.clear();
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
        // Secondary "agent is warm" confirmation for the bridge. The decision actually
        // gates on the worker's hold_ready message, so this is best-effort logging only.
        if (bridgeRef.current) bridgeRef.current.onAgentReady();
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
          // A future track is born at the current output mode, before it is ever
          // attached, so a track that arrives while muted never plays a word.
          agentAudioTracksRef.current.add(track);
          applyOutputMuteToTrack(track, outputMuted());
          // In bridge mode the LiveKit agent joins in HOLD; its audio must stay muted
          // until handover_applied, so route it to the coordinator's muted sink instead
          // of attaching (and becoming audible) here. bridgedRef flips true before the
          // coordinator is built, so the agent can subscribe in that gap - stash the
          // track rather than falling through to the unmuted attach() below, which
          // would play it concurrently with the live Realtime leg.
          if (bridgeRef.current) {
            bridgeRef.current.attachAgentAudio(track);
          } else if (bridgedRef.current) {
            pendingAgentTrackRef.current = track;
          } else {
            track.attach();
          }
          markAssistantResponded();
        }
      } catch (err) {
        logError("useVoiceBar: TrackSubscribed handler", err);
      }
    });

    newRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      try {
        if (track.kind === Track.Kind.Audio) {
          agentAudioTracksRef.current.delete(track);
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
        // Bridge control (hold_ready / handover_applied) rides this same verified-agent
        // channel. Handled before the typed-message parse below, which only knows the
        // legacy session.error shape.
        if (bridgedRef.current) {
          try {
            const controlMsg = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
            if (bridgeRef.current?.handleDataMessage(controlMsg)) return;
            if (
              !bridgeRef.current &&
              (controlMsg.type === "hold_ready" || controlMsg.type === "handover_applied")
            ) {
              pendingBridgeControlsRef.current.push(controlMsg);
              logInfo("useVoiceBar: bridge control queued", `type=${String(controlMsg.type)}`);
              return;
            }
          } catch {
            /* not a bridge control JSON payload */
          }
        }
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

    const prepared = (async () => {
      try {
        logInfo("useVoiceBar: prepareSession", "requesting voice token");
        const tokenRequestedAt = Date.now();
        const voiceToken = await fetchVoiceToken(sessionModeRef.current, bridgedRef.current);
        reportRealtimeBridgeCapability(voiceToken.realtime_bridge_enabled !== false);
        const { token, url, room: roomName } = voiceToken;
        const tokenMs = Date.now() - tokenRequestedAt;
        lastTokenMsRef.current = tokenMs;
        if (!sessionStillWanted()) {
          await newRoom.disconnect().catch((disconnectErr) =>
            logError("useVoiceBar: cancelled after token fetch", disconnectErr),
          );
          return;
        }
        roomNameRef.current = roomName;
        logInfo(
          "useVoiceBar: prepareSession",
          `got token for room=${roomName} tokenMs=${tokenMs}, connecting to LiveKit`,
        );
        const connectStartedAt = Date.now();
        await newRoom.connect(url, token);
        const connectMs = Date.now() - connectStartedAt;
        lastConnectMsRef.current = connectMs;
        if (!sessionStillWanted()) {
          await newRoom.disconnect().catch((disconnectErr) =>
            logError("useVoiceBar: cancelled after connect", disconnectErr),
          );
          return;
        }
        didConnectRef.current = true;
        connectResolvedAtRef.current = Date.now();
        sessionStartedAtRef.current = Date.now();
        logInfo(
          "useVoiceBar: prepareSession",
          `connected to room=${roomName} tokenMs=${tokenMs} connectMs=${connectMs}`,
        );

        // Mirrors Flutter's local synthesis of session.ready on room-connect -
        // nothing over the wire signals "the local half of the call is up."
        setStatus("ready");
        trackEvent("voice_session_started", { room: roomName, tokenMs, connectMs });

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
      } catch (err) {
        reportRealtimeBridgeCapability(false);
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
        logError("useVoiceBar: prepareSession", err);
        enterErrorState(null, "Couldn't start the call. Give it another shot in a sec?");
      }
    })();
    preparePromiseRef.current = prepared;
    return prepared;
  }, [armSilenceWatchdog, clearWatchdogs, endSession, enterErrorState, handleAgentJoined, markAssistantResponded, pokeSilenceWatchdog]);

  // User-perceivable half of session start: mark the call live natively (which
  // gates the updater and overlay state) and open the microphone. Waits for
  // whatever prepareSession is in flight, so callers may fire the two in
  // parallel. Safe against a prepare that failed or a session the user ended
  // while this waited.
  const activateSession = useCallback(async () => {
    const generation = sessionGenerationRef.current;
    setVoiceActive(true);
    await (preparePromiseRef.current ?? Promise.resolve());
    const activeRoom = roomRef.current;
    const sessionStillWanted = () =>
      desiredActiveRef.current &&
      sessionGenerationRef.current === generation &&
      roomRef.current === activeRoom;
    if (!activeRoom || !didConnectRef.current || !sessionStillWanted()) {
      // Prepare failed or the user cancelled while we waited. Undo the
      // call-live mark only if no newer attempt owns it now.
      if (sessionGenerationRef.current === generation && !roomRef.current) {
        setVoiceActive(false);
      }
      return;
    }
    try {
      // Capturing the return value, not just awaiting it - it resolves to
      // undefined (not a thrown error) if the webview never actually got a
      // usable mic track, which would otherwise pass through here silently.
      const micPublication = await activeRoom.localParticipant.setMicrophoneEnabled(true);
      if (!sessionStillWanted()) {
        await activeRoom.localParticipant.setMicrophoneEnabled(false).catch((disableErr) =>
          logError("useVoiceBar: cancelled after microphone enable", disableErr),
        );
        await activeRoom.disconnect().catch((disconnectErr) =>
          logError("useVoiceBar: cancelled microphone disconnect", disconnectErr),
        );
        return;
      }
      const mediaTrack = micPublication?.track?.mediaStreamTrack;
      logInfo(
        "useVoiceBar: activateSession",
        `microphone enabled, waiting for agent to join room=${roomNameRef.current ?? "unknown"} - publication=${micPublication ? "present" : "UNDEFINED"} muted=${micPublication?.isMuted} trackReadyState=${mediaTrack?.readyState} trackEnabled=${mediaTrack?.enabled}`,
      );
    } catch (err) {
      if (!sessionStillWanted()) {
        await activeRoom.disconnect().catch((disconnectErr) =>
          logError("useVoiceBar: cancelled activate cleanup", disconnectErr),
        );
        return;
      }
      logError("useVoiceBar: activateSession", err);
      enterErrorState(null, "Couldn't start the call. Give it another shot in a sec?");
    }
  }, [enterErrorState]);

  // The original single-call entry point, preserved for every caller that has
  // no reason to split the phases (retry effect, tray/deep-link start, the
  // onboarding demo). Prepare's sync section runs before activate, so the
  // native call-live mark still lands ahead of the token fetch resolving.
  const startSession = useCallback(async (mode: VoiceSessionMode = "standard") => {
    void prepareSession(mode);
    await activateSession();
  }, [activateSession, prepareSession]);

  // Bridged start: open the instant OpenAI Realtime leg AND warm LiveKit in parallel, then
  // let BridgeCoordinator hand off. The one shared mic goes to Realtime first and is
  // replaceTrack'd onto LiveKit at handover, so there is never double-capture. If Realtime
  // is unavailable (bridge disabled server-side, secret mint fails, mic denied) we fall
  // straight back to the normal cold LiveKit session - the user still gets voice, slower.
  const startBridgedSession = useCallback(
    async (mode: VoiceSessionMode = "standard") => {
      setVoiceActive(true);
      // Reset for this attempt; re-labeled below to "bridged" on success or the
      // fall-back reason in the catch. The cold-fallback session that follows a
      // failure keeps that reason, so the funnel shows the tap tried the bridge.
      bridgeOutcomeRef.current = "cold";
      const controller = new AbortController();
      let sharedTrack: MediaStreamTrack | null = null;
      let realtimeRemoteTrack: MediaStreamTrack | null = null;
      let currentRealtimeActivity: RealtimeActivity = "listening";
      let realtimeTimeout: ReturnType<typeof setTimeout> | null = null;
      let fallbackStarted = false;
      const fallbackToColdPath = async (reason: unknown) => {
        if (fallbackStarted) return;
        fallbackStarted = true;
        if (realtimeTimeout) {
          clearTimeout(realtimeTimeout);
          realtimeTimeout = null;
        }
        controller.abort();
        const coordinator = bridgeRef.current;
        bridgeRef.current = null;
        coordinator?.teardown();
        sharedTrack?.stop();
        pendingAgentTrackRef.current = null;
        pendingBridgeControlsRef.current = [];
        setRealtimeActivity(null);
        setRealtimeVisualizerTrack(null);
        const detail = String(reason);
        bridgeOutcomeRef.current = detail.includes("timed out")
          ? "bridge_timeout"
          : detail.includes("mint failed") || detail.includes("(503)")
            ? "bridge_unavailable"
            : "bridge_error";
        logInfo("useVoiceBar: bridge unavailable, falling back to cold path", detail);
        // A bridge-mode room cannot become a normal session because that
        // worker may still be in HOLD. Replace it with a fresh, non-bridged
        // room exactly once and let the normal LiveKit path own the call.
        if (!desiredActiveRef.current) return;
        bridgedRef.current = false;
        await endSession();
        if (desiredActiveRef.current) return;
        await startSession(mode);
      };
      try {
        // Start the cold-path transport before waiting on Realtime. prepareSession
        // only mints/connects LiveKit and does not enable its microphone, so the
        // shared track remains exclusively owned by Realtime until handover.
        // It must be marked bridged before prepareSession starts because the token
        // request selects the worker's HOLD behavior.
        bridgedRef.current = true;
        let resolveBridgeCapability!: (enabled: boolean) => void;
        const bridgeCapability = new Promise<boolean>((resolve) => {
          resolveBridgeCapability = resolve;
        });
        const liveKitPrepare = prepareSession(mode, (enabled) => {
          if (!enabled) bridgedRef.current = false;
          resolveBridgeCapability(enabled);
        });
        if (!(await bridgeCapability)) {
          bridgeOutcomeRef.current = "bridge_disabled";
          logInfo("useVoiceBar: bridge disabled", "using prepared LiveKit room");
          await liveKitPrepare;
          await activateSession();
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        sharedTrack = stream.getAudioTracks()[0] ?? null;
        if (!sharedTrack) throw new Error("no audio track from getUserMedia");
        setRealtimeActivity("listening");
        setRealtimeVisualizerTrack(sharedTrack);
        const realtimeStart = startRealtimeLeg({
          micTrack: sharedTrack,
          audioEl: ensureAudioEl(realtimeAudioElRef),
          signal: controller.signal,
          mode,
          onActivity: (activity) => {
            currentRealtimeActivity = activity;
            setRealtimeActivity(activity);
            setRealtimeVisualizerTrack(
              activity === "buddy_talking" && realtimeRemoteTrack
                ? realtimeRemoteTrack
                : sharedTrack,
            );
          },
          onRemoteAudioTrack: (track) => {
            realtimeRemoteTrack = track;
            if (track && currentRealtimeActivity === "buddy_talking") {
              setRealtimeVisualizerTrack(track);
            }
          },
        });
        const realtime = await Promise.race([
          realtimeStart,
          new Promise<never>((_, reject) => {
            realtimeTimeout = setTimeout(() => {
              reject(new Error(`realtime startup timed out (${REALTIME_STARTUP_TIMEOUT_MS}ms)`));
            }, REALTIME_STARTUP_TIMEOUT_MS);
          }),
        ]);
        if (realtimeTimeout) clearTimeout(realtimeTimeout);
        // Realtime is live and about to greet. LiveKit has been warming in bridge
        // mode (no mic yet) since the beginning of this function.
        await liveKitPrepare;
        const room = roomRef.current;
        if (!room) throw new Error("bridge: room missing after prepareSession");
        bridgeRef.current = new BridgeCoordinator({
          room,
          realtime,
          sharedTrack,
          liveKitAudioEl: ensureAudioEl(liveKitAudioElRef),
          onFatal: (reason) => {
            logError("useVoiceBar: bridge fatal", reason);
            void fallbackToColdPath(reason);
          },
          onActive: () => {
            setRealtimeActivity(null);
            setRealtimeVisualizerTrack(null);
            markAssistantResponded();
            logInfo("useVoiceBar: bridge active", "LiveKit owns the conversation");
          },
        });
        // The agent's track may have arrived and been stashed before the coordinator
        // existed (see the TrackSubscribed handler above) - route it now so it stays
        // muted until handover_applied instead of never being attached at all.
        if (pendingAgentTrackRef.current) {
          bridgeRef.current.attachAgentAudio(pendingAgentTrackRef.current);
          pendingAgentTrackRef.current = null;
        }
        for (const control of pendingBridgeControlsRef.current) {
          bridgeRef.current.handleDataMessage(control);
        }
        pendingBridgeControlsRef.current = [];
        if (Array.from(room.remoteParticipants.values()).some((participant) => participant.isAgent)) {
          bridgeRef.current.onAgentReady();
        }
        bridgeOutcomeRef.current = "bridged";
      } catch (err) {
        await fallbackToColdPath(err);
      }
    },
    [activateSession, endSession, markAssistantResponded, prepareSession, startSession],
  );

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
      void startSession(sessionModeRef.current);
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
      teardownBridge();
      roomRef.current?.disconnect().catch((err) => logError("useVoiceBar: unmount disconnect", err));
      setVoiceActive(false);
    };
  }, [clearWatchdogs, teardownBridge]);

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
    realtimeActivity,
    realtimeVisualizerTrack,
    startSession,
    startBridgedSession,
    prepareSession,
    activateSession,
    noteTapTimestamp,
    endSession,
    toggleSession,
    room,
    sessionMode: sessionModeRef.current,
  };
}

export type VoiceBarState = ReturnType<typeof useVoiceBar>;
