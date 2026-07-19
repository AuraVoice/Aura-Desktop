// The dashboard window's surface over the shared notification store. This
// window NEVER ingests (no outbox polling, no local-event listener, no toasts,
// no permission flow) - the overlay owns all of that. Here we only read the
// durable inbox, live-sync via the store's app-wide key-change events, and
// apply user mutations (seen / dismiss) through the same broker functions the
// overlay uses, so both windows converge on one inbox.
//
// Deliberately NOT calling bindOwner from this window: binding is a
// read-check-clear sequence serialized only within one webview, and racing it
// against the overlay's bind could wipe rows the overlay just ingested. We
// read currentOwner() and fail closed (empty inbox) on a mismatch; the focus
// refresh and key-change subscription recover once the overlay has bound.
//
// Known accepted race (v1): a markSeen here snapshots the whole inbox record
// and can interleave with an overlay ingest for a few milliseconds; the UI
// re-converges via the key-change event. A true fix needs a Rust-side
// row-level merge and is a follow-up, not built now.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  currentOwner,
  dismiss as dismissRow,
  loadInbox,
  markAllSeen as markAllSeenBroker,
  markSeen as markSeenBroker,
  subscribeInbox,
  type StoredNotification,
  unreadCount as countUnread,
} from "../lib/desktopNotifications";
import { acknowledgeDesktopNotification } from "../lib/desktopNotificationOutbox";
import { logError } from "../lib/log";

export interface DashboardNotificationsState {
  inbox: StoredNotification[];
  unreadCount: number;
  markSeen: (id: string) => void;
  markAllSeen: () => void;
  dismiss: (id: string) => void;
}

export function useDashboardNotifications(uid: string | null): DashboardNotificationsState {
  const [inbox, setInbox] = useState<StoredNotification[]>([]);
  const refreshGeneration = useRef(0);

  const refresh = useCallback(() => {
    const generation = ++refreshGeneration.current;
    if (!uid) {
      setInbox([]);
      return;
    }
    void (async () => {
      try {
        const ownerBefore = await currentOwner();
        const rows = ownerBefore === uid ? await loadInbox() : [];
        const ownerAfter = await currentOwner();
        if (refreshGeneration.current === generation) {
          setInbox(ownerBefore === uid && ownerAfter === uid ? rows : []);
        }
      } catch (err) {
        logError("useDashboardNotifications: refresh", err);
      }
    })();
  }, [uid]);

  // Hydrate on sign-in / account switch, then live-sync on inbox writes from
  // ANY window. A row the overlay ingests appears here without polling.
  useEffect(() => {
    setInbox([]);
    if (!uid) return;
    refresh();

    let disposed = false;
    let unlisten: (() => void) | undefined;
    subscribeInbox((rows) => {
      const generation = ++refreshGeneration.current;
      // Owner can flip between subscription and event (sign-out then sign-in
      // as someone else); re-check before trusting the rows.
      currentOwner()
        .then((owner) => {
          if (!disposed && refreshGeneration.current === generation) {
            setInbox(owner === uid ? rows : []);
          }
        })
        .catch((err) => logError("useDashboardNotifications: owner check", err));
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((err) => logError("useDashboardNotifications: subscribe", err));

    // Recovery for events missed while the webview was suspended, and for the
    // startup case where the overlay had not bound the owner yet. Guarded so
    // the hook also mounts under a windowless test environment.
    const onFocus = () => refresh();
    const win = typeof window === "undefined" ? null : window;
    win?.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      refreshGeneration.current += 1;
      unlisten?.();
      win?.removeEventListener("focus", onFocus);
    };
  }, [uid, refresh]);

  const markSeen = useCallback(
    (id: string) => {
      void markSeenBroker(id).then(() => {
        void acknowledgeDesktopNotification(id, "seen");
        refresh();
      });
    },
    [refresh],
  );

  const markAllSeen = useCallback(() => {
    const ids = inbox.filter((row) => !row.seen).map((row) => row.notificationId);
    void markAllSeenBroker().then(() => {
      void (async () => {
        for (const id of ids) {
          await acknowledgeDesktopNotification(id, "seen");
        }
      })();
      refresh();
    });
  }, [inbox, refresh]);

  const dismiss = useCallback(
    (id: string) => {
      void dismissRow(id).then(() => {
        void acknowledgeDesktopNotification(id, "seen");
        refresh();
      });
    },
    [refresh],
  );

  return {
    inbox,
    unreadCount: countUnread(inbox),
    markSeen,
    markAllSeen,
    dismiss,
  };
}
