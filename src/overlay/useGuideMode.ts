import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  RoomEvent,
  type Participant,
  type RemoteParticipant,
  type Room,
  type TranscriptionSegment,
} from "livekit-client";
import { validateAgentDataMessage } from "../lib/agentData";
import { publishGuideMode } from "../lib/clientControl";
import { trackEvent } from "../lib/analytics";
import { reportGuideUsage, type GuideUsageOutcome } from "../lib/guideUsage";
import { logError } from "../lib/log";
import {
  parseGuideEnvelope,
  type GuideEnvelope,
  type ScreenFrameGeometry,
} from "../lib/screenFrame";
import type { VoiceSessionMode } from "../lib/voice";
import type { VoiceSessionStatus } from "./useVoiceBar";

const CAPTURE_INTERVAL_MS = 2_000;
const RESPONSE_TIMEOUT_MS = 15_000;
const RETAINED_FRAME_GEOMETRY_COUNT = 4;

export interface GuidePoint {
  frameId: string;
  x: number;
  y: number;
  label: string;
}

export interface GuideStep {
  frameId: string;
  frameSeq: number;
  stepIndex: number;
  instruction: string;
  done: boolean;
  point: GuidePoint | null;
}

interface GuideArmedPayload {
  armed: boolean;
  epoch: number;
  sessionId: string | null;
}

interface AwaitingFrame {
  envelope: Extract<GuideEnvelope, { verdict: "send" | "pending" }>;
  streamClosed: boolean;
  committed: boolean;
  responseRetries: number;
  sentAtMs: number;
}

interface UseGuideModeOptions {
  room: Room | null;
  status: VoiceSessionStatus;
  signedIn: boolean;
  startSession: (mode?: VoiceSessionMode) => Promise<void>;
  onPoint: (geometry: ScreenFrameGeometry, point: GuidePoint) => Promise<void>;
}

function isLive(status: VoiceSessionStatus) {
  return status === "ready" || status === "listening" || status === "processing" || status === "speaking";
}

function isTerminal(status: VoiceSessionStatus) {
  return status === "disconnected" || status === "ended" || status === "error";
}

function guideStep(payload: Record<string, unknown>): GuideStep {
  const point = payload.point as Record<string, unknown> | undefined;
  return {
    frameId: payload.frame_id as string,
    frameSeq: payload.frame_seq as number,
    stepIndex: payload.step_index as number,
    instruction: payload.instruction as string,
    done: payload.done === true,
    point: point
      ? {
          frameId: point.frame_id as string,
          x: point.x as number,
          y: point.y as number,
          label: typeof point.label === "string" ? point.label : "",
        }
      : null,
  };
}

export function useGuideMode({ room, status, signedIn, startSession, onPoint }: UseGuideModeOptions) {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef<GuideArmedPayload>({ armed: false, epoch: 0, sessionId: null });
  const roomRef = useRef(room);
  const statusRef = useRef(status);
  const startSessionRef = useRef(startSession);
  const awaitingRef = useRef<AwaitingFrame | null>(null);
  const invokeInFlightRef = useRef(false);
  const schedulerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const responseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleGenerationRef = useRef(0);
  const modeGenerationRef = useRef(0);
  const completedRef = useRef(false);
  const processCaptureRef = useRef<(force?: boolean, isRetry?: boolean) => Promise<void>>(
    async () => {},
  );
  const capturedThisTurnRef = useRef(false);
  const sentGeometryRef = useRef<Map<string, ScreenFrameGeometry>>(new Map());
  // Per-armed-window usage metrics, reported once on disarm to PostHog + the
  // backend rollup (see lib/guideUsage.ts). Duration uses a monotonic clock so a
  // wall-clock jump mid-session can never produce a negative duration.
  const usageStartMonoRef = useRef(0);
  const usageStartedAtRef = useRef("");
  const framesSentRef = useRef(0);
  const stepsReceivedRef = useRef(0);
  const agentTimeoutsRef = useRef(0);
  // Set by the sign-out / session-end effect before it disarms, so applyArmed can
  // tag the outcome distinctly instead of lumping a forced teardown into
  // "abandoned". Consumed (cleared) the moment applyArmed reads it.
  const disarmReasonRef = useRef<GuideUsageOutcome | null>(null);
  roomRef.current = room;
  statusRef.current = status;
  startSessionRef.current = startSession;

  const clearResponseTimer = useCallback(() => {
    if (responseTimerRef.current) clearTimeout(responseTimerRef.current);
    responseTimerRef.current = null;
  }, []);

  const clearClientState = useCallback(() => {
    scheduleGenerationRef.current += 1;
    if (schedulerTimerRef.current) clearTimeout(schedulerTimerRef.current);
    schedulerTimerRef.current = null;
    clearResponseTimer();
    awaitingRef.current = null;
    invokeInFlightRef.current = false;
    capturedThisTurnRef.current = false;
    sentGeometryRef.current.clear();
  }, [clearResponseTimer]);

  const publishCurrentMode = useCallback(
    async (targetRoom: Room) => {
      const current = armedRef.current;
      const hasAgent = Array.from(targetRoom.remoteParticipants.values()).some(
        (participant) => participant.isAgent,
      );
      if (current.armed && !hasAgent) return;
      await publishGuideMode(targetRoom, {
        active: current.armed,
        guideSessionId: current.sessionId,
        generation: modeGenerationRef.current,
      });
    },
    [],
  );

  const streamFrame = useCallback(
    async (
      targetRoom: Room,
      envelope: Extract<GuideEnvelope, { verdict: "send" | "pending" }>,
    ) => {
      const writer = await targetRoom.localParticipant.streamBytes({
        topic: "screen_frame",
        mimeType: "image/jpeg",
        totalSize: envelope.bytes.length,
        attributes: {
          frame_id: envelope.frameId,
          frame_seq: String(envelope.sequence),
          captured_at_ms: String(Date.now()),
          mode: "guide",
          jpeg_width_px: String(envelope.geometry.jpegWidthPx),
          jpeg_height_px: String(envelope.geometry.jpegHeightPx),
          monitor_left_px: String(envelope.geometry.monitorLeftPx),
          monitor_top_px: String(envelope.geometry.monitorTopPx),
          monitor_width_px: String(envelope.geometry.monitorWidthPx),
          monitor_height_px: String(envelope.geometry.monitorHeightPx),
          scale_factor: String(envelope.geometry.scaleFactor),
        },
      });
      await writer.write(envelope.bytes);
      await writer.close();
      sentGeometryRef.current.set(envelope.frameId, envelope.geometry);
      while (sentGeometryRef.current.size > RETAINED_FRAME_GEOMETRY_COUNT) {
        const oldest = sentGeometryRef.current.keys().next().value;
        if (oldest === undefined) break;
        sentGeometryRef.current.delete(oldest);
      }
    },
    [],
  );

  const armResponseTimeout = useCallback(
    (frameId: string) => {
      clearResponseTimer();
      responseTimerRef.current = setTimeout(() => {
        const awaiting = awaitingRef.current;
        const targetRoom = roomRef.current;
        if (!awaiting || awaiting.envelope.frameId !== frameId || !targetRoom) return;
        if (awaiting.responseRetries >= 1) {
          agentTimeoutsRef.current += 1;
          trackEvent("guide_agent_timeouts");
          const current = armedRef.current;
          void invoke<boolean>("ack_guide_response", {
            frameId,
            epoch: current.epoch,
          })
            .then((dirty) => {
              if (
                awaitingRef.current !== awaiting ||
                !armedRef.current.armed ||
                armedRef.current.epoch !== current.epoch
              ) {
                return;
              }
              awaitingRef.current = null;
              if (dirty) void processCaptureRef.current();
            })
            .catch((error) => logError("useGuideMode: release timed-out frame", error));
          return;
        }
        awaiting.responseRetries += 1;
        void streamFrame(targetRoom, awaiting.envelope)
          .catch((error) => logError("useGuideMode: response retry", error))
          .finally(() => armResponseTimeout(frameId));
      }, RESPONSE_TIMEOUT_MS);
    },
    [clearResponseTimer, streamFrame],
  );

  const processCapture = useCallback(
    async (force = false, isRetry = false) => {
      const current = armedRef.current;
      const targetRoom = roomRef.current;
      if (!current.armed || !targetRoom || !isLive(statusRef.current) || invokeInFlightRef.current) return;
      invokeInFlightRef.current = true;
      try {
        const envelope = parseGuideEnvelope(
          await invoke("capture_guide_frame", { epoch: current.epoch, force }),
        );
        if (envelope.guideEpoch !== current.epoch || envelope.sessionId !== current.sessionId) return;

        if (envelope.verdict === "skip") return;
        // The first capture after arming (or after a pointing-triggered reseed) only
        // seeds the change-filter baseline and streams nothing, even when forced. A
        // forced capture that lands on that reseed tick retries exactly once (isRetry
        // caps the depth) - now that the baseline exists, the follow-up classifies and
        // the force override sends it.
        if (force && !isRetry && envelope.verdict === "hold") {
          void Promise.resolve().then(() => void processCaptureRef.current(true, true));
          return;
        }
        if (envelope.verdict !== "send" && envelope.verdict !== "pending") return;

        const existing = awaitingRef.current;
        if (existing?.envelope.frameId === envelope.frameId && existing.committed) return;
        const awaiting = existing?.envelope.frameId === envelope.frameId
          ? existing
          : {
              envelope,
              streamClosed: false,
              committed: false,
              responseRetries: 0,
              sentAtMs: Date.now(),
            };
        if (awaitingRef.current !== awaiting) {
          awaitingRef.current = awaiting;
        }
        if (!awaiting.streamClosed) {
          await streamFrame(targetRoom, envelope);
          awaiting.streamClosed = true;
        }
        if (!awaiting.committed) {
          await invoke("commit_guide_frame", {
            frameId: envelope.frameId,
            epoch: current.epoch,
          });
          awaiting.committed = true;
          framesSentRef.current += 1;
          trackEvent("guide_auto_frames_sent");
        }
        armResponseTimeout(envelope.frameId);
      } catch (error) {
        logError("useGuideMode: capture tick", error);
      } finally {
        invokeInFlightRef.current = false;
      }
    },
    [armResponseTimeout, streamFrame],
  );
  processCaptureRef.current = processCapture;

  const startScheduler = useCallback(() => {
    scheduleGenerationRef.current += 1;
    const generation = scheduleGenerationRef.current;
    let nextDue = Date.now();
    const tick = async () => {
      if (generation !== scheduleGenerationRef.current || !armedRef.current.armed) return;
      await processCapture();
      const now = Date.now();
      nextDue += CAPTURE_INTERVAL_MS;
      if (nextDue <= now) {
        nextDue += Math.ceil((now - nextDue + 1) / CAPTURE_INTERVAL_MS) * CAPTURE_INTERVAL_MS;
      }
      schedulerTimerRef.current = setTimeout(tick, Math.max(0, nextDue - now));
    };
    void tick();
  }, [processCapture]);

  const applyArmed = useCallback(
    (payload: GuideArmedPayload) => {
      const previous = armedRef.current;
      const wasArmed = previous.armed;
      armedRef.current = payload;
      setArmed(payload.armed);
      modeGenerationRef.current += 1;
      if (!payload.armed) {
        // A forced teardown (sign-out / session end) tags itself via
        // disarmReasonRef; a plain toggle before completion is "abandoned".
        const forcedReason = disarmReasonRef.current;
        disarmReasonRef.current = null;
        if (wasArmed) {
          const outcome: GuideUsageOutcome = completedRef.current
            ? "completed"
            : forcedReason ?? "abandoned";
          if (completedRef.current) completedRef.current = false;
          else if (!forcedReason) trackEvent("guide_abandoned");
          if (previous.sessionId) {
            reportGuideUsage({
              guideSessionId: previous.sessionId,
              startedAt: usageStartedAtRef.current,
              endedAt: new Date().toISOString(),
              durationMs: Math.max(0, Math.round(performance.now() - usageStartMonoRef.current)),
              outcome,
              framesSent: framesSentRef.current,
              stepsReceived: stepsReceivedRef.current,
              agentTimeouts: agentTimeoutsRef.current,
            });
          }
        }
        clearClientState();
        const targetRoom = roomRef.current;
        if (targetRoom) {
          void publishCurrentMode(targetRoom).catch((error) =>
            logError("useGuideMode: publish disarm", error),
          );
        }
        return;
      }
      if (!wasArmed) {
        completedRef.current = false;
        usageStartMonoRef.current = performance.now();
        usageStartedAtRef.current = new Date().toISOString();
        framesSentRef.current = 0;
        stepsReceivedRef.current = 0;
        agentTimeoutsRef.current = 0;
        if (isTerminal(statusRef.current)) void startSessionRef.current("guide");
      }
      const targetRoom = roomRef.current;
      if (targetRoom) {
        void publishCurrentMode(targetRoom).catch((error) =>
          logError("useGuideMode: publish arm", error),
        );
      }
    },
    [clearClientState, publishCurrentMode],
  );

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<GuideArmedPayload>("guide-armed", (event) => applyArmed(event.payload))
      .then((fn) => {
        unlisten = fn;
      })
      .catch((error) => logError("useGuideMode: listen guide-armed", error));
    invoke<GuideArmedPayload>("guide_armed_state")
      .then(applyArmed)
      .catch((error) => logError("useGuideMode: guide_armed_state", error));
    return () => unlisten?.();
  }, [applyArmed]);

  useEffect(() => {
    if (!room) return;
    const onParticipantConnected = (participant: RemoteParticipant) => {
      if (!participant.isAgent) return;
      void publishCurrentMode(room).catch((error) =>
        logError("useGuideMode: publish after agent join", error),
      );
    };
    const onReconnected = () => {
      void publishCurrentMode(room).catch((error) =>
        logError("useGuideMode: publish after reconnect", error),
      );
    };
    const onDataReceived = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) => {
      const verdict = validateAgentDataMessage(payload, participant, topic);
      if (verdict.kind !== "valid") return;
      if (verdict.type === "element.point") {
        const frameId = verdict.payload.frame_id;
        const x = verdict.payload.x;
        const y = verdict.payload.y;
        if (typeof frameId !== "string" || typeof x !== "number" || typeof y !== "number") return;
        const geometry = sentGeometryRef.current.get(frameId);
        if (!geometry) return;
        const label = typeof verdict.payload.label === "string" ? verdict.payload.label.trim() : "";
        void onPoint(geometry, { frameId, x, y, label }).catch((error) =>
          logError("useGuideMode: point", error),
        );
        return;
      }
      if (verdict.type !== "guide.step") return;
      const nextStep = guideStep(verdict.payload);
      const awaiting = awaitingRef.current;
      if (!awaiting || nextStep.frameId !== awaiting.envelope.frameId) return;
      clearResponseTimer();
      stepsReceivedRef.current += 1;
      trackEvent("guide_steps_received", {
        responseLatencyMs: Math.max(0, Date.now() - awaiting.sentAtMs),
      });
      void (async () => {
        if (nextStep.point) await onPoint(awaiting.envelope.geometry, nextStep.point);
        const dirty = await invoke<boolean>("ack_guide_response", {
          frameId: nextStep.frameId,
          epoch: armedRef.current.epoch,
        });
        awaitingRef.current = null;
        if (nextStep.done) {
          completedRef.current = true;
          trackEvent("guide_completed");
          await invoke("disarm_guide");
        } else if (dirty) {
          await processCapture();
        }
      })().catch((error) => logError("useGuideMode: accept guide.step", error));
    };

    // Turn-start forces a fresh frame so a spoken question never reaches a blind
    // agent, the same signal the per-turn capture hook uses. The change-filter
    // stream sends nothing on a static screen, so without this the agent has no
    // frame for whatever the user just said. Rust's FORCE_COOLDOWN throttles it.
    const onTranscriptionReceived = (
      segments: TranscriptionSegment[],
      participant?: Participant,
    ) => {
      if (!participant?.isLocal) return;
      for (const segment of segments) {
        if (!segment.final) {
          if (
            !capturedThisTurnRef.current &&
            armedRef.current.armed &&
            isLive(statusRef.current)
          ) {
            capturedThisTurnRef.current = true;
            void processCapture(true);
          }
        } else {
          capturedThisTurnRef.current = false;
        }
      }
    };

    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.DataReceived, onDataReceived);
    room.on(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
    if (armedRef.current.armed) {
      void publishCurrentMode(room).catch((error) => logError("useGuideMode: publish room", error));
    }
    return () => {
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.DataReceived, onDataReceived);
      room.off(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
    };
  }, [clearResponseTimer, onPoint, processCapture, publishCurrentMode, room]);

  useEffect(() => {
    if (!armed || !isLive(status)) return;
    startScheduler();
    // Deliver one frame the instant Guide arms on a live session so the agent
    // has the current screen before the user's next utterance, instead of
    // waiting for the change-filter to notice motion. The reseed-retry inside
    // processCapture is what makes this land rather than only seed the baseline.
    void processCaptureRef.current(true);
    return () => {
      scheduleGenerationRef.current += 1;
      if (schedulerTimerRef.current) clearTimeout(schedulerTimerRef.current);
    };
  }, [armed, startScheduler, status]);

  useEffect(() => {
    if (signedIn && status !== "ended" && status !== "error") return;
    if (armedRef.current.armed) {
      disarmReasonRef.current = signedIn ? "session_ended" : "signed_out";
      void invoke("disarm_guide");
    }
    clearClientState();
  }, [clearClientState, signedIn, status]);

  useEffect(() => clearClientState, [clearClientState]);

  const stop = useCallback(() => {
    void invoke("disarm_guide").catch((error) => logError("useGuideMode: disarm", error));
  }, []);

  return {
    armed,
    stop,
  };
}
