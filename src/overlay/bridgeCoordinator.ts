import { Track, type RemoteTrack, type Room } from "livekit-client";
import { logError, logInfo } from "../lib/log";
import type { RealtimeLeg } from "../lib/realtime";

// Wire protocol shared with the worker (../Aura/backend/src/agent/voice/bridge_handover.py).
const HOLD_READY = "hold_ready";
const HANDOVER_APPLIED = "handover_applied";
const HANDOVER_BEGIN = "handover_begin";
const HANDOVER_SKIP = "handover_skip";
const BRIDGE_HEARTBEAT = "bridge_heartbeat";

// Keep HOLD alive under the worker's 8s heartbeat timeout.
const HEARTBEAT_INTERVAL_MS = 3_000;
const SAFE_BOUNDARY_POLL_MS = 150;
// A verified LiveKit agent should publish hold_ready immediately after its
// AgentSession starts. Bound version/configuration drift so Realtime cannot
// remain the accidental owner of an otherwise-live call forever.
const HOLD_READY_TIMEOUT_MS = 5_000;
// Never transfer ownership while either side is mid-utterance. If Realtime
// never reports a quiet boundary, fail into the caller's cold LiveKit recovery
// instead of clipping the final assistant message.
const SAFE_BOUNDARY_TIMEOUT_MS = 30_000;

export interface BridgeCoordinatorOptions {
  room: Room;
  realtime: RealtimeLeg;
  /** The single shared mic track, owned by Realtime until handover. */
  sharedTrack: MediaStreamTrack;
  /** Element the worker's voice plays through once handover is applied. */
  liveKitAudioEl: HTMLAudioElement;
  onFatal: (reason: unknown) => void;
  onActive: () => void;
}

/**
 * Drives the Realtime -> LiveKit voice handover from the desktop side. Lifecycle:
 * hold_ready (worker warm) -> heartbeats + wait for a safe gap -> handover_begin
 * (seed transcript) or handover_skip (Realtime never spoke) -> handover_applied
 * (worker took over) -> publish the shared mic to LiveKit, unmute the worker's
 * voice, tear down the Realtime leg. Any control failure routes to onFatal, which
 * useVoiceBar turns into its cold-path retry.
 */
export class BridgeCoordinator {
  private readonly room: Room;
  private readonly realtime: RealtimeLeg;
  private readonly sharedTrack: MediaStreamTrack;
  private readonly liveKitAudioEl: HTMLAudioElement;
  private readonly onFatal: (reason: unknown) => void;
  private readonly onActive: () => void;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private holdReadyTimer: ReturnType<typeof setTimeout> | null = null;
  private boundaryTimer: ReturnType<typeof setTimeout> | null = null;
  private agentTrack: RemoteTrack | null = null;
  private handoverId: string | null = null;
  private holdReadyReceived = false;
  private handoverAttempted = false;
  private failureReported = false;
  private applied = false;
  private torn = false;

  constructor(opts: BridgeCoordinatorOptions) {
    this.room = opts.room;
    this.realtime = opts.realtime;
    this.sharedTrack = opts.sharedTrack;
    this.liveKitAudioEl = opts.liveKitAudioEl;
    this.onFatal = opts.onFatal;
    this.onActive = opts.onActive;
  }

  /** Returns true when the message was a bridge control (consumed). */
  handleDataMessage(msg: Record<string, unknown>): boolean {
    switch (msg.type) {
      case HOLD_READY:
        this.onHoldReady();
        return true;
      case HANDOVER_APPLIED:
        this.onHandoverApplied(String(msg.handover_id ?? ""));
        return true;
      default:
        return false;
    }
  }

  /** The LiveKit agent's audio, parked silently until handover_applied. */
  attachAgentAudio(track: RemoteTrack): void {
    this.agentTrack = track;
    if (this.applied) this.playAgentAudio();
  }

  /** Best-effort "agent connected" hint; the real handover gate is hold_ready. */
  onAgentReady(): void {
    if (this.torn || this.applied || this.holdReadyReceived || this.holdReadyTimer) return;
    logInfo("bridge: agent ready", "best-effort; waiting on hold_ready");
    this.holdReadyTimer = setTimeout(() => {
      this.holdReadyTimer = null;
      this.fail(new Error(`bridge: hold_ready timed out (${HOLD_READY_TIMEOUT_MS}ms)`));
    }, HOLD_READY_TIMEOUT_MS);
  }

  teardown(): void {
    if (this.torn) return;
    this.torn = true;
    this.stopHeartbeat();
    this.clearHoldReadyTimer();
    this.clearBoundaryTimer();
    try {
      this.realtime.close();
    } catch (err) {
      logError("bridge: realtime close", err);
    }
    // Before handover the shared mic is still ours to release; after handover
    // LiveKit owns it, so leave it for the room teardown to stop.
    if (!this.applied) {
      try {
        this.sharedTrack.stop();
      } catch {
        /* ignore */
      }
    }
    try {
      this.agentTrack?.detach();
    } catch {
      /* ignore */
    }
  }

  private onHoldReady(): void {
    if (this.handoverAttempted || this.torn) return;
    this.holdReadyReceived = true;
    this.clearHoldReadyTimer();
    logInfo("bridge: hold_ready", "worker is warm; waiting for Realtime boundary");
    this.startHeartbeat();
    this.waitForBoundaryThenHandover();
  }

  private clearHoldReadyTimer(): void {
    if (this.holdReadyTimer) {
      clearTimeout(this.holdReadyTimer);
      this.holdReadyTimer = null;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.publish({ type: BRIDGE_HEARTBEAT });
    this.heartbeatTimer = setInterval(
      () => this.publish({ type: BRIDGE_HEARTBEAT }),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearBoundaryTimer(): void {
    if (this.boundaryTimer) {
      clearTimeout(this.boundaryTimer);
      this.boundaryTimer = null;
    }
  }

  private waitForBoundaryThenHandover(): void {
    const deadline = Date.now() + SAFE_BOUNDARY_TIMEOUT_MS;
    const tick = () => {
      if (this.handoverAttempted || this.torn) return;
      if (this.realtime.atSafeBoundary()) {
        logInfo("bridge: safe boundary", "Realtime finished; beginning handover");
        this.beginHandover();
        return;
      }
      if (Date.now() >= deadline) {
        this.fail(new Error(`bridge: safe boundary timed out (${SAFE_BOUNDARY_TIMEOUT_MS}ms)`));
        return;
      }
      this.boundaryTimer = setTimeout(tick, SAFE_BOUNDARY_POLL_MS);
    };
    tick();
  }

  private beginHandover(): void {
    if (this.handoverAttempted) return;
    this.handoverAttempted = true;
    this.clearBoundaryTimer();
    this.handoverId = crypto.randomUUID();
    if (this.realtime.hasSpoken()) {
      const turns = this.realtime.transcript();
      this.publish({ type: HANDOVER_BEGIN, handover_id: this.handoverId, turns });
      logInfo("bridge: handover_begin", `id=${this.handoverId} turns=${turns.length}`);
    } else {
      // Realtime never spoke (LiveKit won the race): let the worker greet fresh.
      this.publish({ type: HANDOVER_SKIP, handover_id: this.handoverId });
      logInfo("bridge: handover_skip", `id=${this.handoverId}`);
    }
  }

  private onHandoverApplied(id: string): void {
    if (this.applied || this.torn) return;
    if (!this.handoverId || id !== this.handoverId) return;
    this.applied = true;
    this.stopHeartbeat();
    this.clearBoundaryTimer();

    // Re-publish the ONE shared mic onto LiveKit (never open a second capture).
    void this.room.localParticipant
      .publishTrack(this.sharedTrack, { source: Track.Source.Microphone })
      .catch((err) => {
        logError("bridge: publishTrack", err);
        this.fail(err);
      });

    // Unmute the worker's voice, then drop the Realtime leg.
    this.playAgentAudio();
    try {
      this.realtime.close();
    } catch (err) {
      logError("bridge: realtime close on applied", err);
    }
    logInfo("bridge: handover applied", "LiveKit owns the conversation");
    this.onActive();
  }

  private playAgentAudio(): void {
    if (!this.agentTrack) return;
    try {
      this.agentTrack.attach(this.liveKitAudioEl);
      void this.liveKitAudioEl.play().catch((err) => logError("bridge: liveKitAudioEl.play", err));
    } catch (err) {
      logError("bridge: attach agent audio", err);
    }
  }

  private publish(payload: Record<string, unknown>): void {
    try {
      const data = new TextEncoder().encode(JSON.stringify(payload));
      void this.room.localParticipant.publishData(data, { reliable: true }).catch((err) => {
        logError("bridge: publishData", err);
        this.fail(err);
      });
    } catch (err) {
      logError("bridge: publish", err);
      this.fail(err);
    }
  }

  private fail(reason: unknown): void {
    if (this.failureReported || this.torn) return;
    this.failureReported = true;
    this.stopHeartbeat();
    this.clearHoldReadyTimer();
    this.clearBoundaryTimer();
    this.onFatal(reason);
  }
}
