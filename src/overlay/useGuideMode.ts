import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { validateAgentDataMessage } from "../lib/agentData";
import { publishGuideMode } from "../lib/clientControl";
import { trackEvent } from "../lib/analytics";
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
const BLANK_WARNING_AFTER = 3;

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
  forced: boolean;
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
  const [step, setStep] = useState<GuideStep | null>(null);
  const [awaitingFrameId, setAwaitingFrameId] = useState<string | null>(null);
  const [stillChecking, setStillChecking] = useState(false);
  const [blankWarning, setBlankWarning] = useState(false);
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
  const blankCountRef = useRef(0);
  const completedRef = useRef(false);
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
    setAwaitingFrameId(null);
    invokeInFlightRef.current = false;
    blankCountRef.current = 0;
    setStep(null);
    setStillChecking(false);
    setBlankWarning(false);
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
      forced: boolean,
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
          forced: forced ? "manual" : "",
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
          setStillChecking(true);
          trackEvent("guide_agent_timeouts");
          return;
        }
        awaiting.responseRetries += 1;
        void streamFrame(targetRoom, awaiting.envelope, false)
          .catch((error) => logError("useGuideMode: response retry", error))
          .finally(() => armResponseTimeout(frameId));
      }, RESPONSE_TIMEOUT_MS);
    },
    [clearResponseTimer, streamFrame],
  );

  const processCapture = useCallback(
    async (force: boolean) => {
      const current = armedRef.current;
      const targetRoom = roomRef.current;
      if (!current.armed || !targetRoom || !isLive(statusRef.current) || invokeInFlightRef.current) return;
      invokeInFlightRef.current = true;
      try {
        const envelope = parseGuideEnvelope(
          await invoke("capture_guide_frame", { epoch: current.epoch, force }),
        );
        if (envelope.guideEpoch !== current.epoch || envelope.sessionId !== current.sessionId) return;

        if (envelope.verdict === "skip") {
          blankCountRef.current += 1;
          if (blankCountRef.current >= BLANK_WARNING_AFTER) setBlankWarning(true);
          return;
        }
        blankCountRef.current = 0;
        setBlankWarning(false);
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
              forced: force,
              sentAtMs: Date.now(),
            };
        if (awaitingRef.current !== awaiting) {
          awaitingRef.current = awaiting;
          setAwaitingFrameId(envelope.frameId);
        }
        if (!awaiting.streamClosed) {
          await streamFrame(targetRoom, envelope, force);
          awaiting.streamClosed = true;
        }
        if (!awaiting.committed) {
          await invoke("commit_guide_frame", {
            frameId: envelope.frameId,
            epoch: current.epoch,
          });
          awaiting.committed = true;
          if (!awaiting.forced) trackEvent("guide_auto_frames_sent");
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

  const startScheduler = useCallback(() => {
    scheduleGenerationRef.current += 1;
    const generation = scheduleGenerationRef.current;
    let nextDue = Date.now();
    const tick = async () => {
      if (generation !== scheduleGenerationRef.current || !armedRef.current.armed) return;
      await processCapture(false);
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
      const wasArmed = armedRef.current.armed;
      armedRef.current = payload;
      setArmed(payload.armed);
      modeGenerationRef.current += 1;
      if (!payload.armed) {
        if (wasArmed) {
          if (completedRef.current) completedRef.current = false;
          else trackEvent("guide_abandoned");
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
      if (verdict.kind !== "valid" || verdict.type !== "guide.step") return;
      const nextStep = guideStep(verdict.payload);
      const awaiting = awaitingRef.current;
      if (!awaiting || nextStep.frameId !== awaiting.envelope.frameId) return;
      clearResponseTimer();
      setStillChecking(false);
      setStep(nextStep);
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
        setAwaitingFrameId(null);
        if (nextStep.done) {
          completedRef.current = true;
          trackEvent("guide_completed");
          await invoke("disarm_guide");
        } else if (dirty) {
          await processCapture(false);
        }
      })().catch((error) => logError("useGuideMode: accept guide.step", error));
    };

    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.Reconnected, onReconnected);
    room.on(RoomEvent.DataReceived, onDataReceived);
    if (armedRef.current.armed) {
      void publishCurrentMode(room).catch((error) => logError("useGuideMode: publish room", error));
    }
    return () => {
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [clearResponseTimer, onPoint, processCapture, publishCurrentMode, room]);

  useEffect(() => {
    if (!armed || !isLive(status)) return;
    startScheduler();
    return () => {
      scheduleGenerationRef.current += 1;
      if (schedulerTimerRef.current) clearTimeout(schedulerTimerRef.current);
    };
  }, [armed, startScheduler, status]);

  useEffect(() => {
    if (signedIn && status !== "ended" && status !== "error") return;
    if (armedRef.current.armed) void invoke("disarm_guide");
    clearClientState();
  }, [clearClientState, signedIn, status]);

  useEffect(() => clearClientState, [clearClientState]);

  const checkNow = useCallback(() => {
    trackEvent("guide_manual_button_checks");
    const awaiting = awaitingRef.current;
    const targetRoom = roomRef.current;
    if (awaiting && targetRoom) {
      setStillChecking(false);
      void streamFrame(targetRoom, awaiting.envelope, true)
        .then(() => armResponseTimeout(awaiting.envelope.frameId))
        .catch((error) => logError("useGuideMode: manual response retry", error));
      return;
    }
    void processCapture(true);
  }, [armResponseTimeout, processCapture, streamFrame]);

  const stop = useCallback(() => {
    void invoke("disarm_guide").catch((error) => logError("useGuideMode: disarm", error));
  }, []);

  return {
    armed,
    step,
    awaitingFrameId,
    stillChecking,
    blankWarning,
    checkNow,
    stop,
  };
}
