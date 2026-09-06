import { useEffect, useRef } from "react";
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
 *  - **Nightly**, in a jittered 03:00 window: the bulk drain of new traces.
 *    Uploading speech audio is deferrable work with no deadline, and the
 *    standard shape for that is one scheduled wake under network and battery
 *    constraints rather than a poll.
 *  - **Hourly**: retries only, for rows already attempted and now due. Without
 *    it the first five steps of the backoff table (30s through 2h) are all
 *    shorter than the gap between windows and collapse into "try again
 *    tomorrow", so a five-second network blip costs a whole day.
 *
 * Rust owns the queue, the backoff and the persisted attempt counts, so this
 * hook holds no durable state. Missing a tick costs nothing.
 */

/** Local hour the nightly window opens, and how long it stays open. */
const WINDOW_START_HOUR = 3;
const WINDOW_HOURS = 1;

/** How often to consider doing anything. Cheap: a clock comparison, and at most
 * once an hour one Rust call that counts rows off a covering index. */
const TICK_MS = 5 * 60 * 1000;

/** Ceiling for the nightly bulk drain, comfortably inside the backend's
 * 500/month cap while still clearing a large backlog in a few nights. */
const MAX_PER_NIGHT = 100;
/** Ceiling for an hourly retry sweep. Small on purpose: it exists to recover
 * from a blip, not to become a second uploader. */
const MAX_PER_RETRY_SWEEP = 10;

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

/** Per-install offset so every client does not hit the backend at 03:00:00
 * exactly. Persisted, because a fresh offset each launch would defeat it. */
const JITTER_KEY = "dictationShareJitterMs";

function installJitterMs(): number {
  try {
    const stored = globalThis.localStorage?.getItem(JITTER_KEY);
    if (stored) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    const fresh = Math.floor(Math.random() * WINDOW_HOURS * 60 * 60 * 1000);
    globalThis.localStorage?.setItem(JITTER_KEY, String(fresh));
    return fresh;
  } catch {
    return 0;
  }
}

function windowIsOpen(jitterMs: number): boolean {
  const now = new Date();
  const start = new Date(now);
  start.setHours(WINDOW_START_HOUR, 0, 0, 0);
  const open = start.getTime() + jitterMs;
  return now.getTime() >= open && now.getTime() < open + WINDOW_HOURS * 60 * 60 * 1000;
}

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
async function uploadBlockedBy(): Promise<string | null> {
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
    } catch {
      // No battery information is not an objection.
    }
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

export function useDictationUpload(ownerUid: string | null, sharing: boolean): void {
  const runningRef = useRef(false);
  const lastNightlyDayRef = useRef<string | null>(null);
  const lastRetryHourRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ownerUid) return;
    const jitterMs = installJitterMs();
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
      const state = await sharePumpState(uid, sharing);
      const cap = retriesOnly ? MAX_PER_RETRY_SWEEP : MAX_PER_NIGHT;

      // Deletions first, and regardless of `sharing`: withdrawing consent
      // creates an obligation to remove what was already sent, and the switch
      // that created it being off must not block discharging it. Sequential,
      // because there are rarely more than a handful. Nightly only: a retry
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

      if (sharing && state.pendingUploads > 0) {
        const budget = Math.min(cap, state.pendingUploads);
        let stop = false;
        await pool(budget, CONCURRENCY, async () => {
          if (cancelled || stop) return;
          const lease = await claimTraceUpload(uid, retriesOnly);
          if (!lease) {
            stop = true;
            return;
          }
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
      }

      outcome.durationMs = Date.now() - startedAt;
      // Persisted before reporting: counters outlive the 200-line log tail,
      // which one busy night would otherwise flush entirely. The Rust side logs
      // the one summary line.
      await recordShareDrain(uid, outcome).catch((err) =>
        logError("useDictationUpload: record drain", err),
      );
      // Counts and durations only. No trace id and no text: this leaves the
      // device, and telemetry never carries content.
      trackEvent("desktop_dictation_share_drain", {
        mode: retriesOnly ? "retry" : "nightly",
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
      const today = now.toDateString();
      const thisHour = `${today}:${now.getHours()}`;
      const nightlyDue = windowIsOpen(jitterMs) && lastNightlyDayRef.current !== today;
      const retryDue = !nightlyDue && lastRetryHourRef.current !== thisHour;
      if (!nightlyDue && !retryDue) return;

      const blockedBy = await uploadBlockedBy();
      if (blockedBy) {
        // Named, because "offline", "on a hotspot" and "battery low" used to be
        // indistinguishable from "nothing to do".
        logError("useDictationUpload: drain skipped", new Error(blockedBy));
        return;
      }

      runningRef.current = true;
      if (nightlyDue) lastNightlyDayRef.current = today;
      else lastRetryHourRef.current = thisHour;
      try {
        await drain(ownerUid, !nightlyDue);
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
