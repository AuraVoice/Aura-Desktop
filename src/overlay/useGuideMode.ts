import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { GUIDE_ARMED, type GuideArmedPayload } from "../lib/ipcEvents";
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
import { logError, logInfo } from "../lib/log";
import {
  parseGuideEnvelope,
  type GuideEnvelope,
  type ScreenFrameGeometry,
} from "../lib/screenFrame";
import { newTurnContextId } from "../lib/screenContext";
import type { VoiceSessionStatus } from "./useVoiceBar";

const FINGERPRINT_INTERVAL_MS = 750;
const HEARTBEAT_INTERVAL_MS = 20_000;
const RESPONSE_TIMEOUT_MS = 15_000;
const MODE_ACK_TIMEOUT_MS = 3_000;
const VERIFICATION_TIMEOUT_MS = 30_000;
const RETAINED_FRAME_GEOMETRY_COUNT = 6;
const GUIDE_TASK_STORAGE_KEY = "aura.guide.currentTask.v2";

type CaptureReason =
  | "user_turn"
  | "stable_change"
  | "verification_timeout"
  | "resume"
  | "explicit_look"
  | "app_window_change"
  | "geometry_change";
type GuideFailureStage =
  | "capture"
  | "planning"
  | "execution"
  | "verification"
  | "speech";

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

// Defensive view of the wire shape; the canonical mirror of Rust's
// GuideArmedPayload lives in lib/ipcEvents.ts. Rust serializes with
// rename_all = "camelCase", so snake_case field names never reach the wire.
interface GuideArmedWirePayload {
  armed?: unknown;
  epoch?: unknown;
  sessionId?: unknown;
}

interface AwaitingFrame {
  envelope: Extract<GuideEnvelope, { verdict: "send" | "pending" | "sendForced" }>;
  reason: CaptureReason;
  observation: GuideObservationState;
  streamClosed: boolean;
  committed: boolean;
  responseRetries: number;
  sentAtMs: number;
  traceId: string;
  eventId: string;
  parentEventId: string | null;
}

interface GuideObservationState {
  activeProcess: string;
  activeWindowId: string;
  activeWindowTitle: string;
  geometryRevision: number;
}

interface GuideTaskState {
  taskId: string;
  revision: number;
  status: string;
  currentStepId: string | null;
  currentStepTitle: string;
  resumable: boolean;
  completion: boolean;
}

interface PendingModeAck {
  room: Room;
  generation: number;
  epoch: number;
  sessionId: string;
}

interface UseGuideModeOptions {
  room: Room | null;
  status: VoiceSessionStatus;
  signedIn: boolean;
  onPoint: (geometry: ScreenFrameGeometry, point: GuidePoint) => Promise<void>;
}

function isLive(status: VoiceSessionStatus) {
  return status === "ready" || status === "listening" || status === "processing" || status === "speaking";
}

function hasGuideAgent(room: Room): boolean {
  return Array.from(room.remoteParticipants.values()).some(
    (participant) => participant.isAgent,
  );
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

function guideTaskState(payload: Record<string, unknown>): GuideTaskState | null {
  const taskId = payload.task_id;
  const revision = payload.revision;
  if (
    typeof taskId !== "string" ||
    !/^[0-9a-f]{32}$/.test(taskId) ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision)
  ) {
    return null;
  }
  return {
    taskId,
    revision,
    status: typeof payload.status === "string" ? payload.status : "",
    currentStepId:
      typeof payload.current_step_id === "string" ? payload.current_step_id : null,
    currentStepTitle:
      typeof payload.current_step_title === "string" ? payload.current_step_title : "",
    resumable: payload.resumable === true,
    completion: payload.completion === true,
  };
}

function storedTaskId(): string | null {
  try {
    const value = localStorage.getItem(GUIDE_TASK_STORAGE_KEY);
    return value && /^[0-9a-f]{32}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function traceId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function logGuideEvent(
  stage: GuideFailureStage,
  outcome: "started" | "succeeded" | "retrying" | "rejected" | "failed",
  reason: string,
  fields: Record<string, unknown> = {},
): void {
  logInfo(
    "GuideTrace",
    JSON.stringify({
      stage,
      outcome,
      reason,
      ...fields,
    }),
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  return Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeGuideArmedPayload(payload: GuideArmedWirePayload): GuideArmedPayload {
  const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  const epoch = typeof payload.epoch === "number" ? payload.epoch : Number(payload.epoch ?? 0);
  return {
    armed: payload.armed === true,
    epoch: Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0,
    sessionId,
  };
}

export function useGuideMode({ room, status, signedIn, onPoint }: UseGuideModeOptions) {
  const [armed, setArmed] = useState(false);
  const [active, setActive] = useState(false);
  const armedRef = useRef<GuideArmedPayload>({ armed: false, epoch: 0, sessionId: null });
  const roomRef = useRef(room);
  const statusRef = useRef(status);
  const awaitingRef = useRef<AwaitingFrame | null>(null);
  const invokeInFlightRef = useRef(false);
  const pendingCaptureRef = useRef<{
    reason: CaptureReason;
    force: boolean;
  } | null>(null);
  const schedulerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const responseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modeAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verificationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleGenerationRef = useRef(0);
  const modeGenerationRef = useRef(0);
  const completedRef = useRef(false);
  const processCaptureRef = useRef<
    (reason?: CaptureReason, force?: boolean, isRetry?: boolean) => Promise<void>
  >(async () => {});
  const capturedThisTurnRef = useRef(false);
  const turnContextIdRef = useRef("");
  const sentGeometryRef = useRef<Map<string, ScreenFrameGeometry>>(new Map());
  const taskStateRef = useRef<GuideTaskState | null>(null);
  const resumeTaskIdRef = useRef<string | null>(storedTaskId());
  const observationStateRef = useRef<GuideObservationState | null>(null);
  const predecessorHashRef = useRef("");
  const readyAgentRoomRef = useRef<Room | null>(null);
  const pendingModeAckRef = useRef<PendingModeAck | null>(null);
  const activeModeGenerationRef = useRef<number | null>(null);
  const firstFrameReadyGenerationRef = useRef<number | null>(null);
  const turnTraceRef = useRef<{
    traceId: string;
    eventId: string;
    parentEventId: string | null;
  } | null>(null);
  const lastEventIdRef = useRef<string | null>(null);
  const agentPrimeGenerationRef = useRef(0);
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

  const logGuideFailure = useCallback(
    (
      stage: GuideFailureStage,
      reason: string,
      error: unknown,
      trace = turnTraceRef.current,
    ) => {
      logError(
        "GuideTrace",
        new Error(JSON.stringify({
          trace_id: trace?.traceId ?? null,
          event_id: trace?.eventId ?? null,
          parent_event_id: trace?.parentEventId ?? null,
          task_id: taskStateRef.current?.taskId ?? resumeTaskIdRef.current,
          task_revision: taskStateRef.current?.revision ?? null,
          stage,
          outcome: "failed",
          reason,
          error_type: error instanceof Error ? error.name : typeof error,
          error: error instanceof Error ? error.message : String(error),
        })),
      );
    },
    [],
  );

  const clearResponseTimer = useCallback(() => {
    if (responseTimerRef.current) clearTimeout(responseTimerRef.current);
    responseTimerRef.current = null;
  }, []);

  const clearModeAckTimer = useCallback(() => {
    if (modeAckTimerRef.current) clearTimeout(modeAckTimerRef.current);
    modeAckTimerRef.current = null;
  }, []);

  const clearVerificationTimer = useCallback(() => {
    if (verificationTimerRef.current) clearTimeout(verificationTimerRef.current);
    verificationTimerRef.current = null;
  }, []);

  const clearClientState = useCallback(() => {
    scheduleGenerationRef.current += 1;
    if (schedulerTimerRef.current) clearTimeout(schedulerTimerRef.current);
    schedulerTimerRef.current = null;
    if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = null;
    clearResponseTimer();
    clearModeAckTimer();
    clearVerificationTimer();
    awaitingRef.current = null;
    invokeInFlightRef.current = false;
    pendingCaptureRef.current = null;
    capturedThisTurnRef.current = false;
    sentGeometryRef.current.clear();
    predecessorHashRef.current = "";
    readyAgentRoomRef.current = null;
    pendingModeAckRef.current = null;
    activeModeGenerationRef.current = null;
    firstFrameReadyGenerationRef.current = null;
    setActive(false);
    agentPrimeGenerationRef.current += 1;
  }, [clearModeAckTimer, clearResponseTimer, clearVerificationTimer]);

  const publishCurrentMode = useCallback(
    async (targetRoom: Room, generation: number) => {
      const current = armedRef.current;
      if (current.armed && !hasGuideAgent(targetRoom)) return;
      await publishGuideMode(targetRoom, {
        active: current.armed,
        guideSessionId: current.sessionId,
        generation,
        protocolVersion: 2,
        resumeTaskId: current.armed ? resumeTaskIdRef.current : null,
      });
    },
    [],
  );

  const streamFrame = useCallback(
    async (
      targetRoom: Room,
      envelope: Extract<GuideEnvelope, { verdict: "send" | "pending" | "sendForced" }>,
      reason: CaptureReason,
      observation: GuideObservationState,
      trace: Pick<AwaitingFrame, "traceId" | "eventId" | "parentEventId">,
    ) => {
      const frameHash = await sha256(envelope.bytes);
      const predecessorHash = predecessorHashRef.current;
      const writer = await targetRoom.localParticipant.streamBytes({
        topic: "screen_frame",
        mimeType: "image/jpeg",
        totalSize: envelope.bytes.length,
        attributes: {
          frame_id: envelope.frameId,
          frame_seq: String(envelope.sequence),
          // Correlation only. Guide always reasons about pixels, so it never
          // takes the structured-context path; this just lets one Guide frame
          // be lined up with the turn it belongs to in the stage metrics.
          turn_context_id: turnContextIdRef.current,
          captured_at_ms: String(Date.now()),
          captured_monotonic_ms: String(Math.round(performance.now())),
          capture_reason: reason,
          mode: "guide",
          guide_session_id: armedRef.current.sessionId ?? "",
          task_id: taskStateRef.current?.taskId ?? resumeTaskIdRef.current ?? "",
          // "1" only for a tile-classified change ("send"); a forced static-screen
          // frame ("sendForced") or a re-streamed pending frame is "0". The backend
          // refreshes its latest frame on both but nudges only on "1".
          change: envelope.verdict === "send" ? "1" : "0",
          active_process: observation.activeProcess,
          active_window_id: observation.activeWindowId,
          active_window_title: observation.activeWindowTitle,
          geometry_revision: String(observation.geometryRevision),
          frame_hash: frameHash,
          predecessor_hash: predecessorHash,
          trace_id: trace.traceId,
          event_id: trace.eventId,
          parent_event_id: trace.parentEventId ?? "",
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
      predecessorHashRef.current = frameHash;
      sentGeometryRef.current.set(envelope.frameId, envelope.geometry);
      while (sentGeometryRef.current.size > RETAINED_FRAME_GEOMETRY_COUNT) {
        const oldest = sentGeometryRef.current.keys().next().value;
        if (oldest === undefined) break;
        sentGeometryRef.current.delete(oldest);
      }
      logGuideEvent("capture", "succeeded", "frame_stream_closed", {
        trace_id: trace.traceId,
        event_id: trace.eventId,
        parent_event_id: trace.parentEventId,
        frame_id: envelope.frameId,
        capture_reason: reason,
        frame_bytes: envelope.bytes.length,
        geometry_revision: observation.geometryRevision,
      });
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
          logGuideEvent("execution", "failed", "frame_ack_timeout_exhausted", {
            trace_id: awaiting.traceId,
            event_id: awaiting.eventId,
            frame_id: awaiting.envelope.frameId,
            response_retries: awaiting.responseRetries,
            guide_active: activeModeGenerationRef.current !== null,
          });
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
            .catch((error) =>
              logGuideFailure("execution", "release_timed_out_frame_failed", error, awaiting)
            );
          return;
        }
        awaiting.responseRetries += 1;
        logGuideEvent("execution", "retrying", "frame_ack_timeout", {
          trace_id: awaiting.traceId,
          event_id: awaiting.eventId,
          frame_id: awaiting.envelope.frameId,
          response_retries: awaiting.responseRetries,
        });
        void streamFrame(
          targetRoom,
          awaiting.envelope,
          awaiting.reason,
          awaiting.observation,
          awaiting,
        )
          .catch((error) =>
            logGuideFailure("capture", "frame_response_retry_failed", error, awaiting)
          )
          .finally(() => armResponseTimeout(frameId));
      }, RESPONSE_TIMEOUT_MS);
    },
    [clearResponseTimer, logGuideFailure, streamFrame],
  );

  const processCapture = useCallback(
    async (
      reason: CaptureReason = "stable_change",
      force = false,
      isRetry = false,
    ) => {
      const current = armedRef.current;
      const targetRoom = roomRef.current;
      if (
        !current.armed ||
        !targetRoom ||
        readyAgentRoomRef.current !== targetRoom ||
        !hasGuideAgent(targetRoom) ||
        !isLive(statusRef.current)
      ) {
        return;
      }
      if (invokeInFlightRef.current) {
        pendingCaptureRef.current = {
          reason,
          force: force || pendingCaptureRef.current?.force === true,
        };
        return;
      }
      invokeInFlightRef.current = true;
      try {
        const beforeObservation = await invoke<GuideObservationState>(
          "guide_observation_state",
          { epoch: current.epoch },
        );
        const previousObservation = observationStateRef.current;
        let effectiveReason = reason;
        let effectiveForce = force;
        if (
          previousObservation &&
          (previousObservation.activeProcess !== beforeObservation.activeProcess ||
            previousObservation.activeWindowId !== beforeObservation.activeWindowId)
        ) {
          effectiveReason = "app_window_change";
          effectiveForce = true;
        }
        if (
          previousObservation &&
          previousObservation.geometryRevision !== beforeObservation.geometryRevision
        ) {
          effectiveReason = "geometry_change";
          effectiveForce = true;
        }
        observationStateRef.current = beforeObservation;
        const envelope = parseGuideEnvelope(
          await invoke("capture_guide_frame", {
            epoch: current.epoch,
            force: effectiveForce,
          }),
        );
        if (envelope.guideEpoch !== current.epoch || envelope.sessionId !== current.sessionId) return;

        const observation = await invoke<GuideObservationState>(
          "guide_observation_state",
          { epoch: current.epoch },
        );
        const geometryChangedDuringCapture =
          observation.geometryRevision !== beforeObservation.geometryRevision;
        observationStateRef.current = observation;

        if (envelope.verdict === "skip") return;
        // The first capture after arming (or after a pointing-triggered reseed) only
        // seeds the change-filter baseline and streams nothing, even when forced. A
        // forced capture that lands on that reseed tick retries exactly once (isRetry
        // caps the depth) - now that the baseline exists, the follow-up classifies and
        // the force override sends it.
        if (
          (effectiveForce || geometryChangedDuringCapture) &&
          !isRetry &&
          envelope.verdict === "hold"
        ) {
          const retryReason: CaptureReason = geometryChangedDuringCapture
            ? "geometry_change"
            : effectiveReason;
          void Promise.resolve().then(() =>
            void processCaptureRef.current(retryReason, true, true),
          );
          return;
        }
        if (
          envelope.verdict !== "send" &&
          envelope.verdict !== "pending" &&
          envelope.verdict !== "sendForced"
        )
          return;

        const existing = awaitingRef.current;
        if (existing?.envelope.frameId === envelope.frameId && existing.committed) return;
        // If a spoken turn arrived while the one-in-flight frame was still
        // retained, carry that turn's trace onto the next frame that can
        // actually be committed, even if the retry reason is stable_change.
        const pendingTurnTrace = turnTraceRef.current;
        const nextTrace = pendingTurnTrace ?? {
          traceId: traceId(),
          eventId: traceId(),
          parentEventId: lastEventIdRef.current,
        };
        const awaiting = existing?.envelope.frameId === envelope.frameId
          ? existing
          : {
              envelope,
              reason: effectiveReason,
              observation,
              streamClosed: false,
              committed: false,
              responseRetries: 0,
              sentAtMs: Date.now(),
              ...nextTrace,
            };
        if (awaitingRef.current !== awaiting) {
          awaitingRef.current = awaiting;
        }
        if (!awaiting.streamClosed) {
          await streamFrame(
            targetRoom,
            envelope,
            awaiting.reason,
            awaiting.observation,
            awaiting,
          );
          awaiting.streamClosed = true;
        }
        if (!awaiting.committed) {
          await invoke("commit_guide_frame", {
            frameId: envelope.frameId,
            epoch: current.epoch,
          });
          awaiting.committed = true;
          framesSentRef.current += 1;
          lastEventIdRef.current = awaiting.eventId;
          if (turnTraceRef.current?.eventId === awaiting.eventId) {
            turnTraceRef.current = null;
          }
          trackEvent("guide_auto_frames_sent");
          logGuideEvent("execution", "succeeded", "frame_committed", {
            trace_id: awaiting.traceId,
            event_id: awaiting.eventId,
            frame_id: envelope.frameId,
            capture_reason: awaiting.reason,
          });
        }
        armResponseTimeout(envelope.frameId);
      } catch (error) {
        logGuideFailure("capture", "capture_tick_failed", error);
      } finally {
        invokeInFlightRef.current = false;
        const pending = pendingCaptureRef.current;
        pendingCaptureRef.current = null;
        if (pending && armedRef.current.armed) {
          void Promise.resolve().then(() =>
            void processCaptureRef.current(pending.reason, pending.force),
          );
        }
      }
    },
    [armResponseTimeout, logGuideFailure, streamFrame],
  );
  processCaptureRef.current = processCapture;

  const primeGuideAgent = useCallback(
    async (targetRoom: Room) => {
      const current = armedRef.current;
      if (!current.armed || !hasGuideAgent(targetRoom)) {
        if (readyAgentRoomRef.current === targetRoom) readyAgentRoomRef.current = null;
        return;
      }
      const primeGeneration = agentPrimeGenerationRef.current + 1;
      agentPrimeGenerationRef.current = primeGeneration;
      readyAgentRoomRef.current = null;
      activeModeGenerationRef.current = null;
      firstFrameReadyGenerationRef.current = null;
      setActive(false);
      clearModeAckTimer();
      const modeGeneration = modeGenerationRef.current + 1;
      modeGenerationRef.current = modeGeneration;
      const sessionId = current.sessionId;
      if (!sessionId) return;
      pendingModeAckRef.current = {
        room: targetRoom,
        generation: modeGeneration,
        epoch: current.epoch,
        sessionId,
      };
      modeAckTimerRef.current = setTimeout(() => {
        const pending = pendingModeAckRef.current;
        if (
          !pending ||
          pending.room !== targetRoom ||
          pending.generation !== modeGeneration
        ) {
          return;
        }
        modeAckTimerRef.current = null;
        pendingModeAckRef.current = null;
        readyAgentRoomRef.current = null;
        activeModeGenerationRef.current = null;
        firstFrameReadyGenerationRef.current = null;
        setActive(false);
        logGuideEvent("execution", "failed", "mode_ack_timeout", {
          guide_session_id: sessionId,
          generation: modeGeneration,
          guide_epoch: current.epoch,
          fallback: "disarm",
        });
        logInfo(
          "useGuideMode: mode acknowledgment unavailable, disarming Guide Mode",
          `generation=${modeGeneration} epoch=${current.epoch}`,
        );
        void invoke("disarm_guide").catch((error) =>
          logGuideFailure("execution", "disarm_after_mode_ack_timeout_failed", error),
        );
      }, MODE_ACK_TIMEOUT_MS);
      await publishCurrentMode(targetRoom, modeGeneration);
      if (
        agentPrimeGenerationRef.current !== primeGeneration ||
        roomRef.current !== targetRoom ||
        !armedRef.current.armed ||
        armedRef.current.epoch !== current.epoch ||
        armedRef.current.sessionId !== current.sessionId ||
        !hasGuideAgent(targetRoom)
      ) {
        return;
      }
      logInfo(
        "useGuideMode: activation requested",
        `generation=${modeGeneration} epoch=${current.epoch}`,
      );
    },
    [clearModeAckTimer, logGuideFailure, publishCurrentMode],
  );

  const startScheduler = useCallback(() => {
    scheduleGenerationRef.current += 1;
    const generation = scheduleGenerationRef.current;
    let nextDue = Date.now();
    const tick = async () => {
      if (generation !== scheduleGenerationRef.current || !armedRef.current.armed) return;
      // Keep the local fingerprint loop active, but upload JPEG bytes only when
      // Rust reports a settled semantic change or an explicit capture reason forces one.
      await processCapture("stable_change", false);
      const now = Date.now();
      nextDue += FINGERPRINT_INTERVAL_MS;
      if (nextDue <= now) {
        nextDue +=
          Math.ceil((now - nextDue + 1) / FINGERPRINT_INTERVAL_MS) *
          FINGERPRINT_INTERVAL_MS;
      }
      schedulerTimerRef.current = setTimeout(tick, Math.max(0, nextDue - now));
    };
    if (!heartbeatTimerRef.current) {
      heartbeatTimerRef.current = setInterval(() => {
        const targetRoom = roomRef.current;
        const current = armedRef.current;
        if (!targetRoom || !current.armed) return;
        const observation = observationStateRef.current;
        const payload = new TextEncoder().encode(
          JSON.stringify({
            type: "guide.heartbeat",
            protocol_version: 2,
            guide_session_id: current.sessionId,
            task_id: taskStateRef.current?.taskId ?? resumeTaskIdRef.current,
            task_revision: taskStateRef.current?.revision ?? null,
            active_process: observation?.activeProcess ?? "",
            active_window_id: observation?.activeWindowId ?? "",
            geometry_revision: observation?.geometryRevision ?? 0,
            captured_at_ms: Date.now(),
          }),
        );
        void targetRoom.localParticipant.publishData(payload, {
          reliable: false,
          topic: "client_events",
        });
      }, HEARTBEAT_INTERVAL_MS);
    }
    void tick();
  }, [processCapture]);

  const applyArmed = useCallback(
    (payload: GuideArmedPayload) => {
      const previous = armedRef.current;
      if (payload.epoch < previous.epoch) {
        logInfo(
          "useGuideMode: ignored stale armed state",
          `receivedEpoch=${payload.epoch} currentEpoch=${previous.epoch}`,
        );
        return;
      }
      if (
        payload.epoch === previous.epoch &&
        payload.armed === previous.armed &&
        payload.sessionId === previous.sessionId
      ) {
        return;
      }
      const wasArmed = previous.armed;
      armedRef.current = payload;
      setArmed(payload.armed);
      logInfo(
        "useGuideMode: armed state",
        `armed=${String(payload.armed)} epoch=${payload.epoch}`,
      );
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
        const targetRoom = roomRef.current;
        const disarmGeneration = modeGenerationRef.current + 1;
        modeGenerationRef.current = disarmGeneration;
        clearClientState();
        taskStateRef.current = null;
        resumeTaskIdRef.current = null;
        try {
          localStorage.removeItem(GUIDE_TASK_STORAGE_KEY);
        } catch {
          // Storage is optional; durable server state remains authoritative.
        }
        if (targetRoom) {
          void publishCurrentMode(targetRoom, disarmGeneration).catch((error) =>
            logGuideFailure("execution", "publish_disarm_failed", error),
          );
        }
        return;
      }
      if (!wasArmed) {
        resumeTaskIdRef.current = storedTaskId();
        completedRef.current = false;
        usageStartMonoRef.current = performance.now();
        usageStartedAtRef.current = new Date().toISOString();
        framesSentRef.current = 0;
        stepsReceivedRef.current = 0;
        agentTimeoutsRef.current = 0;
      }
      const targetRoom = roomRef.current;
      if (targetRoom) {
        void primeGuideAgent(targetRoom).catch((error) =>
          logGuideFailure("execution", "prime_after_arm_failed", error),
        );
      }
    },
    [clearClientState, primeGuideAgent, publishCurrentMode],
  );

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const stopListening = await listen<GuideArmedWirePayload>(GUIDE_ARMED, (event) =>
        applyArmed(normalizeGuideArmedPayload(event.payload)),
      );
      if (cancelled) {
        stopListening();
        return;
      }
      unlisten = stopListening;
      const payload = await invoke<GuideArmedWirePayload>("guide_armed_state");
      if (!cancelled) applyArmed(normalizeGuideArmedPayload(payload));
    })().catch((error) =>
      logGuideFailure("execution", "initialize_armed_state_failed", error)
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applyArmed]);

  useEffect(() => {
    if (!room) return;
    const onParticipantConnected = (participant: RemoteParticipant) => {
      if (!participant.isAgent) return;
      void primeGuideAgent(room).catch((error) =>
        logGuideFailure("execution", "prime_after_agent_join_failed", error),
      );
    };
    const onReconnected = () => {
      readyAgentRoomRef.current = null;
      void primeGuideAgent(room).catch((error) =>
        logGuideFailure("execution", "prime_after_reconnect_failed", error),
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
      if (verdict.type === "guide.request") {
        // The voice agent asked to arm/disarm Guide Mode. Rust stays the arming
        // authority (it pins the cursor's monitor and checks the session): route
        // straight to the native command and let the guide-armed event drive the
        // state machine. No-op when already in the requested state to avoid
        // re-arming churn (a fresh arm would mint a new session for nothing).
        const enable = verdict.payload.enable;
        if (typeof enable !== "boolean") return;
        if (enable === armedRef.current.armed) {
          logInfo(
            "useGuideMode: guide.request no-op",
            `enable=${String(enable)} armed=${String(armedRef.current.armed)}`,
          );
          return;
        }
        logInfo("useGuideMode: guide.request", `enable=${String(enable)}`);
        void invoke(enable ? "arm_guide" : "disarm_guide").catch((error) =>
          logGuideFailure(
            "execution",
            enable ? "voice_arm_failed" : "voice_disarm_failed",
            error,
          ),
        );
        return;
      }
      if (verdict.type === "guide.mode_ack") {
        const generation = verdict.payload.generation;
        const sessionId = verdict.payload.guide_session_id;
        const acknowledgedActive = verdict.payload.active === true;
        if (typeof generation !== "number" || typeof sessionId !== "string") return;
        const pending = pendingModeAckRef.current;
        if (acknowledgedActive) {
          if (
            !pending ||
            pending.room !== room ||
            pending.generation !== generation ||
            pending.sessionId !== sessionId ||
            pending.epoch !== armedRef.current.epoch ||
            sessionId !== armedRef.current.sessionId
          ) {
            return;
          }
          clearModeAckTimer();
          pendingModeAckRef.current = null;
          activeModeGenerationRef.current = generation;
          readyAgentRoomRef.current = room;
          logGuideEvent("execution", "succeeded", "mode_ack_received", {
            guide_session_id: sessionId,
            generation,
            guide_epoch: armedRef.current.epoch,
          });
          logInfo(
            "useGuideMode: mode acknowledged",
            `generation=${generation} session=${sessionId}`,
          );
          if (isLive(statusRef.current)) {
            void processCaptureRef.current("resume", true);
          }
          return;
        }
        if (
          activeModeGenerationRef.current !== generation &&
          pending?.generation !== generation
        ) {
          return;
        }
        clearModeAckTimer();
        pendingModeAckRef.current = null;
        activeModeGenerationRef.current = null;
        readyAgentRoomRef.current = null;
        firstFrameReadyGenerationRef.current = null;
        setActive(false);
        logInfo(
          "useGuideMode: mode rejected",
          `generation=${generation} reason=${String(verdict.payload.reason ?? "inactive")}`,
        );
        if (armedRef.current.armed && armedRef.current.sessionId === sessionId) {
          void invoke("disarm_guide").catch((error) =>
            logGuideFailure("execution", "disarm_after_mode_rejection_failed", error),
          );
        }
        return;
      }
      if (
        !armedRef.current.armed &&
        (
          verdict.type === "guide.task" ||
          verdict.type === "guide.instruction" ||
          verdict.type === "guide.failure" ||
          verdict.type === "guide.frame_ack" ||
          verdict.type === "guide.step"
        )
      ) {
        return;
      }
      if (verdict.type === "element.point") {
        const frameId = verdict.payload.frame_id;
        const x = verdict.payload.x;
        const y = verdict.payload.y;
        if (typeof frameId !== "string" || typeof x !== "number" || typeof y !== "number") {
          logGuideEvent("execution", "rejected", "pointer_payload_invalid");
          return;
        }
        const geometry = sentGeometryRef.current.get(frameId);
        if (!geometry) {
          logGuideEvent("execution", "rejected", "pointer_frame_geometry_missing", {
            frame_id: frameId,
            retained_frame_ids: Array.from(sentGeometryRef.current.keys()),
            guide_armed: armedRef.current.armed,
            guide_active: activeModeGenerationRef.current !== null,
          });
          return;
        }
        const label = typeof verdict.payload.label === "string" ? verdict.payload.label.trim() : "";
        logGuideEvent("execution", "started", "pointer_native_invocation", {
          frame_id: frameId,
          geometry_revision: observationStateRef.current?.geometryRevision ?? null,
        });
        void onPoint(geometry, { frameId, x, y, label })
          .then(() =>
            logGuideEvent("execution", "succeeded", "pointer_native_invoked", {
              frame_id: frameId,
            }),
          )
          .catch((error) =>
            logGuideFailure("execution", "pointer_publication_failed", error),
          );
        return;
      }
      if (verdict.type === "guide.task") {
        if (verdict.payload.guide_session_id !== armedRef.current.sessionId) return;
        const nextTask = guideTaskState(verdict.payload);
        if (!nextTask) return;
        const currentTask = taskStateRef.current;
        if (
          currentTask &&
          currentTask.taskId === nextTask.taskId &&
          nextTask.revision < currentTask.revision
        ) {
          return;
        }
        taskStateRef.current = nextTask;
        resumeTaskIdRef.current = nextTask.resumable ? nextTask.taskId : null;
        try {
          if (nextTask.resumable) {
            localStorage.setItem(GUIDE_TASK_STORAGE_KEY, nextTask.taskId);
          } else {
            localStorage.removeItem(GUIDE_TASK_STORAGE_KEY);
          }
        } catch {
          // Storage is optional; server state remains authoritative.
        }
        logInfo(
          "useGuideMode: task",
          `task=${nextTask.taskId} revision=${nextTask.revision} status=${nextTask.status} step=${nextTask.currentStepId ?? "none"}`,
        );
        if (
          !nextTask.completion &&
          readyAgentRoomRef.current === room &&
          activeModeGenerationRef.current !== null &&
          firstFrameReadyGenerationRef.current === activeModeGenerationRef.current
        ) {
          setActive(true);
        }
        if (nextTask.completion) {
          completedRef.current = true;
          trackEvent("guide_completed");
          void invoke("disarm_guide").catch((error) =>
            logGuideFailure("execution", "completion_disarm_failed", error),
          );
        }
        return;
      }
      if (verdict.type === "guide.failure") {
        if (verdict.payload.guide_session_id !== armedRef.current.sessionId) return;
        logError(
          "GuideTrace",
          new Error(JSON.stringify({
            trace_id: verdict.payload.trace_id,
            event_id: verdict.payload.event_id,
            task_id: verdict.payload.task_id ?? null,
            task_revision: verdict.payload.task_revision ?? null,
            stage: verdict.payload.stage,
            outcome: "failed",
            reason: verdict.payload.reason,
            error_type: verdict.payload.error_type ?? null,
          })),
        );
        return;
      }
      if (verdict.type === "guide.instruction") {
        if (verdict.payload.guide_session_id !== armedRef.current.sessionId) return;
        const instructionId = verdict.payload.instruction_id;
        const taskId = verdict.payload.task_id;
        const revision = verdict.payload.revision;
        const stepId = verdict.payload.step_id;
        const frameId = verdict.payload.frame_id;
        const deliveryStatus = verdict.payload.delivery_status;
        if (
          typeof instructionId !== "string" ||
          typeof taskId !== "string" ||
          typeof revision !== "number"
        ) {
          return;
        }
        logInfo(
          "useGuideMode: instruction",
          `task=${taskId} revision=${revision} step=${String(stepId)} frame=${String(frameId)} instruction=${instructionId} status=${String(deliveryStatus)}`,
        );
        clearVerificationTimer();
        if (verdict.payload.done === true) {
          completedRef.current = true;
          void invoke("disarm_guide").catch((error) =>
            logGuideFailure("execution", "instruction_completion_disarm_failed", error),
          );
        } else if (deliveryStatus === "delivered" || deliveryStatus === "claimed") {
          verificationTimerRef.current = setTimeout(() => {
            void processCaptureRef.current("verification_timeout", true);
          }, VERIFICATION_TIMEOUT_MS);
        }
        return;
      }
      if (verdict.type === "guide.frame_ack") {
        const frameId = verdict.payload.frame_id;
        const awaiting = awaitingRef.current;
        if (
          typeof frameId !== "string" ||
          !awaiting ||
          frameId !== awaiting.envelope.frameId
        ) {
          return;
        }
        clearResponseTimer();
        void (async () => {
          const dirty = await invoke<boolean>("ack_guide_response", {
            frameId,
            epoch: armedRef.current.epoch,
          });
          awaitingRef.current = null;
          logInfo(
            "useGuideMode: frame ack",
            `frame=${frameId} accepted=${String(verdict.payload.accepted)} newest=${String(verdict.payload.newest_frame_id ?? "")}`,
          );
          if (
            verdict.payload.accepted === true &&
            readyAgentRoomRef.current === room &&
            activeModeGenerationRef.current !== null
          ) {
            firstFrameReadyGenerationRef.current = activeModeGenerationRef.current;
            if (taskStateRef.current !== null) setActive(true);
          } else if (verdict.payload.accepted !== true) {
            setActive(false);
            readyAgentRoomRef.current = null;
            activeModeGenerationRef.current = null;
            firstFrameReadyGenerationRef.current = null;
            void invoke("disarm_guide").catch((error) =>
              logGuideFailure("execution", "disarm_after_frame_rejection_failed", error),
            );
          }
          if (dirty) await processCapture("stable_change");
        })().catch((error) =>
          logGuideFailure("execution", "accept_frame_ack_failed", error, awaiting)
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
      })().catch((error) =>
        logGuideFailure("execution", "accept_legacy_guide_step_failed", error, awaiting)
      );
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
            turnContextIdRef.current = newTurnContextId();
            turnTraceRef.current = {
              traceId: traceId(),
              eventId: traceId(),
              parentEventId: lastEventIdRef.current,
            };
            clearVerificationTimer();
            void processCapture("user_turn", true);
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
      void primeGuideAgent(room).catch((error) =>
        logGuideFailure("execution", "prime_room_failed", error),
      );
    }
    return () => {
      if (readyAgentRoomRef.current === room) readyAgentRoomRef.current = null;
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.Reconnected, onReconnected);
      room.off(RoomEvent.DataReceived, onDataReceived);
      room.off(RoomEvent.TranscriptionReceived, onTranscriptionReceived);
    };
  }, [
    clearResponseTimer,
    clearModeAckTimer,
    clearVerificationTimer,
    onPoint,
    primeGuideAgent,
    processCapture,
    room,
  ]);

  useEffect(() => {
    if (!armed || !isLive(status)) return;
    startScheduler();
    // Deliver one frame the instant Guide arms on a live session so the agent
    // has the current screen before the user's next utterance, instead of
    // waiting for the change-filter to notice motion. The reseed-retry inside
    // processCapture is what makes this land rather than only seed the baseline.
    void processCaptureRef.current("resume", true);
    return () => {
      scheduleGenerationRef.current += 1;
      if (schedulerTimerRef.current) clearTimeout(schedulerTimerRef.current);
      if (heartbeatTimerRef.current) clearInterval(heartbeatTimerRef.current);
      heartbeatTimerRef.current = null;
    };
  }, [armed, startScheduler, status]);

  useEffect(() => {
    if (!signedIn && armedRef.current.armed) {
      disarmReasonRef.current = "signed_out";
      void invoke("disarm_guide");
    }
    if (
      !signedIn ||
      status === "ended" ||
      status === "error" ||
      status === "disconnected"
    ) {
      // A voice transport ending is recoverable. Keep Guide armed and retain the
      // durable task ID so the next room publishes resume_task_id.
      clearClientState();
    }
  }, [clearClientState, signedIn, status]);

  useEffect(() => clearClientState, [clearClientState]);

  const stop = useCallback(() => {
    void invoke("disarm_guide").catch((error) =>
      logGuideFailure("execution", "explicit_disarm_failed", error)
    );
  }, []);

  return {
    armed,
    active,
    epoch: armedRef.current.epoch,
    stop,
  };
}
