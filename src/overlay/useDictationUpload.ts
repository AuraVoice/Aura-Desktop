import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  claimTraceDeletion,
  claimTraceUpload,
  classifyUploadFailure,
  deleteRemoteTrace,
  failTraceDeletion,
  failTraceUpload,
  pauseTraceUploads,
  recordShareDrain,
  resolveTraceDeletion,
  resolveTraceUpload,
  sharePumpState,
  uploadTrace,
  type DrainOutcome,
} from "../lib/dictationUpload";
import { logError } from "../lib/log";
import { trackEvent } from "../lib/analytics";

/**
 * Drains the dictation sharing queue.
 *
 * Two cadences, because there are two different jobs:
 *
 *  - **Bulk**, whenever the machine is idle and on power: the drain of new
 *    traces. Uploading speech audio is deferrable work with no deadline, and
 *    the right moment for it is "the user has stepped away and the laptop is
 *    plugged in", not a clock time. The previous design used a jittered 03:00
 *    window, and production held zero traces after weeks of it: the laptop
 *    was asleep at 03:00 every night, and the catch-up path only ran once a
 *    day had passed without a drain, which a machine that sleeps nightly and
 *    is used all day never quite reaches. Idle plus power is a condition the
 *    machine is actually in for hours every day.
 *  - **Hourly**: retries only, for rows already attempted and now due. Without
 *    it the first five steps of the backoff table (30s through 2h) would
 *    collapse into "try again at the next idle", so a five-second network
 *    blip could cost hours.
 *
 * Neither runs while a call, a meeting recording or an interview is live:
 * FLAC uploads must not take bandwidth from audio the user is in the middle of.
 *
 * Rust owns the queue, the backoff and the persisted attempt counts, so this
 * hook holds no durable state. Missing a tick costs nothing.
 */

/** How often to consider doing anything. Cheap: two kernel calls for the idle
 * time, a battery read, and at most one Rust call that counts rows off a
 * covering index. */
const TICK_MS = 5 * 60 * 1000;

/** How long the user must have been away before a bulk drain starts. Long
 * enough that a coffee refill does not trigger it, short enough that a lunch
 * break always does. */
const IDLE_BEFORE_BULK_MS = 5 * 60 * 1000;

/** Ceiling for one bulk drain, comfortably inside the backend's 500/month cap
 * while still clearing a large backlog in a couple of idle periods. */
const MAX_PER_BULK = 100;
/** Ceiling for an hourly retry sweep. Small on purpose: it exists to recover
 * from a blip, not to become a second uploader. */
const MAX_PER_RETRY_SWEEP = 10;

/** A bulk drain that found work is followed by another one after this gap
 * while the conditions hold, so a large backlog drains across one idle
 * period rather than one per day. */
const BULK_REPEAT_MS = 10 * 60 * 1000;

/**
 * How many traces upload at once.
 *
 * Three, and the number is load-bearing rather than taste. Every metadata PUT
 * runs a Firestore transaction against the SAME per-user monthly quota
 * document, and a hot document under concurrent transactions is what produces
 * "ABORTED: Too much contention". Three is enough to hide most of the latency
 * and far enough below the contention threshold to stay uninteresting. The
 * audio PUT touches only per-trace documents and GCS, so it is never the
 * constraint.
 */
const CONCURRENCY = 3;

/**
 * Why the machine will not upload right now, or null when it will.
 *
 * Returns a reason rather than a boolean so the refusal is nameable in a log.
 * Every arm used to return silently, which made "offline", "on a hotspot" and
 * "battery is low" indistinguishable from "there was nothing to do".
 *
 * Feature-detected throughout: these APIs are optional, and a missing one must
 * read as "no objection", never as a block that disables sharing forever.
 */
async function uploadBlockedBy(busy: boolean, bulk: boolean): Promise<string | null> {
  if (busy) return "busy";
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";

  const connection = (
    navigator as unknown as {
      connection?: { type?: string; saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (connection?.saveData === true) return "save_data";
  if (connection?.type === "cellular") return "cellular";
  // 2g/slow-2g means a tethered or badly degraded link; several MB of FLAC is
  // not something to push over it.
  if (connection?.effectiveType === "2g" || connection?.effectiveType === "slow-2g") {
    return "slow_network";
  }

  const getBattery = (
    navigator as unknown as { getBattery?: () => Promise<{ charging: boolean; level: number }> }
  ).getBattery;
  if (typeof getBattery === "function") {
    try {
      const battery = await getBattery.call(navigator);
      if (!battery.charging && battery.level < 0.2) return "low_battery";
      // A bulk drain waits for power. A desktop with no battery reports
      // charging: true from this API, so it is never blocked here; a laptop
      // on battery is, however full it is, because the user did not choose to
      // spend that charge on our uploads.
      if (bulk && !battery.charging) return "on_battery";
    } catch {
      // No battery information is not an objection.
    }
  }

  if (bulk) {
    // Idle time comes from Rust (GetLastInputInfo). `null` means the platform
    // could not say, which reads as "no objection": failing closed here is
    // exactly the 03:00 mistake in a new costume.
    let idleMs: number | null = null;
    try {
      idleMs = await invoke<number | null>("system_idle_ms");
    } catch {
      idleMs = null;
    }
    if (idleMs !== null && idleMs < IDLE_BEFORE_BULK_MS) return "not_idle";
  }
  return null;
}

/**
 * Runs `worker` up to `count` times with at most `limit` in flight.
 *
 * Settles every lane rather than failing fast: these are unrelated uploads that
 * merely share a drain, so one rejection must never cancel its siblings.
 */
async function pool(count: number, limit: number, worker: () => Promise<void>): Promise<void> {
  let started = 0;
  const lanes = Array.from({ length: Math.min(limit, count) }, async () => {
    while (started < count) {
      started += 1;
      try {
        await worker();
      } catch (err) {
        // The worker handles its own failures; this is the backstop that keeps
        // one escaped throw from killing a whole lane.
        logError("useDictationUpload: worker escaped", err);
      }
    }
  });
  await Promise.allSettled(lanes);
}

export function useDictationUpload(
  ownerUid: string | null,
  sharing: boolean,
  busy: boolean,
): void {
  const runningRef = useRef(false);
  // A ref, so a call starting or ending does not tear down and restart the
  // pump's timer; the tick reads the latest value when it runs.
  const busyRef = useRef(busy);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);
  const lastSkipReasonRef = useRef<string | null>(null);
  const lastBulkAtRef = useRef<number>(0);
  const lastRetryHourRef = useRef<string | null>(null);

  // Rust needs the consent verdict at hold time (to park a read-back baseline
  // and hand the utterance to the observer) without an IPC round trip on the
  // dictation worker. Told on mount and on every change; the pump's own state
  // call repeats it every tick as a backstop.
  useEffect(() => {
    invoke("dictation_set_sharing", { sharing }).catch((err) =>
      logError("useDictationUpload: set sharing hint", err),
    );
  }, [sharing]);

  useEffect(() => {
    if (!ownerUid) return;
    let cancelled = false;

    async function drain(uid: string, retriesOnly: boolean): Promise<void> {
      const startedAt = Date.now();
      const outcome: DrainOutcome = {
        uploaded: 0,
        failedTerminal: 0,
        failedRetryable: 0,
        skipped: 0,
        deleted: 0,
        durationMs: 0,
        lastErrorReason: null,
      };
      // One cheap read decides whether there is anything to do at all, and folds
      // a newly-eligible backlog into the queue so turning sharing on needs no
      // separate signal.
      const state = await sharePumpState(uid, sharing, retriesOnly);
      const cap = retriesOnly ? MAX_PER_RETRY_SWEEP : MAX_PER_BULK;

      // Deletions first, and regardless of `sharing`: withdrawing consent
      // creates an obligation to remove what was already sent, and the switch
      // that created it being off must not block discharging it. Sequential,
      // because there are rarely more than a handful. Bulk only: a retry
      // sweep exists to recover an upload, not to re-walk this queue.
      if (!retriesOnly) {
        const deletions = Math.min(cap, state.pendingDeletions);
        for (let i = 0; i < deletions; i += 1) {
          if (cancelled) return;
          const traceId = await claimTraceDeletion(uid);
          if (!traceId) break;
          try {
            await deleteRemoteTrace(traceId, uid);
            await resolveTraceDeletion(uid, traceId);
            outcome.deleted += 1;
          } catch (err) {
            const failure = classifyUploadFailure(err);
            outcome.lastErrorReason = `delete_${failure.retryable ? "retryable" : "terminal"}`;
            await failTraceDeletion(uid, traceId).catch((e) =>
              logError("useDictationUpload: record deletion failure", e),
            );
            // Keep going: one undeletable copy is not a reason to abandon the
            // others, and certainly not a reason to abandon the uploads below.
            if (failure.signedOut || !failure.retryable) break;
          }
        }
      }

      if (sharing && retriesOnly && state.pendingUploads === 0 && state.pendingNew > 0) {
        // Not idle: new dictations are waiting for an idle, on-power moment.
        outcome.lastErrorReason = "awaiting_idle";
      }

      if (sharing && state.pendingUploads > 0) {
        const budget = Math.min(cap, state.pendingUploads);
        let stop = false;
        let claimed = 0;
        await pool(budget, CONCURRENCY, async () => {
          if (cancelled || stop) return;
          const lease = await claimTraceUpload(uid, retriesOnly);
          if (!lease) {
            stop = true;
            return;
          }
          claimed += 1;
          try {
            await uploadTrace(lease, uid);
            await resolveTraceUpload(uid, lease.traceId);
            outcome.uploaded += 1;
          } catch (err) {
            const failure = classifyUploadFailure(err);
            if (failure.signedOut) {
              // Not this row's fault, so it must not cost this row an attempt.
              outcome.lastErrorReason = "signed_out";
              stop = true;
              return;
            }
            if (failure.quotaResetAtMs !== null) {
              // About the account, not this dictation: pause rather than burn an
              // attempt on every queued row.
              outcome.lastErrorReason = "quota";
              if (await pauseTraceUploads(uid, failure.quotaResetAtMs)) {
                stop = true;
                return;
              }
            }
            await failTraceUpload(uid, lease.traceId, failure.retryable);
            if (failure.retryable) {
              outcome.failedRetryable += 1;
              outcome.lastErrorReason = "upload_retryable";
              // Transient means the whole run is affected, not just this row.
              stop = true;
            } else {
              // Terminal is about THIS row - a burned id, a payload the server
              // will never accept - so the rest of the queue is unaffected and
              // stopping would strand it behind a row that can never succeed.
              outcome.failedTerminal += 1;
              outcome.lastErrorReason = "upload_terminal";
            }
          }
        });
        // Work was counted and none could be claimed. The count and the claim
        // share one WHERE, so this names a real disagreement instead of logging
        // a healthy empty drain, which is how this queue once hid for weeks.
        if (claimed === 0 && !cancelled && outcome.lastErrorReason === null) {
          outcome.lastErrorReason = "claim_empty";
        }
      }

      outcome.durationMs = Date.now() - startedAt;
      // Persisted before reporting: counters outlive the 200-line log tail,
      // which one busy drain would otherwise flush entirely. The Rust side logs
      // the one summary line.
      await recordShareDrain(uid, outcome).catch((err) =>
        logError("useDictationUpload: record drain", err),
      );
      // Counts and durations only. No trace id and no text: this leaves the
      // device, and telemetry never carries content.
      trackEvent("desktop_dictation_share_drain", {
        mode: retriesOnly ? "retry" : "bulk",
        uploaded: outcome.uploaded,
        failed_terminal: outcome.failedTerminal,
        failed_retryable: outcome.failedRetryable,
        deleted: outcome.deleted,
        duration_ms: outcome.durationMs,
      });
    }

    async function tick(): Promise<void> {
      if (runningRef.current || cancelled || !ownerUid) return;

      const now = new Date();
      const thisHour = `${now.toDateString()}:${now.getHours()}`;
      // A bulk drain is considered on every tick once the previous one is far
      // enough behind; whether it actually runs is decided by the machine's
      // state below, not by the clock.
      const bulkDue = now.getTime() - lastBulkAtRef.current >= BULK_REPEAT_MS;
      const retryDue = lastRetryHourRef.current !== thisHour;
      if (!bulkDue && !retryDue) return;

      // Bulk needs idle and power; a retry sweep needs only the network and
      // battery floor, because it moves at most ten small rows.
      const bulkBlockedBy = bulkDue ? await uploadBlockedBy(busyRef.current, true) : "not_due";
      const runBulk = bulkBlockedBy === null;
      if (!runBulk && !retryDue) {
        // Named, because "offline", "on a hotspot" and "still in use" used to
        // be indistinguishable from "nothing to do". Once per reason: a tick
        // every five minutes repeated it until it filled the log tail.
        if (lastSkipReasonRef.current !== bulkBlockedBy) {
          lastSkipReasonRef.current = bulkBlockedBy;
          logError("useDictationUpload: bulk drain skipped", new Error(bulkBlockedBy));
        }
        return;
      }
      if (!runBulk) {
        const retryBlockedBy = await uploadBlockedBy(busyRef.current, false);
        if (retryBlockedBy) {
          if (lastSkipReasonRef.current !== retryBlockedBy) {
            lastSkipReasonRef.current = retryBlockedBy;
            logError("useDictationUpload: retry sweep skipped", new Error(retryBlockedBy));
          }
          return;
        }
      }
      lastSkipReasonRef.current = null;

      runningRef.current = true;
      if (runBulk) lastBulkAtRef.current = now.getTime();
      else lastRetryHourRef.current = thisHour;
      try {
        await drain(ownerUid, !runBulk);
      } catch (err) {
        // The drain handles per-item failures itself; anything reaching here is
        // the pump failing as a whole, which must not stop future ticks.
        logError("useDictationUpload: drain", err);
      } finally {
        runningRef.current = false;
      }
    }

    const timer = setInterval(() => void tick(), TICK_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ownerUid, sharing]);
}
