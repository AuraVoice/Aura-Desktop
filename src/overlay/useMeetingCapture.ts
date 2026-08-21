import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpcomingMeeting } from "../lib/calendar";
import { isEligibleForNotes } from "./useMeetingArm";
import {
  claimMeeting,
  completeMeeting,
  MeetingCapError,
  MeetingClaimConflictError,
  MeetingTransportError,
  type CompletionReceipt,
  type MeetingCompletionSegment,
  type MeetingJobFailureClassification,
  type UploadReceipt,
  uploadSegment,
} from "../lib/meetings";
import { AuthRequiredError } from "../lib/api";
import { trackEvent } from "../lib/analytics";
import { logError, logInfo } from "../lib/log";
import { installMeetingDebug } from "../debug/meetingDebug";
import {
  bindMeetingActivityOwner,
  type MeetingActivity,
  upsertMeetingActivity,
} from "../lib/meetingActivity";
import { notifyLocal } from "../lib/desktopNotifications";
import {
  ensureMeetingNotificationPermission,
  sendMeetingCaptureEndedNotification,
} from "../lib/meetingDesktopNotification";

/** Fallback meeting length when the calendar event has no end time. */
const DEFAULT_MEETING_MS = 60 * 60_000;
/** Manual captures ("I'm in a call") get this claim window. */
const MANUAL_WINDOW_MS = 2 * 60 * 60_000;
/** After the user leaves a call, completion holds this long for a rejoin
 * before the capture is finalized and sent to synthesis. */
const REJOIN_HOLD_MS = 10 * 60_000;
/** Background upload pump cadence (also triggered by segment-ready events). */
const PUMP_INTERVAL_MS = 60_000;
const CLAIM_RETRIES = 2;

interface QueueSegment {
  seq: number;
  startMs: number;
  durationMs: number;
  uploaded: boolean;
  incomplete: boolean;
  contentSha256: string;
  encryptedSha256: string;
  byteLength: number;
  encryptedByteLength: number;
  channelCount: number;
  sampleRateHz: number;
  localPresent: boolean;
}

interface QueueCapture {
  ownerUid: string;
  meetingId: string;
  captureRunId: string;
  captureFence: number;
  eventId: string;
  startedAtMs: number;
  completed: boolean;
  completeReason: string;
  totalDurationMs: number;
  finishedAtMs: number | null;
  retainLocalUntilMs: number | null;
  completionAcked: boolean;
  ackedAtMs: number | null;
  localAudioDeletedAtMs: number | null;
  state: string;
  manifestSha256: string | null;
  nextRetryAtMs: number | null;
  lastErrorCode: string | null;
  retryable: boolean;
  segments: QueueSegment[];
}

interface QueueSnapshot {
  captures: QueueCapture[];
}

interface QueueJobLease {
  jobId: string;
  leaseToken: string;
  kind: "upload" | "completion";
  meetingId: string;
  captureRunId: string;
  captureFence: number;
  eventId: string;
  seq: number | null;
  startMs: number | null;
  durationMs: number | null;
  incomplete: boolean | null;
  contentSha256: string | null;
  byteLength: number | null;
  channelCount: number | null;
  sampleRateHz: number | null;
  manifestSha256: string | null;
  segmentCount: number | null;
  totalDurationMs: number | null;
  reason: string | null;
  segmentDigests: string[];
  manifestSegments: MeetingCompletionSegment[];
  attemptCount: number;
}

interface MeetingRuntimeStatus {
  ownsRuntime: boolean;
  processId: number;
  runtimeInstanceId: string;
  installationId: string;
}

interface CaptureStatePayload {
  ownerUid: string;
  active: boolean;
  meetingId: string | null;
  captureRunId: string | null;
  eventId: string | null;
  paused: boolean;
  reason: string;
  startedAtMs: number | null;
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
  /** Durable local lifecycle rows, newest first. */
  activities: MeetingActivity[];
  /** Clear local backoff and safely re-run the idempotent upload pump. Returns
   *  false when there is no retryable local recording left to retry. */
  retryNow: (meetingId: string) => boolean;
}

interface MeetingCaptureInputs {
  uid: string | null;
  appHidden: boolean;
  events: UpcomingMeeting[];
  isArmed: (eventId: string) => boolean;
  /** Arm-state revision counter so watch scheduling reruns on toggles. */
  armRevision: number;
  /** Temporary test mode. Eligible calendar meetings are watched without the
   * persisted arm decision. Keep the arm inputs intact for the consent gate. */
  automaticCapture?: boolean;
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
  const { uid, appHidden, events, isArmed, armRevision, automaticCapture = false } = inputs;
  const signedIn = uid !== null;

  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [capBlocked, setCapBlocked] = useState(false);
  const [activities, setActivities] = useState<MeetingActivity[]>([]);
  const [ownsRuntime, setOwnsRuntime] = useState(false);
  const runtimeStatusRef = useRef<MeetingRuntimeStatus | null>(null);
  const activitiesRef = useRef(activities);
  activitiesRef.current = activities;

  const eventsRef = useRef(events);
  eventsRef.current = events;
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const appHiddenRef = useRef(appHidden);
  appHiddenRef.current = appHidden;
  const identityEpochRef = useRef(0);
  const isArmedRef = useRef(isArmed);
  isArmedRef.current = isArmed;

  const recordingRef = useRef(false);
  /** event_id -> claimed meeting for this session (rejoins reuse it). */
  const claimsRef = useRef<Map<string, Awaited<ReturnType<typeof claimMeeting>>>>(new Map());
  const captureRunByMeetingRef = useRef<Map<string, string>>(new Map());
  const activeEventRef = useRef<string | null>(null);
  const watchedRef = useRef<Set<string>>(new Set());
  const pumpRunningRef = useRef<{ uid: string; epoch: number } | null>(null);
  const claimInFlightRef = useRef<{ uid: string; epoch: number } | null>(null);
  /** A join re-detected while the previous engine was still flushing; replayed
   * once the capture-state event says the teardown finished. */
  const pendingRejoinRef = useRef<string | null>(null);
  /** Live captures awaiting their end toast. The upload pump may upload audio
   * while this is set, but it cannot hand completion to transcription. */
  const endNotificationPendingRef = useRef<Set<string>>(new Set());

  // A direct A -> B switch never passes through signedIn=false. Treat UID as
  // the state-machine identity and invalidate every account-scoped cache and
  // in-flight generation before the new account schedules work.
  useEffect(() => {
    identityEpochRef.current += 1;
    claimsRef.current.clear();
    captureRunByMeetingRef.current.clear();
    pumpRunningRef.current = null;
    claimInFlightRef.current = null;
    activeEventRef.current = null;
    pendingRejoinRef.current = null;
    endNotificationPendingRef.current.clear();
    recordingRef.current = false;
    setRecording(false);
    setPaused(false);
    setCapBlocked(false);
    setActivities([]);
    for (const eventId of watchedRef.current) {
      void invoke("stop_join_watch", { eventId }).catch(() => undefined);
    }
    watchedRef.current.clear();
    if (uid) {
      void bindMeetingActivityOwner(uid)
        .then((rows) => {
          if (uidRef.current === uid) setActivities(rows);
        })
        .catch((err) => logError("useMeetingCapture: hydrate activity", err));
    }
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    void ensureMeetingNotificationPermission();
  }, [uid]);

  useEffect(() => {
    let disposed = false;
    void invoke<MeetingRuntimeStatus>("meeting_runtime_status")
      .then((status) => {
        if (disposed) return;
        runtimeStatusRef.current = status;
        setOwnsRuntime(status.ownsRuntime);
        logInfo(
          "useMeetingCapture",
          `runtime ${status.ownsRuntime ? "owner" : "passive"} pid=${status.processId}`,
        );
      })
      .catch((err) => {
        if (!disposed) {
          runtimeStatusRef.current = null;
          setOwnsRuntime(false);
          logError("useMeetingCapture: meeting_runtime_status", err);
        }
      });
    return () => {
      disposed = true;
    };
  }, []);

  const recordActivity = useCallback(
    (activity: MeetingActivity) => {
      if (!uid || uidRef.current !== uid) return;
      setActivities((current) => [
        activity,
        ...current.filter((row) => row.meetingId !== activity.meetingId),
      ]);
      void upsertMeetingActivity(uid, activity).catch((err) =>
        logError("useMeetingCapture: persist activity", err),
      );
    },
    [uid],
  );

  // ── Watch scheduling ────────────────────────────────────────────────────
  // Keep Rust's join detector armed for exactly the armed meetings whose
  // watch window is still ahead. Diffed against what's currently watched so
  // toggling one meeting doesn't churn the others.
  useEffect(() => {
    if (!signedIn || !ownsRuntime) {
      for (const eventId of watchedRef.current) {
        void invoke("stop_join_watch", { eventId }).catch(() => undefined);
      }
      watchedRef.current.clear();
      return;
    }
    const now = Date.now();
    const desired = new Map<string, { startMs: number; endMs: number }>();
    for (const event of events) {
      if (!isEligibleForNotes(event) || (!automaticCapture && !isArmed(event.id))) continue;
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
  }, [uid, signedIn, ownsRuntime, events, isArmed, armRevision, automaticCapture]);

  // ── Claim + capture ─────────────────────────────────────────────────────
  const startCaptureFor = useCallback(
    async (eventId: string, title: string, startTime: string, endTime: string) => {
      if (!uid || !ownsRuntime || recordingRef.current || claimInFlightRef.current) return;
      const runtimeStatus = runtimeStatusRef.current;
      if (!runtimeStatus?.ownsRuntime) return;
      const run = { uid, epoch: identityEpochRef.current };
      const isCurrent = () =>
        uidRef.current === run.uid && identityEpochRef.current === run.epoch;
      claimInFlightRef.current = run;
      try {
        let lastError: unknown = null;
        for (let attempt = 0; attempt <= CLAIM_RETRIES; attempt++) {
          try {
            const claim = await claimMeeting({
              eventId,
              title,
              startTime,
              endTime,
              installationId: runtimeStatus.installationId,
              runtimeInstanceId: runtimeStatus.runtimeInstanceId,
            });
            if (!isCurrent()) return;
            claimsRef.current.set(eventId, claim);
            captureRunByMeetingRef.current.set(claim.meetingId, claim.captureRunId);
            activeEventRef.current = eventId;
            endNotificationPendingRef.current.add(claim.meetingId);
            await invoke("start_meeting_capture", {
              meetingId: claim.meetingId,
              captureRunId: claim.captureRunId,
              captureFence: claim.captureFence,
              eventId,
            });
            if (!isCurrent()) return;
            recordActivity({
              meetingId: claim.meetingId,
              captureRunId: claim.captureRunId,
              eventId,
              phase: "recording",
              segmentCount: 0,
              uploadedCount: 0,
              lastAttemptAt: null,
              nextRetryAt: null,
              failureCode: null,
              retryable: false,
              updatedAt: Date.now(),
            });
            trackEvent("meeting_capture_started", { rejoined: claim.rejoined });
            return;
          } catch (err) {
            const claimedMeeting = claimsRef.current.get(eventId);
            if (claimedMeeting && !recordingRef.current) {
              endNotificationPendingRef.current.delete(claimedMeeting.meetingId);
            }
            if (!isCurrent()) return;
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
            if (!isCurrent()) return;
          }
        }
        logError("useMeetingCapture: claim failed after retries", lastError);
      } finally {
        if (claimInFlightRef.current === run) {
          claimInFlightRef.current = null;
        }
      }
    },
    [uid, ownsRuntime, recordActivity],
  );

  const handleJoinDetected = useCallback(
    (eventId: string) => {
      if (!uidRef.current) return;
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
        if (!automaticCapture && !isArmedRef.current(eventId)) return;
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
    [startCaptureFor, automaticCapture],
  );

  const captureNow = useCallback(() => {
    if (!ownsRuntime || recordingRef.current || !uidRef.current) return;
    const eventId = `manual:${crypto.randomUUID()}`;
    const now = new Date();
    trackEvent("meeting_capture_manual", {});
    void startCaptureFor(
      eventId,
      "Manual capture",
      now.toISOString(),
      new Date(now.getTime() + MANUAL_WINDOW_MS).toISOString(),
    );
  }, [ownsRuntime, startCaptureFor]);

  const stopCapture = useCallback(() => {
    if (!recordingRef.current) {
      logInfo("useMeetingCapture", "stop_capture ignored, no active meeting capture");
      return;
    }
    logInfo("useMeetingCapture", "stop_capture requested by user");
    void invoke("stop_meeting_capture", { reason: "stopped_by_user" }).catch((err) =>
      logError("useMeetingCapture: stop_meeting_capture", err),
    );
  }, []);

  const dismissCapBlocked = useCallback(() => setCapBlocked(false), []);

  // ── Upload pump ─────────────────────────────────────────────────────────
  // Drains the durable Rust queue: upload every unsent segment, then send
  // /complete for finished captures (unless a rejoin hold is active), then
  // ack while Rust retains the encrypted recovery copy. Runs on segment-ready,
  // capture end, mount (restart recovery), and a slow interval.
  const pump = useCallback(async () => {
    if (!uid || !ownsRuntime || uidRef.current !== uid || pumpRunningRef.current) return;
    const run = { uid, epoch: identityEpochRef.current };
    const isCurrent = () =>
      uidRef.current === run.uid && identityEpochRef.current === run.epoch;
    pumpRunningRef.current = run;
    try {
      const snapshot = await invoke<QueueSnapshot>("queue_snapshot");
      if (!isCurrent()) return;
      const now = Date.now();
      for (const activity of activitiesRef.current) {
        if (snapshot.captures.some((capture) => capture.meetingId === activity.meetingId)) {
          continue;
        }
        if (!["saved_local", "uploading", "needs_attention"].includes(activity.phase)) {
          continue;
        }
        recordActivity({
          ...activity,
          phase: "failed",
          nextRetryAt: null,
          failureCode: "upload_expired",
          retryable: false,
          updatedAt: now,
        });
      }
      for (const capture of snapshot.captures) {
        if (!isCurrent()) return;
        if (capture.ownerUid !== run.uid) continue;
        captureRunByMeetingRef.current.set(capture.meetingId, capture.captureRunId);
        const uploadedCount = capture.segments.filter((segment) => segment.uploaded).length;
        const attention = [
          "needs_attention",
          "split_brain",
          "local_missing",
          "integrity_failed",
          "capture_failed_integrity",
          // A capture a dead process left behind, released at startup. It is
          // not live, so it must not keep rendering as "recording".
          "capturing_interrupted",
        ].includes(capture.state);
        recordActivity({
          meetingId: capture.meetingId,
          captureRunId: capture.captureRunId,
          eventId: capture.eventId,
          phase: attention
            ? "needs_attention"
            : capture.completionAcked
            ? capture.segments.length > 0
              ? "processing"
              : "failed"
            : capture.completed
            ? uploadedCount < capture.segments.length
              ? "uploading"
              : "saved_local"
            : "recording",
          segmentCount: capture.segments.length,
          uploadedCount,
          lastAttemptAt: null,
          nextRetryAt: capture.nextRetryAtMs,
          failureCode: capture.lastErrorCode,
          retryable: capture.retryable,
          updatedAt: now,
        });
      }

      // The server tells us where its fence is on every stale-fence rejection.
      // Adopting it turns a permanent 409 loop back into ordinary progress; the
      // store refuses a backward move, so a genuine fork still cannot be papered
      // over. Returns true when the run moved and its jobs were re-armed.
      const resyncFence = async (
        lease: QueueJobLease,
        err: unknown,
      ): Promise<boolean> => {
        if (!(err instanceof MeetingTransportError)) return false;
        if (err.code !== "stale_capture_fence") return false;
        if (err.serverCaptureFence === null) return false;
        if (err.serverCaptureFence <= lease.captureFence) return false;
        try {
          const adopted = await invoke<boolean>("adopt_capture_fence", {
            captureRunId: lease.captureRunId,
            captureFence: err.serverCaptureFence,
          });
          if (adopted) {
            logInfo(
              "useMeetingCapture",
              `adopted server capture fence ${err.serverCaptureFence} for ${lease.captureRunId}`,
            );
          }
          return adopted;
        } catch (adoptError) {
          logError("useMeetingCapture: adopt capture fence", adoptError);
          return false;
        }
      };

      const failLease = async (
        lease: QueueJobLease,
        err: unknown,
      ): Promise<MeetingJobFailureClassification> => {
        const failure = err instanceof MeetingTransportError
          ? { classification: err.classification, errorCode: err.code }
          : err instanceof AuthRequiredError
          ? { classification: "auth" as const, errorCode: "auth_required" }
          : { classification: "transient" as const, errorCode: "network_or_client_error" };
        try {
          await invoke("fail_queue_job", {
            jobId: lease.jobId,
            leaseToken: lease.leaseToken,
            classification: failure.classification,
            errorCode: failure.errorCode,
          });
        } catch (commitError) {
          logError(`useMeetingCapture: persist job failure ${lease.jobId}`, commitError);
        }
        if (failure.classification !== "terminal") {
          void notifyLocal(
            {
              type: "meeting_upload_pending",
              severity: "warning",
              title: "A meeting is saved securely",
              body: "Aura could not upload it yet. It will retry automatically.",
              dedupKey: `meeting:${lease.captureRunId}:upload_pending`,
              action: "retry_meeting_upload",
              resourceId: lease.meetingId,
              toastPolicy: "when_hidden",
              sensitive: true,
            },
            { appHidden: appHiddenRef.current, ownerUid: run.uid },
          );
        }
        logError(`useMeetingCapture: ${lease.kind} ${lease.jobId}`, err);
        return failure.classification;
      };

      // "auth" and "paused" are conditions of the whole session: every remaining
      // job would fail identically, so stop the pass. Any other failure belongs
      // to one job and must not stall the ones queued behind it - a single bad
      // segment used to block every other upload and completion.
      const stopsThePass = (classification: MeetingJobFailureClassification) =>
        classification === "auth" || classification === "paused";

      let handled = 0;
      while (isCurrent() && handled < 64) {
        const lease = await invoke<QueueJobLease | null>("claim_next_upload_job");
        if (!lease || !isCurrent()) break;
        handled += 1;
        try {
          if (
            lease.seq === null
            || lease.startMs === null
            || lease.durationMs === null
            || lease.incomplete === null
            || lease.contentSha256 === null
            || lease.byteLength === null
            || lease.channelCount === null
            || lease.sampleRateHz === null
          ) {
            throw new MeetingTransportError(
              "Upload lease is incomplete",
              0,
              "invalid_upload_lease",
              "terminal",
            );
          }
          const raw = await invoke("read_segment", {
            meetingId: lease.meetingId,
            captureRunId: lease.captureRunId,
            seq: lease.seq,
          });
          if (!isCurrent()) return;
          const receipt: UploadReceipt = await uploadSegment({
            jobId: lease.jobId,
            meetingId: lease.meetingId,
            captureRunId: lease.captureRunId,
            captureFence: lease.captureFence,
            seq: lease.seq,
            bytes: asBytes(raw),
            startMs: lease.startMs,
            durationMs: lease.durationMs,
            incomplete: lease.incomplete,
            contentSha256: lease.contentSha256,
            byteLength: lease.byteLength,
            channelCount: lease.channelCount,
            sampleRateHz: lease.sampleRateHz,
          });
          if (!isCurrent()) return;
          await invoke("resolve_upload_job", {
            jobId: lease.jobId,
            leaseToken: lease.leaseToken,
            receipt,
          });
        } catch (err) {
          if (!isCurrent()) return;
          // Resync before recording the failure: a stale fence we can adopt is
          // a disagreement we just resolved, not a fault of this job.
          if (await resyncFence(lease, err)) continue;
          if (stopsThePass(await failLease(lease, err))) break;
        }
      }

      handled = 0;
      while (isCurrent() && handled < 16) {
        const lease = await invoke<QueueJobLease | null>("claim_next_completion_job");
        if (!lease || !isCurrent()) break;
        handled += 1;
        try {
          if (
            lease.manifestSha256 === null
            || lease.segmentCount === null
            || lease.totalDurationMs === null
          ) {
            throw new MeetingTransportError(
              "Completion lease is incomplete",
              0,
              "invalid_completion_lease",
              "terminal",
            );
          }
          const receipt: CompletionReceipt = await completeMeeting({
            jobId: lease.jobId,
            meetingId: lease.meetingId,
            captureRunId: lease.captureRunId,
            captureFence: lease.captureFence,
            segmentCount: lease.segmentCount,
            totalDurationMs: lease.totalDurationMs,
            reason: lease.reason || "ended",
            segmentDigests: lease.segmentDigests,
            manifestSegments: lease.manifestSegments,
            manifestSha256: lease.manifestSha256,
          });
          if (!isCurrent()) return;
          await invoke("resolve_completion_job", {
            jobId: lease.jobId,
            leaseToken: lease.leaseToken,
            receipt,
          });
          recordActivity({
            meetingId: lease.meetingId,
            captureRunId: lease.captureRunId,
            eventId: lease.eventId,
            phase: lease.segmentCount > 0 ? "processing" : "failed",
            segmentCount: lease.segmentCount,
            uploadedCount: lease.segmentCount,
            lastAttemptAt: Date.now(),
            nextRetryAt: null,
            failureCode: lease.segmentCount > 0 ? null : "no_audio",
            retryable: false,
            updatedAt: Date.now(),
          });
          trackEvent("meeting_capture_completed", {
            segments: lease.segmentCount,
            reason: lease.reason || "ended",
          });
        } catch (err) {
          if (!isCurrent()) return;
          // Resync before recording the failure: a stale fence we can adopt is
          // a disagreement we just resolved, not a fault of this job.
          if (await resyncFence(lease, err)) continue;
          if (stopsThePass(await failLease(lease, err))) break;
        }
      }
    } catch (err) {
      if (!isCurrent()) return;
      if (!(err instanceof AuthRequiredError)) {
        logError("useMeetingCapture: pump", err);
      }
    } finally {
      if (pumpRunningRef.current === run) {
        pumpRunningRef.current = null;
      }
    }
  }, [uid, ownsRuntime, recordActivity]);

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
        if (payload.ownerUid !== uidRef.current) return;
        if (payload.active && payload.meetingId) {
          endNotificationPendingRef.current.add(payload.meetingId);
        }
        recordingRef.current = payload.active;
        setRecording(payload.active);
        setPaused(payload.active && payload.paused);
        if (!payload.active) {
          activeEventRef.current = null;
          if (payload.meetingId) {
            if (payload.reason === "meeting_left" && !automaticCapture) {
              // Rust persisted the completion job's rejoin hold. This timer
              // merely wakes the pump near that durable deadline.
              setTimeout(() => void pump(), REJOIN_HOLD_MS + 1000);
            }
            const completedMeetingId = payload.meetingId;
            void sendMeetingCaptureEndedNotification()
              .catch((err) => logError("useMeetingCapture: capture-end notification", err))
              .finally(() => {
                endNotificationPendingRef.current.delete(completedMeetingId);
                void pump();
              });
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
      listen<{ ownerUid: string }>("meeting-segment-ready", (event) => {
        if (event.payload.ownerUid === uidRef.current) void pump();
      }),
      "segment-ready",
    );
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [handleJoinDetected, pump, automaticCapture]);

  // Recording is a per-user consent grant: signing out (or being signed out)
  // must end any live capture immediately, not just stop future watches.
  useEffect(() => {
    if (uid) return;
    pendingRejoinRef.current = null;
    if (recordingRef.current) {
      void invoke("stop_meeting_capture", { reason: "signed_out" }).catch((err) =>
        logError("useMeetingCapture: stop on sign-out", err),
      );
    }
  }, [uid]);

  // Restart recovery + steady drain: seed recording state, then pump on an
  // interval. capture_status covers the race where capture started before
  // the listener mounted (post-crash relaunch cannot have a live capture,
  // but a webview reload during dev can).
  useEffect(() => {
    if (!uid || !ownsRuntime) return;
    void invoke<{
      active: boolean;
      paused: boolean;
      eventId: string | null;
      meetingId: string | null;
    }>("capture_status")
      .then((status) => {
        if (uidRef.current !== uid) return;
        recordingRef.current = status.active;
        setRecording(status.active);
        setPaused(status.active && status.paused);
        activeEventRef.current = status.eventId;
        if (status.active && status.meetingId) {
          endNotificationPendingRef.current.add(status.meetingId);
        }
      })
      .catch((err) => logError("useMeetingCapture: capture_status", err));
    // Re-queue anything a previous session gave up on BEFORE the first pump, so
    // a recording stranded by a one-off conflict resumes on its own rather than
    // waiting for someone to notice it in the recordings list. Once per signed-in
    // session only: the revived jobs go back under ordinary backoff from here.
    void invoke<number>("revive_stranded_captures")
      .then((revived) => {
        if (revived > 0) {
          logInfo("useMeetingCapture", `revived ${revived} stranded capture(s)`);
        }
      })
      .catch((err) => logError("useMeetingCapture: revive stranded", err))
      .finally(() => {
        if (uidRef.current === uid) void pump();
      });
    const id = setInterval(() => void pump(), PUMP_INTERVAL_MS);
    return () => clearInterval(id);
  }, [uid, ownsRuntime, pump]);

  // Dev harness (see meetingDebug.ts).
  useEffect(() => {
    if (!import.meta.env.DEV || !ownsRuntime) return;
    return installMeetingDebug({ captureNow, stopCapture, pump: () => void pump() });
  }, [ownsRuntime, captureNow, stopCapture, pump]);

  const retryNow = useCallback(
    (meetingId: string): boolean => {
      const activity = activities.find((row) => row.meetingId === meetingId);
      if (!activity?.retryable || !uid) return false;
      const captureRunId =
        activity.captureRunId ?? captureRunByMeetingRef.current.get(meetingId);
      if (!captureRunId) return false;
      recordActivity({
        ...activity,
        phase: activity.uploadedCount > 0 ? "uploading" : "saved_local",
        nextRetryAt: null,
        failureCode: null,
        retryable: false,
        updatedAt: Date.now(),
      });
      trackEvent("meeting_upload_attempt", { retry_now: true });
      void invoke<boolean>("retry_capture_jobs", { captureRunId })
        .then((changed) => {
          if (changed) void pump();
        })
        .catch((err) => logError("useMeetingCapture: retry_capture_jobs", err));
      return true;
    },
    [activities, uid, recordActivity, pump],
  );

  return {
    recording,
    paused,
    capBlocked,
    dismissCapBlocked,
    captureNow,
    stopCapture,
    activities,
    retryNow,
  };
}
