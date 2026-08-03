import { useEffect, useRef } from "react";
import { logError } from "../lib/log";
import {
  claimTraceDeletion,
  claimTraceUpload,
  classifyUploadFailure,
  deleteRemoteTrace,
  failTraceUpload,
  pauseTraceUploads,
  resolveTraceDeletion,
  resolveTraceUpload,
  sharePumpState,
  uploadTrace,
} from "../lib/dictationUpload";

/**
 * Drains the dictation trace sharing queue.
 *
 * Mounted by OverlayRoot rather than by the dashboard because the overlay is
 * always running and the dashboard usually is not — a queue that only drains
 * while a settings page happens to be open is not a queue.
 *
 * Everything about *what* to send and *when to retry* lives in Rust
 * (`dictation/trace/upload.rs`); this only performs the HTTP, because the
 * Firebase ID token lives in the JS SDK. Same split as meeting segment upload.
 *
 * Three things it must not do, each of which would be a real bug given the
 * backend does not exist yet:
 *  - spin: every tick starts with one cheap state read and usually stops there
 *  - surface errors: sharing is a background courtesy, and a server that is
 *    down is not the user's problem to action
 *  - run signed out: dictation works signed out by design, sharing cannot
 */

/** How often the queue is checked. Deliberately slow: uploads are never
 * urgent, and the whole point of the persisted backoff in Rust is that this
 * does not need to be clever. */
const TICK_MS = 60_000;
/** A short first tick so a trace that settled while the app was closed is not
 * held hostage for a full minute after launch. */
const FIRST_TICK_MS = 8_000;
/** Ceiling per tick, so a large backlog drains over several minutes instead of
 * saturating the connection in one burst. */
const MAX_PER_TICK = 8;

export function useDictationUpload(ownerUid: string | null) {
  // Guards against two pumps running at once if a tick outlives its interval.
  const runningRef = useRef(false);

  useEffect(() => {
    if (!ownerUid) return;
    const activeOwnerUid = ownerUid;

    let cancelled = false;
    const isCurrent = () => !cancelled;

    async function drainDeletions(): Promise<void> {
      for (let handled = 0; handled < MAX_PER_TICK && isCurrent(); handled += 1) {
        const traceId = await claimTraceDeletion(activeOwnerUid);
        if (!traceId || !isCurrent()) return;
        try {
          await deleteRemoteTrace(traceId, activeOwnerUid);
          if (!isCurrent()) return;
          await resolveTraceDeletion(traceId, activeOwnerUid);
        } catch {
          // Left queued. The obligation to delete outlives any single attempt,
          // which is the whole reason tombstones are persisted.
          return;
        }
      }
    }

    async function drainUploads(): Promise<void> {
      for (let handled = 0; handled < MAX_PER_TICK && isCurrent(); handled += 1) {
        const lease = await claimTraceUpload(activeOwnerUid);
        if (!lease || !isCurrent()) return;
        try {
          await uploadTrace(lease, activeOwnerUid);
          if (!isCurrent()) return;
          await resolveTraceUpload(lease.traceId, activeOwnerUid);
        } catch (err) {
          if (!isCurrent()) return;
          const failure = classifyUploadFailure(err);
          const paused = failure.quotaResetAtMs === null
            ? false
            : await pauseTraceUploads(activeOwnerUid, failure.quotaResetAtMs).catch((inner) => {
                logError("useDictationUpload: record quota pause", inner);
                return false;
              });
          if (paused) return;
          await failTraceUpload(lease.traceId, activeOwnerUid, failure.retryable).catch((inner) =>
            logError("useDictationUpload: record failure", inner),
          );
          // Stop the tick rather than marching through the rest of the queue:
          // whatever just failed almost certainly fails for every other trace
          // too, and burning an attempt on each would exhaust their retries
          // against one outage.
          return;
        }
      }
    }

    async function tick(): Promise<void> {
      if (runningRef.current || !isCurrent()) return;
      runningRef.current = true;
      try {
        const state = await sharePumpState();
        if (!isCurrent()) return;
        // Deletions are drained even when sharing is off — revoking consent is
        // exactly the case where deletes are owed and uploads are not.
        if (state.pendingDeletions > 0) await drainDeletions();
        if (!isCurrent()) return;
        if (state.sharing && state.pendingUploads > 0) await drainUploads();
      } catch (err) {
        logError("useDictationUpload: tick", err);
      } finally {
        runningRef.current = false;
      }
    }

    // Bare timers, not `window.`-prefixed: that is what the rest of the overlay
    // does (bridgeCoordinator, useDraftCard), and the prefixed form is not
    // available in every environment this module gets rendered in.
    const first = setTimeout(() => void tick(), FIRST_TICK_MS);
    const interval = setInterval(() => void tick(), TICK_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [ownerUid]);
}
