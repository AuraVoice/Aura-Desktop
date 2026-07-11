import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { hostname } from "@tauri-apps/plugin-os";
import type { UpcomingMeeting } from "../lib/calendar";
import { isEligibleForNotes } from "./useMeetingArm";
import {
  claimMeeting,
  completeMeeting,
  MeetingCapError,
  MeetingClaimConflictError,
  MeetingGoneError,
  uploadSegment,
} from "../lib/meetings";
import { AuthRequiredError } from "../lib/api";
import { trackEvent } from "../lib/analytics";
import { logError, logInfo } from "../lib/log";
import { installMeetingDebug } from "../debug/meetingDebug";

/** Fallback meeting length when the calendar event has no end time. */
const DEFAULT_MEETING_MS = 60 * 60_000;
/** Manual captures ("I'm in a call") get this claim window. */
const MANUAL_WINDOW_MS = 2 * 60 * 60_000;
/** After the user leaves a call, completion holds this long for a rejoin
 * before the capture is finalized and sent to synthesis. */
const REJOIN_HOLD_MS = 10 * 60_000;
/** Background upload pump cadence (also triggered by segment-ready events). */
const PUMP_INTERVAL_MS = 60_000;
/** Per-meeting retry backoff after an upload/complete failure. */
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const CLAIM_RETRIES = 2;

interface QueueSegment {
  seq: number;
  startMs: number;
  durationMs: number;
  uploaded: boolean;
  incomplete: boolean;
}

interface QueueMeeting {
  eventId: string;
  startedAtMs: number;
  completed: boolean;
  completeReason: string;
  totalDurationMs: number;
  segments: QueueSegment[];
}

interface QueueSnapshot {
  meetings: Record<string, QueueMeeting>;
}

interface CaptureStatePayload {
  active: boolean;
  meetingId: string | null;
  eventId: string | null;
  paused: boolean;
  reason: string;
}

// Same transport normalization as useScreenSight's asArrayBuffer: the IPC
// channel can deliver binary as ArrayBuffer, a view, or (postMessage
// fallback) a plain number array.
function asBytes(raw: unknown): Uint8Array {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (ArrayBuffer.isView(raw)) {
    return new Uint8Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]);
  throw new Error(`read_segment returned ${Object.prototype.toString.call(raw)}, expected binary`);
}

export interface MeetingCaptureState {
  /** A capture is running right now (drives the bar's recording dot). */
  recording: boolean;
  /** Capture paused because the session is locked. */
  paused: boolean;
  /** The monthly cap blocked the last claim (drives the caption + Upgrade). */
  capBlocked: boolean;
  dismissCapBlocked: () => void;
  /** Manual "Capture this call" entry (Google Meet has no detector). */
  captureNow: () => void;
  /** The bar's stop control (after its own confirm step). */
  stopCapture: () => void;
  /** Last meeting handed to the backend for synthesis - useMeetingNotes polls
   * it to ready. */
  lastCompletedMeetingId: string | null;
}

interface MeetingCaptureInputs {
  signedIn: boolean;
  events: UpcomingMeeting[];
  isArmed: (eventId: string) => boolean;
  /** Arm-state revision counter so watch scheduling reruns on toggles. */
  armRevision: number;
}

/**
 * The arm -> detect -> claim -> capture -> upload -> complete state machine.
 * Rust detects and captures; this hook owns every HTTP leg (claim, segment
 * upload, complete) because tokens live in JS. Mounted once in OverlayRoot,
 * alive regardless of presentation, like useMeetings.
 *
 * Every failure path here is silent to the user except the monthly cap
 * (a plan state, surfaced with an Upgrade pointer, mirroring the voice cap).
 */
export function useMeetingCapture(inputs: MeetingCaptureInputs): MeetingCaptureState {
  const { signedIn, events, isArmed, armRevision } = inputs;

  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [capBlocked, setCapBlocked] = useState(false);
  const [lastCompletedMeetingId, setLastCompletedMeetingId] = useState<string | null>(null);

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;
  const isArmedRef = useRef(isArmed);
  isArmedRef.current = isArmed;

  const recordingRef = useRef(false);
  /** event_id -> claimed meeting for this session (rejoins reuse it). */
  const claimsRef = useRef<Map<string, string>>(new Map());
  const activeEventRef = useRef<string | null>(null);
  const watchedRef = useRef<Set<string>>(new Set());
  /** meeting_id -> earliest time the pump may send /complete (rejoin hold). */
  const holdUntilRef = useRef<Map<string, number>>(new Map());
  /** meeting_id -> { failures, nextAttemptAt } upload backoff. */
  const backoffRef = useRef<Map<string, { failures: number; nextAt: number }>>(new Map());
  const pumpRunningRef = useRef(false);
  const claimInFlightRef = useRef(false);
  /** A join re-detected while the previous engine was still flushing; replayed
   * once the capture-state event says the teardown finished. */
  const pendingRejoinRef = useRef<string | null>(null);

  // ── Watch scheduling ────────────────────────────────────────────────────
  // Keep Rust's join detector armed for exactly the armed meetings whose
  // watch window is still ahead. Diffed against what's currently watched so
  // toggling one meeting doesn't churn the others.
  useEffect(() => {
    if (!signedIn) {
      for (const eventId of watchedRef.current) {
        void invoke("stop_join_watch", { eventId }).catch(() => undefined);
      }
      watchedRef.current.clear();
      return;
    }
    const now = Date.now();
    const desired = new Map<string, { startMs: number; endMs: number }>();
    for (const event of events) {
      if (!isEligibleForNotes(event) || !isArmed(event.id)) continue;
      const start = Date.parse(event.startTime);
      if (Number.isNaN(start)) continue;
      const parsedEnd = Date.parse(event.endTime);
      const end = Number.isNaN(parsedEnd) ? start + DEFAULT_MEETING_MS : parsedEnd;
      if (end <= now) continue;
      // Detection polls ONLY inside the event's own scheduled window, start
      // to end - no lead, no tail. This is deliberate exposure control: an
      // armed window is also the window in which an unrelated Zoom/Teams
      // call can be misattributed to the event (detection is not
      // link-matched in v1), so it stays exactly as wide as the meeting.
      // An overrunning call the user is still IN keeps its presence watch
      // (detect.rs holds the watch while joined); what's given up is
      // detecting a join that happens before start or after scheduled end.
      desired.set(event.id, { startMs: start, endMs: end });
    }

    for (const eventId of watchedRef.current) {
      if (!desired.has(eventId)) {
        watchedRef.current.delete(eventId);
        void invoke("stop_join_watch", { eventId }).catch((err) =>
          logError("useMeetingCapture: stop_join_watch", err),
        );
      }
    }
    for (const [eventId, window] of desired) {
      if (watchedRef.current.has(eventId)) continue;
      watchedRef.current.add(eventId);
      void invoke("start_join_watch", {
        eventId,
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
      }).catch((err) => logError("useMeetingCapture: start_join_watch", err));
    }
  }, [signedIn, events, isArmed, armRevision]);

  // ── Claim + capture ─────────────────────────────────────────────────────
  const startCaptureFor = useCallback(
    async (eventId: string, title: string, startTime: string, endTime: string) => {
      if (recordingRef.current || claimInFlightRef.current) return;
      claimInFlightRef.current = true;
      try {
        const deviceId = (await hostname().catch(() => null)) ?? "desktop";
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= CLAIM_RETRIES; attempt++) {
          try {
            const claim = await claimMeeting({ eventId, title, startTime, endTime, deviceId });
            claimsRef.current.set(eventId, claim.meetingId);
            holdUntilRef.current.delete(claim.meetingId);
            activeEventRef.current = eventId;
            await invoke("start_meeting_capture", {
              meetingId: claim.meetingId,
              eventId,
            });
            trackEvent("meeting_capture_started", { rejoined: claim.rejoined });
            return;
          } catch (err) {
            if (err instanceof MeetingCapError) {
              setCapBlocked(true);
              trackEvent("meeting_cap_blocked", {
                seconds_until_reset: err.secondsUntilReset ?? -1,
              });
              return;
            }
            if (err instanceof MeetingClaimConflictError) {
              logInfo("useMeetingCapture", "claim conflict: another device is capturing");
              return;
            }
            if (err instanceof AuthRequiredError) return;
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
          }
        }
        logError("useMeetingCapture: claim failed after retries", lastError);
      } finally {
        claimInFlightRef.current = false;
      }
    },
    [],
  );

  const handleJoinDetected = useCallback(
    (eventId: string) => {
      if (!signedInRef.current) return;
      if (recordingRef.current) {
        if (activeEventRef.current === eventId) {
          // The detector re-latched the same meeting while the previous
          // engine run is still flushing (fast rejoin). The detector won't
          // emit again, so replay this once the teardown finishes.
          pendingRejoinRef.current = eventId;
          return;
        }
        // One capture at a time; an overlapping second meeting is skipped.
        logInfo("useMeetingCapture", `join for ${eventId} ignored, capture already live`);
        return;
      }
      const event = eventsRef.current.find((candidate) => candidate.id === eventId);
      if (event) {
        if (!isArmedRef.current(eventId)) return; // disarmed after the watch started
        void startCaptureFor(eventId, event.title, event.startTime, event.endTime);
        return;
      }
      // Debug injections and rejoins after the event dropped off the agenda
      // still capture: the claim is what validates, not the local list.
      const now = new Date();
      void startCaptureFor(
        eventId,
        "Meeting",
        now.toISOString(),
        new Date(now.getTime() + DEFAULT_MEETING_MS).toISOString(),
      );
    },
    [startCaptureFor],
  );

  const captureNow = useCallback(() => {
    if (recordingRef.current || !signedInRef.current) return;
    const eventId = `manual:${crypto.randomUUID()}`;
    const now = new Date();
    trackEvent("meeting_capture_manual", {});
    void startCaptureFor(
      eventId,
      "Manual capture",
      now.toISOString(),
      new Date(now.getTime() + MANUAL_WINDOW_MS).toISOString(),
    );
  }, [startCaptureFor]);

  const stopCapture = useCallback(() => {
    void invoke("stop_meeting_capture", { reason: "stopped_by_user" }).catch((err) =>
      logError("useMeetingCapture: stop_meeting_capture", err),
    );
  }, []);

  const dismissCapBlocked = useCallback(() => setCapBlocked(false), []);

  // ── Upload pump ─────────────────────────────────────────────────────────
  // Drains the durable Rust queue: upload every unsent segment, then send
  // /complete for finished captures (unless a rejoin hold is active), then
  // ack so Rust deletes the local files. Runs on segment-ready, capture end,
  // mount (restart recovery), and a slow interval.
  const pump = useCallback(async () => {
    if (pumpRunningRef.current || !signedInRef.current) return;
    pumpRunningRef.current = true;
    try {
      const snapshot = await invoke<QueueSnapshot>("queue_snapshot");
      const now = Date.now();
      for (const [meetingId, meeting] of Object.entries(snapshot.meetings ?? {})) {
        const backoff = backoffRef.current.get(meetingId);
        if (backoff && backoff.nextAt > now) continue;
        try {
          for (const segment of meeting.segments) {
            if (segment.uploaded) continue;
            const raw = await invoke("read_segment", { meetingId, seq: segment.seq });
            await uploadSegment(
              meetingId,
              segment.seq,
              asBytes(raw),
              segment.startMs,
              segment.durationMs,
              segment.incomplete,
            );
            await invoke("mark_segment_uploaded", { meetingId, seq: segment.seq });
          }
          const allUploaded = meeting.segments.every((segment) => segment.uploaded)
            || meeting.segments.length === 0;
          const hold = holdUntilRef.current.get(meetingId) ?? 0;
          // Never complete a meeting that is actively capturing again (a
          // rejoin raced this pass); Rust's ack guard is the authoritative
          // backstop, this check just avoids the wasted round trip.
          const activelyCapturing =
            recordingRef.current &&
            (await invoke<{ meetingId: string | null }>("capture_status")).meetingId ===
              meetingId;
          if (meeting.completed && hold <= now && !activelyCapturing) {
            // Segments may have just been marked uploaded above; re-check via
            // a fresh snapshot only when the stale view said no.
            if (allUploaded || (await allSegmentsUploaded(meetingId))) {
              // Zero-segment captures still report completion (the backend
              // resolves the claimed meeting to "failed"), they just never
              // become a note to poll.
              await completeMeeting(meetingId, {
                segmentCount: meeting.segments.length,
                totalDurationMs: meeting.totalDurationMs,
                reason: meeting.completeReason || "ended",
              });
              if (meeting.segments.length > 0) {
                setLastCompletedMeetingId(meetingId);
              }
              trackEvent("meeting_capture_completed", {
                segments: meeting.segments.length,
                reason: meeting.completeReason || "ended",
              });
              await invoke("mark_meeting_acked", { meetingId });
              holdUntilRef.current.delete(meetingId);
            }
          }
          backoffRef.current.delete(meetingId);
        } catch (err) {
          if (err instanceof AuthRequiredError) throw err;
          if (err instanceof MeetingGoneError) {
            // The backend forgot this meeting (claim lock replaced it, doc
            // expired): retrying forever cannot help. Drop the local entry.
            logError(`useMeetingCapture: pump ${meetingId} gone on backend, acking`, err);
            await invoke("mark_meeting_acked", { meetingId }).catch(() => undefined);
            backoffRef.current.delete(meetingId);
            continue;
          }
          const failures = (backoff?.failures ?? 0) + 1;
          backoffRef.current.set(meetingId, {
            failures,
            nextAt: now + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS),
          });
          logError(`useMeetingCapture: pump ${meetingId} (attempt ${failures})`, err);
        }
      }
    } catch (err) {
      if (!(err instanceof AuthRequiredError)) {
        logError("useMeetingCapture: pump", err);
      }
    } finally {
      pumpRunningRef.current = false;
    }
  }, []);

  const allSegmentsUploaded = async (meetingId: string): Promise<boolean> => {
    const snapshot = await invoke<QueueSnapshot>("queue_snapshot");
    const meeting = snapshot.meetings?.[meetingId];
    return meeting != null && meeting.segments.every((segment) => segment.uploaded);
  };

  // ── Event wiring ────────────────────────────────────────────────────────
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const add = (promise: Promise<() => void>, label: string) => {
      promise
        .then((unlisten) => {
          if (disposed) unlisten();
          else unlisteners.push(unlisten);
        })
        .catch((err) => logError(`useMeetingCapture: listen ${label}`, err));
    };

    add(
      listen<{ eventId: string }>("meeting-join-detected", (event) => {
        handleJoinDetected(event.payload.eventId);
      }),
      "join-detected",
    );
    add(
      listen<{ eventId: string }>("meeting-left", (event) => {
        if (activeEventRef.current === event.payload.eventId) {
          void invoke("stop_meeting_capture", { reason: "meeting_left" }).catch((err) =>
            logError("useMeetingCapture: stop on meeting-left", err),
          );
        }
      }),
      "meeting-left",
    );
    add(
      listen<CaptureStatePayload>("meeting-capture-state", (event) => {
        const payload = event.payload;
        recordingRef.current = payload.active;
        setRecording(payload.active);
        setPaused(payload.active && payload.paused);
        if (!payload.active) {
          activeEventRef.current = null;
          if (payload.meetingId) {
            if (payload.reason === "meeting_left") {
              // Hold /complete for a rejoin; the watch window is still open,
              // and a re-detected join reclaims the same meeting id.
              holdUntilRef.current.set(payload.meetingId, Date.now() + REJOIN_HOLD_MS);
              setTimeout(() => void pump(), REJOIN_HOLD_MS + 1000);
            }
            void pump();
          }
          if (payload.reason === "capture_failed") {
            trackEvent("meeting_capture_failed", {});
          }
          // A join that arrived during this teardown was latched, not lost:
          // replay it now that the engine is gone.
          const pendingRejoin = pendingRejoinRef.current;
          if (pendingRejoin) {
            pendingRejoinRef.current = null;
            setTimeout(() => handleJoinDetected(pendingRejoin), 0);
          }
        }
      }),
      "capture-state",
    );
    add(
      listen("meeting-segment-ready", () => void pump()),
      "segment-ready",
    );
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [handleJoinDetected, pump]);

  // Recording is a per-user consent grant: signing out (or being signed out)
  // must end any live capture immediately, not just stop future watches.
  useEffect(() => {
    if (signedIn) return;
    pendingRejoinRef.current = null;
    if (recordingRef.current) {
      void invoke("stop_meeting_capture", { reason: "signed_out" }).catch((err) =>
        logError("useMeetingCapture: stop on sign-out", err),
      );
    }
  }, [signedIn]);

  // Restart recovery + steady drain: seed recording state, then pump on an
  // interval. capture_status covers the race where capture started before
  // the listener mounted (post-crash relaunch cannot have a live capture,
  // but a webview reload during dev can).
  useEffect(() => {
    if (!signedIn) return;
    void invoke<{ active: boolean; paused: boolean; eventId: string | null }>("capture_status")
      .then((status) => {
        recordingRef.current = status.active;
        setRecording(status.active);
        setPaused(status.active && status.paused);
        activeEventRef.current = status.eventId;
      })
      .catch((err) => logError("useMeetingCapture: capture_status", err));
    void pump();
    const id = setInterval(() => void pump(), PUMP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [signedIn, pump]);

  // Dev harness (see meetingDebug.ts).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return installMeetingDebug({ captureNow, stopCapture, pump: () => void pump() });
  }, [captureNow, stopCapture, pump]);

  return {
    recording,
    paused,
    capBlocked,
    dismissCapBlocked,
    captureNow,
    stopCapture,
    lastCompletedMeetingId,
  };
}
