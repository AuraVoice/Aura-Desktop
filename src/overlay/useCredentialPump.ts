import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { logError } from "../lib/log";

/**
 * Keeps Rust supplied with a short-lived credential, refreshed ahead of expiry.
 *
 * Dictation runs two of these: the ASR provider credential and the Firebase ID
 * token the AI-formatting call uses. They were written separately and were the
 * same hook twice, down to declaring the retry delay and the refresh fraction
 * with the same values in both files. They had drifted on behaviour too: the
 * transcription pump stopped when the mint said "signed out", the polish pump
 * rescheduled forever. One implementation, one answer.
 *
 * Both are mounted by OverlayRoot rather than the dashboard, because the
 * overlay is always running and the dashboard is built on demand. A credential
 * that only refreshed while a settings page happened to be open would leave the
 * chord dead most of the time.
 *
 * The scheduling matters more than it looks. The provider checks the credential
 * at the WebSocket handshake, and that handshake happens the instant the user
 * presses the chord. Minting lazily would put a backend round trip in front of
 * the first word of every cold dictation; refreshing at a fraction of the
 * token's life means the press always finds a warm one.
 *
 * Three things this must not do:
 *  - mint while signed out: a 401 loop helps nobody, so a cycle reports that by
 *    returning a null delay and the pump stops.
 *  - clear a working credential on a transient failure: a valid token should
 *    keep dictation alive through a blip, so only the cleanup path clears.
 *  - leave a credential behind on sign-out, where it would outlive the session
 *    that was allowed to have it.
 *
 * The timer is not enough on its own. It lives in the hidden overlay webview,
 * and that webview's timers stall while the machine sleeps and get throttled
 * while the window is hidden, so after a long idle the token had been dead for
 * an hour before the timer fired. `kickEvent` is Rust's way of saying "I need
 * one right now": the chord found no credential, so the pump mints immediately
 * instead of waiting for a timer that may not be coming.
 */

/** Refresh at this fraction of a token's life. */
export const REFRESH_FRACTION = 0.7;

/** Backoff after a failed mint. */
export const RETRY_DELAY_MS = 30_000;

/** When to run again, or null to stop until something changes the uid. */
export interface PumpOutcome {
  nextDelayMs: number | null;
}

export function refreshDelayMs(ttlSeconds: number): number {
  return Math.max(1_000, Math.floor(ttlSeconds * REFRESH_FRACTION * 1_000));
}

export function useCredentialPump(
  ownerUid: string | null,
  cycle: () => Promise<PumpOutcome>,
  clear: () => Promise<unknown>,
  kickEvent?: string,
): void {
  // Guards against a cycle scheduled by a previous uid landing after a sign-out
  // or a user switch.
  const generationRef = useRef(0);
  // The callbacks are recreated on every render; the effect must not restart
  // for that, only for a uid change, or the pump would re-mint constantly.
  const cycleRef = useRef(cycle);
  const clearRef = useRef(clear);
  cycleRef.current = cycle;
  clearRef.current = clear;

  useEffect(() => {
    const generation = ++generationRef.current;

    if (!ownerUid) {
      void Promise.resolve(clearRef.current()).catch((err) =>
        logError("useCredentialPump: clear", err),
      );
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let inFlight = false;

    const run = async () => {
      inFlight = true;
      // The cycle is supplied by the caller, so this cannot assume it never
      // throws. Without the catch, one rejection means no timer is scheduled and
      // the pump is dead for the rest of the session, silently, with the
      // credential quietly expiring underneath it.
      let outcome: PumpOutcome;
      try {
        outcome = await cycleRef.current();
      } catch (err) {
        logError("useCredentialPump: cycle threw", err);
        outcome = { nextDelayMs: RETRY_DELAY_MS };
      }
      inFlight = false;
      // A cycle that started before a sign-out or a user switch must not
      // schedule work for, or on behalf of, the session that replaced it.
      if (cancelled || generationRef.current !== generation) return;
      if (outcome.nextDelayMs !== null) {
        timer = setTimeout(() => void run(), outcome.nextDelayMs);
      }
    };

    void run();

    // Rust asked for a credential now. A mint already in flight will land on
    // its own, so only an idle pump starts one; either way the scheduled
    // refresh is dropped because the cycle that runs will schedule the next.
    let unlisten: (() => void) | undefined;
    let unlistenCancelled = false;
    if (kickEvent) {
      listen(kickEvent, () => {
        if (cancelled || inFlight) return;
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        void run();
      })
        .then((fn) => {
          if (unlistenCancelled) fn();
          else unlisten = fn;
        })
        .catch((err) => logError("useCredentialPump: listen", err));
    }

    return () => {
      cancelled = true;
      unlistenCancelled = true;
      unlisten?.();
      if (timer !== undefined) clearTimeout(timer);
      void Promise.resolve(clearRef.current()).catch((err) =>
        logError("useCredentialPump: clear", err),
      );
    };
  }, [ownerUid]);
}
