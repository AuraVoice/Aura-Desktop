import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MEETING_CALL_GONE,
  MEETING_CAPTURE_STATE,
  MEETING_SEGMENT_READY,
  type AmbientCallPayload,
  type AmbientGonePayload,
} from "../lib/ipcEvents";
import type { UpcomingMeeting } from "../lib/calendar";
import { callLabel } from "../lib/meetingCopy";
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

/** What a Record press led to, so the prompt card can say so. "skipped" is a
 * guard exit (already recording, runtime not owned, account changed). */
export type RecordCallOutcome = "started" | "cap" | "failed" | "skipped";

export interface MeetingCaptureState {
  /** This process owns the meeting runtime lease (detection + capture). */
  ownsRuntime: boolean;
  /** A capture is running right now (drives the bar's recording dot). */
  recording: boolean;
  /** Capture paused because the session is locked. */
  paused: boolean;
  /** The monthly cap blocked the last claim (drives the caption + Upgrade). */
  capBlocked: boolean;
  dismissCapBlocked: () => void;
  /** Manual "Capture this call" entry from the tray, for calls the scanner
   * does not know. Sets no call key, so a call going away never stops it. */
  captureNow: () => void;
  /** The "Record this meeting?" card's Record button: attaches to `event`
   * when the call overlaps an eligible calendar meeting, else a manual
   * capture labelled with the app. The capture stops when that call's
   * `meeting-call-gone` arrives. */
  recordCall: (
    call: AmbientCallPayload,
    event: UpcomingMeeting | null,
  ) => Promise<RecordCallOutcome>;
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
}

/**
 * The claim -> capture -> upload -> complete state machine. Nothing here
 * starts a capture on its own: every one begins with a press, either the
 * notch's "Record this meeting?" card (`recordCall`, fed by the ambient
 * scanner via useMeetingPrompt) or the tray's Capture now (`captureNow`).
 * Rust captures; this hook owns every HTTP leg (claim, segment upload,
 * complete) because tokens live in JS. Mounted once in OverlayRoot, alive
 * regardless of presentation, like useMeetings.
 *
 * Every failure path here is silent to the user except the monthly cap
 * (a plan state, surfaced with an Upgrade pointer, mirroring the voice cap)
 * and a Record press, whose outcome the card reports.
 */
export function useMeetingCapture(inputs: MeetingCaptureInputs): MeetingCaptureState {
  const { uid, appHidden } = inputs;

  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [capBlocked, setCapBlocked] = useState(false);
  const [activities, setActivities] = useState<MeetingActivity[]>([]);
  const [ownsRuntime, setOwnsRuntime] = useState(false);
  const runtimeStatusRef = useRef<MeetingRuntimeStatus | null>(null);
  const activitiesRef = useRef(activities);
  activitiesRef.current = activities;

  const uidRef = useRef(uid);
  uidRef.current = uid;
  const appHiddenRef = useRef(appHidden);
  appHiddenRef.current = appHidden;
  const identityEpochRef = useRef(0);

  const recordingRef = useRef(false);
  /** event_id -> claimed meeting for this session (rejoins reuse it). */
  const claimsRef = useRef<Map<string, Awaited<ReturnType<typeof claimMeeting>>>>(new Map());
  const captureRunByMeetingRef = useRef<Map<string, string>>(new Map());
  const activeEventRef = useRef<string | null>(null);
  /** The ambient call the live capture was started for (null for a tray
   * capture). Its `meeting-call-gone` is what stops the capture. */
  const activeCallKeyRef = useRef<string | null>(null);
  const pumpRunningRef = useRef<{ uid: string; epoch: number } | null>(null);
  const claimInFlightRef = useRef<{ uid: string; epoch: number } | null>(null);
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
    activeCallKeyRef.current = null;
    endNotificationPendingRef.current.clear();
    recordingRef.current = false;
    setRecording(false);
    setPaused(false);
    setCapBlocked(false);
    setActivities([]);
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

  // ── Claim + capture ─────────────────────────────────────────────────────
  const startCaptureFor = useCallback(
    async (
      eventId: string,
      title: string,
      startTime: string,
      endTime: string,
    ): Promise<RecordCallOutcome> => {
      if (!uid || !ownsRuntime || recordingRef.current || claimInFlightRef.current) {
        return "skipped";
      }
      const runtimeStatus = runtimeStatusRef.current;
      if (!runtimeStatus?.ownsRuntime) return "skipped";
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
            if (!isCurrent()) return "skipped";
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
            if (!isCurrent()) return "skipped";
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
            return "started";
          } catch (err) {
            const claimedMeeting = claimsRef.current.get(eventId);
            if (claimedMeeting && !recordingRef.current) {
              endNotificationPendingRef.current.delete(claimedMeeting.meetingId);
            }
            if (!isCurrent()) return "skipped";
            if (err instanceof MeetingCapError) {
              setCapBlocked(true);
              trackEvent("meeting_cap_blocked", {
                seconds_until_reset: err.secondsUntilReset ?? -1,
              });
              return "cap";
            }
            if (err instanceof MeetingClaimConflictError) {
              logInfo("useMeetingCapture", "claim conflict: another device is capturing");
              return "failed";
            }
            if (err instanceof AuthRequiredError) return "failed";
            lastError = err;
            await new Promise((resolve) => setTimeout(resolve, 5000 * (attempt + 1)));
            if (!isCurrent()) return "skipped";
          }
        }
        logError("useMeetingCapture: claim failed after retries", lastError);
        return "failed";
      } finally {
        if (claimInFlightRef.current === run) {
          claimInFlightRef.current = null;
        }
      }
    },
    [uid, ownsRuntime, recordActivity],
  );

  const recordCall = useCallback(
    async (
      call: AmbientCallPayload,
      event: UpcomingMeeting | null,
    ): Promise<RecordCallOutcome> => {
      if (!ownsRuntime || recordingRef.current || !uidRef.current) return "skipped";
      activeCallKeyRef.current = call.callKey;
      let outcome: RecordCallOutcome;
      if (event) {
        outcome = await startCaptureFor(event.id, event.title, event.startTime, event.endTime);
      } else {
        // Same claim shape as the tray path: the backend validates the
        // `manual:` prefix, so an ad-hoc call is a manual capture that
        // happens to carry the app's name.
        const now = new Date();
        outcome = await startCaptureFor(
          `manual:${crypto.randomUUID()}`,
          callLabel(call.app),
          now.toISOString(),
          new Date(now.getTime() + MANUAL_WINDOW_MS).toISOString(),
        );
      }
      if (outcome !== "started" && activeCallKeyRef.current === call.callKey) {
        activeCallKeyRef.current = null;
      }
      return outcome;
    },
    [ownsRuntime, startCaptureFor],
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
      listen<AmbientGonePayload>(MEETING_CALL_GONE, (event) => {
        if (
          activeCallKeyRef.current !== null
          && activeCallKeyRef.current === event.payload.callKey
        ) {
          void invoke("stop_meeting_capture", { reason: "meeting_left" }).catch((err) =>
            logError("useMeetingCapture: stop on meeting-call-gone", err),
          );
        }
      }),
      "meeting-call-gone",
    );
    add(
      listen<CaptureStatePayload>(MEETING_CAPTURE_STATE, (event) => {
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
          activeCallKeyRef.current = null;
          if (payload.meetingId) {
            if (payload.reason === "meeting_left") {
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
        }
      }),
      "capture-state",
    );
    add(
      listen<{ ownerUid: string }>(MEETING_SEGMENT_READY, (event) => {
        if (event.payload.ownerUid === uidRef.current) void pump();
      }),
      "segment-ready",
    );
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [pump]);

  // Recording is a per-user consent grant: signing out (or being signed out)
  // must end any live capture immediately, not just stop future watches.
  useEffect(() => {
    if (uid) return;
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
    ownsRuntime,
    recording,
    paused,
    capBlocked,
    dismissCapBlocked,
    captureNow,
    recordCall,
    stopCapture,
    activities,
    retryNow,
  };
}
