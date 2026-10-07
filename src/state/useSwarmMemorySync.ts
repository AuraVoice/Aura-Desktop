// Keeps the local swarm memory current while the Swarm page is not open. The overlay
// is the one window that is always alive, so this runs there (OverlayRoot) and sweeps
// finished sessions on three signals: an account change, a swarm report notice
// landing in the inbox, and the machine waking up (a heartbeat gap).

import { useEffect, useRef } from "react";
import type { StoredNotification } from "../lib/desktopNotifications";
import { sweepFinishedSessions } from "../lib/swarmMemory";

const HEARTBEAT_MS = 60_000;
/** A gap this long between heartbeats means the machine slept or the app was frozen. */
const WAKE_GAP_MS = 5 * 60_000;

const REPORT_TYPES: ReadonlySet<string> = new Set(["swarm_report_ready", "swarm_report_partial", "swarm_failed"]);

export function useSwarmMemorySync({ signedIn, uid, inbox }: { signedIn: boolean; uid: string | null; inbox: StoredNotification[] }) {
  const seen = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!signedIn || !uid) return;
    void sweepFinishedSessions().catch(() => undefined);
  }, [signedIn, uid]);

  useEffect(() => {
    if (!signedIn) return;
    let fresh = false;
    for (const row of inbox) {
      if (!REPORT_TYPES.has(row.type) || seen.current.has(row.notificationId)) continue;
      seen.current.add(row.notificationId);
      fresh = true;
    }
    if (fresh) void sweepFinishedSessions().catch(() => undefined);
  }, [signedIn, inbox]);

  useEffect(() => {
    if (!signedIn) return;
    let last = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const slept = now - last > WAKE_GAP_MS;
      last = now;
      if (slept && navigator.onLine) void sweepFinishedSessions().catch(() => undefined);
    }, HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, [signedIn]);
}
