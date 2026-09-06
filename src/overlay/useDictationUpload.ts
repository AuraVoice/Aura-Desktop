import { useEffect, useRef } from "react";
import {
  claimTraceDeletion,
  claimTraceUpload,
  classifyUploadFailure,
  deleteRemoteTrace,
  failTraceDeletion,
  failTraceUpload,
  pauseTraceUploads,
  resolveTraceDeletion,
  resolveTraceUpload,
  sharePumpState,
  uploadTrace,
} from "../lib/dictationUpload";
import { logError } from "../lib/log";

/**
 * Drains the dictation sharing queue once a night.
 *
 * The retired trace uploader ticked every 60 seconds. This does not: uploading
 * speech audio is deferrable work with no deadline, and the standard shape for
 * that is one scheduled wake under network and battery constraints rather than
 * a poll. Coalescing into a single nightly drain is also what keeps a laptop
 * from paying for this in radio wakeups it did not ask for.
 *
 * Rust owns the queue, the backoff and the persisted attempt counts, so this
 * hook holds no durable state. Missing a night costs nothing: the queue is on
 * disk and the next window picks it up.
 */

/** Local hour the window opens, and how long it stays open. */
const WINDOW_START_HOUR = 3;
const WINDOW_HOURS = 1;

/** How often to check whether the window is open. Cheap: a clock comparison
 * plus, inside the window, one Rust call that counts rows. */
const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Ceiling per night. Comfortably inside the backend's 500/month cap while
 * still clearing a large backlog in a few nights. */
const MAX_PER_NIGHT = 100;

/** Per-install offset so every client does not hit the backend at 03:00:00
 * exactly. Persisted, because a fresh offset each launch would defeat it. */
const JITTER_KEY = "dictationShareJitterMs";

function installJitterMs(): number {
  try {
    // Guarded rather than assumed: this runs in the overlay webview, but the
    // hook is also mounted under test where localStorage may be absent, and a
    // throw here would take the whole pump down for a cosmetic offset.
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

/** Whether the local clock is inside tonight's window for this install. */
function windowIsOpen(jitterMs: number): boolean {
  const now = new Date();
  const start = new Date(now);
  start.setHours(WINDOW_START_HOUR, 0, 0, 0);
  const open = start.getTime() + jitterMs;
  return now.getTime() >= open && now.getTime() < open + WINDOW_HOURS * 60 * 60 * 1000;
}

/**
 * Whether the machine is in a state where uploading audio is polite.
 *
 * Feature-detected throughout: WebView2 is Chromium, but these APIs are
 * optional and a missing one must read as "no objection", never as a block that
 * silently disables sharing forever.
 */
async function conditionsAllowUpload(): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return false;

  const connection = (
    navigator as unknown as {
      connection?: { type?: string; saveData?: boolean; effectiveType?: string };
    }
  ).connection;
  if (connection?.saveData === true) return false;
  if (connection?.type === "cellular") return false;
  // 2g/slow-2g means a tethered or badly degraded link; several MB of FLAC is
  // not something to push over it.
  if (connection?.effectiveType === "2g" || connection?.effectiveType === "slow-2g") {
    return false;
  }

  const getBattery = (
    navigator as unknown as { getBattery?: () => Promise<{ charging: boolean; level: number }> }
  ).getBattery;
  if (typeof getBattery === "function") {
    try {
      const battery = await getBattery.call(navigator);
      if (!battery.charging && battery.level < 0.2) return false;
    } catch {
      // No battery information is not an objection.
    }
  }
  return true;
}

export function useDictationUpload(ownerUid: string | null, sharing: boolean): void {
  const runningRef = useRef(false);
  const lastRunDayRef = useRef<string | null>(null);

  useEffect(() => {
    if (!ownerUid) return;
    const jitterMs = installJitterMs();
    let cancelled = false;

    async function drain(uid: string): Promise<void> {
      // One cheap read decides whether there is anything to do at all. It also
      // folds a newly-eligible backlog into the queue, so turning sharing on
      // does not need its own signal.
      const state = await sharePumpState(uid, sharing);

      // Deletions first, and regardless of `sharing`: withdrawing consent
      // creates an obligation to remove what was already sent, and that must
      // not be blocked by the switch that created it being off. The count is a
      // snapshot, so it bounds the loop rather than gating it - the real
      // terminator is claimTraceDeletion running out of work.
      const deletions = Math.min(MAX_PER_NIGHT, state.pendingDeletions);
      for (let i = 0; i < deletions; i += 1) {
        if (cancelled) return;
        const traceId = await claimTraceDeletion(uid);
        if (!traceId) break;
        try {
          await deleteRemoteTrace(traceId, uid);
          await resolveTraceDeletion(uid, traceId);
        } catch (err) {
          const failure = classifyUploadFailure(err);
          // Record the attempt so this row backs off instead of being
          // re-claimed on the next pass. Then keep going: one undeletable copy
          // is not a reason to abandon the others, and it is certainly not a
          // reason to abandon the uploads below, which is what returning here
          // used to do.
          await failTraceDeletion(uid, traceId).catch((e) =>
            logError("useDictationUpload: record deletion failure", e),
          );
          if (failure.signedOut || !failure.retryable) break;
        }
      }

      if (!sharing) return;

      // Bounded by what is actually queued as well as by the nightly ceiling,
      // so an empty queue costs zero claim round trips.
      const uploads = Math.min(MAX_PER_NIGHT, state.pendingUploads);
      for (let sent = 0; sent < uploads; sent += 1) {
        if (cancelled) return;
        const lease = await claimTraceUpload(uid);
        if (!lease) return;
        try {
          await uploadTrace(lease, uid);
          await resolveTraceUpload(uid, lease.traceId);
        } catch (err) {
          const failure = classifyUploadFailure(err);
          if (failure.signedOut) {
            // Not this row's fault, so it must not cost this row an attempt.
            // Burning one per night while signed out would permanently FAIL a
            // healthy dictation in eight nights.
            return;
          }
          if (failure.quotaResetAtMs !== null) {
            // A quota refusal is about the account, not this dictation, so it
            // pauses the queue instead of burning an attempt on every row.
            const paused = await pauseTraceUploads(uid, failure.quotaResetAtMs);
            if (paused) return;
          }
          await failTraceUpload(uid, lease.traceId, failure.retryable);
          // Per-item vs systemic. A 409/400/413/422 is about THIS row - a burned
          // trace id, a payload the server will never accept - so the rest of
          // the queue is unaffected and stopping would strand it behind a row
          // that can never succeed. Anything transient (5xx, offline, TLS) is
          // about the whole run, so stop and let the backoff handle it.
          if (failure.retryable) return;
        }
      }
    }

    async function tick(): Promise<void> {
      if (runningRef.current || cancelled || !ownerUid) return;
      if (!windowIsOpen(jitterMs)) return;
      // One drain per calendar day. Without this the window would re-fire every
      // five minutes for the hour it is open.
      const today = new Date().toDateString();
      if (lastRunDayRef.current === today) return;
      if (!(await conditionsAllowUpload())) return;

      runningRef.current = true;
      lastRunDayRef.current = today;
      try {
        await drain(ownerUid);
      } catch (err) {
        logError("useDictationUpload: drain", err);
      } finally {
        runningRef.current = false;
      }
    }

    const timer = setInterval(() => void tick(), CHECK_INTERVAL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ownerUid, sharing]);
}
