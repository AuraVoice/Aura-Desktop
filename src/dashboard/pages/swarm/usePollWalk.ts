import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** The Research page's cadence: 2.5 s while anything runs, 15 s after an error. */
const POLL_MS = 2_500;
const POLL_BACKOFF_MS = 15_000;

export interface PollWalk<V> {
  /** One id's view, or null when it is unchanged since the revision it was asked about. */
  fetchOne: (id: string, signal: AbortSignal) => Promise<V | null>;
  /** Stores a changed view. Returns true when the view means something ended. */
  onView: (id: string, view: V) => boolean;
  /** A fetch that threw. Returns true when it was handled (a 404 made final), false for a
   * blip the next tick retries after the backoff. */
  onError?: (id: string, error: unknown) => boolean;
  /** After a walk that saw something end. Runs even when a re-arm cut the walk short,
   * because the new walk no longer asks about the id that ended. */
  onEnded: () => void | Promise<void>;
}

/**
 * Polls each id in turn while there are any: nothing while the window is hidden or
 * offline, one walk at a time (a slow request never lets the interval start a second
 * walk on top), and a re-arm aborts the old walk's request instead of leaving it to land.
 * The sessions and the #group rounds loops in SwarmPage were two hand copies of this and
 * had drifted (only one refused an older view), so both now run here.
 *
 * Callbacks are read live, so `fetchOne` can ask with the newest revision the page holds;
 * a revision captured when the effect armed goes stale after the first change, and then
 * every tick fetches a full view that rebuilds the thread. Returns whether the last walk
 * failed, for the "reconnecting" header.
 */
export function usePollWalk<V>(ids: string[], walk: PollWalk<V>): boolean {
  const live = useRef(walk);
  useLayoutEffect(() => {
    live.current = walk;
  });
  const [failing, setFailing] = useState(false);
  const key = ids.join(",");

  useEffect(() => {
    if (ids.length === 0) return;
    const controller = new AbortController();
    let running = false;
    const tick = async () => {
      if (running || document.visibilityState !== "visible" || !navigator.onLine) return;
      running = true;
      let failed = false;
      let ended = false;
      try {
        for (const id of ids) {
          if (controller.signal.aborted) break;
          try {
            const view = await live.current.fetchOne(id, controller.signal);
            if (controller.signal.aborted) break;
            if (view && live.current.onView(id, view)) ended = true;
          } catch (error) {
            if (controller.signal.aborted) break;
            if (!live.current.onError?.(id, error)) failed = true;
          }
        }
        if (!controller.signal.aborted) setFailing(failed);
        if (ended) await live.current.onEnded();
      } finally {
        running = false;
      }
    };
    const timer = window.setInterval(() => void tick(), failing ? POLL_BACKOFF_MS : POLL_MS);
    void tick();
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
    // `ids` is keyed by its join; the callbacks are read through `live`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, failing]);

  return failing;
}
