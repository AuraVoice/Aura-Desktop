// Mounts the desktop notification broker into the overlay: hydrates the inbox
// on sign-in, ingests locally-pushed events, exposes the unread count, and
// (Phase 4) polls the backend outbox. All persistence, dedup, toast policy, and
// permission live in the broker (src/lib/desktopNotifications.ts); this hook is
// the thin React surface over it.

import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  bindOwner,
  dismiss as dismissRow,
  ensurePermission,
  ingest,
  isDisabled,
  loadInbox,
  markAllSeen as markAllSeenBroker,
  markSeen as markSeenBroker,
  permissionAlreadyAsked,
  permissionGranted,
  setDisabled,
  type StoredNotification,
  unreadCount as countUnread,
} from "../lib/desktopNotifications";
import { logError } from "../lib/log";
import { trackEvent } from "../lib/analytics";
import {
  acknowledgeDesktopNotification,
  bindOutboxOwner,
  fetchDesktopOutboxPage,
  resetOutboxCursor,
  saveOutboxCursor,
  updateDesktopNotificationPreferences,
} from "../lib/desktopNotificationOutbox";

const OUTBOX_POLL_INTERVAL_MS = 60_000;
const OUTBOX_MAX_PAGES_PER_POLL = 20;
// How many polls a page containing an unparseable event is re-read before the
// cursor moves past it anyway. At the 60s poll interval this is ~5 minutes of
// holding, which covers a transient backend shape problem, while still
// guaranteeing the poller cannot be wedged forever by one permanently bad row.
const UNPARSEABLE_PAGE_MAX_ATTEMPTS = 5;

export interface DesktopNotificationsState {
  inbox: StoredNotification[];
  unreadCount: number;
  refresh: () => void;
  markSeen: (id: string) => void;
  markAllSeen: () => void;
  dismiss: (id: string) => void;
  acknowledgeAction: (notification: StoredNotification) => void;
  permissionPromptVisible: boolean;
  enablePermission: () => void;
  dismissPermissionPrompt: () => void;
  notificationsEnabled: boolean;
  setNotificationsEnabled: (enabled: boolean) => void;
  reset: () => void;
}

export function useDesktopNotifications({
  signedIn,
  uid,
  appHidden,
}: {
  signedIn: boolean;
  uid: string | null;
  /** True when Aura is not showing the relevant content (hidden / pill), which
   *  drives the broker's `when_hidden` toast policy. */
  appHidden: boolean;
}): DesktopNotificationsState {
  const [inbox, setInbox] = useState<StoredNotification[]>([]);
  const [permissionPromptVisible, setPermissionPromptVisible] = useState(false);
  const [notificationsEnabled, setNotificationsEnabledState] = useState(true);
  const [ownerReady, setOwnerReady] = useState(false);
  const boundUidRef = useRef<string | null>(null);
  const outboxCursorRef = useRef("");
  // cursor -> how many times a page starting there failed to parse. In memory
  // only: a restart re-attempting a bad page is the desired behaviour, since the
  // restart may well be the client release that can finally read it.
  const unparseableAttemptsRef = useRef(new Map<string, number>());
  // appHidden flips often; hold it in a ref so ingest reads the latest value
  // without re-subscribing the listener each time.
  const appHiddenRef = useRef(appHidden);
  appHiddenRef.current = appHidden;

  const refresh = useCallback(() => {
    loadInbox()
      .then(setInbox)
      .catch((err) => logError("useDesktopNotifications: refresh", err));
  }, []);

  // Hydrate + bind owner on sign-in / account switch. bindOwner clears the
  // store when the uid changes, so one account never sees another's inbox.
  useEffect(() => {
    boundUidRef.current = null;
    setOwnerReady(false);
    setInbox([]);
    setPermissionPromptVisible(false);
    if (!signedIn || !uid) {
      return;
    }
    let cancelled = false;
    bindOwner(uid)
      .then(async () => {
        if (cancelled) return null;
        boundUidRef.current = uid;
        const [rows, alreadyAsked, alreadyGranted, cursor, disabled] = await Promise.all([
          loadInbox(),
          permissionAlreadyAsked(),
          permissionGranted(),
          bindOutboxOwner(uid),
          isDisabled(),
        ]);
        return { rows, alreadyAsked, alreadyGranted, cursor, disabled };
      })
      .then((result) => {
        if (!cancelled && result) {
          const { rows, alreadyAsked, alreadyGranted, cursor, disabled } = result;
          outboxCursorRef.current = cursor;
          setInbox(rows);
          setNotificationsEnabledState(!disabled);
          setOwnerReady(true);
          setPermissionPromptVisible(!alreadyAsked && !alreadyGranted);
        }
      })
      .catch((err) => logError("useDesktopNotifications: hydrate", err));
    return () => {
      cancelled = true;
    };
  }, [signedIn, uid]);

  // Native local-event ingestion: a Rust producer (e.g. update ready) can push
  // a raw contract event over "desktop-notification-local"; the broker validates
  // it, so an unexpected payload cannot reach the UI unchecked.
  useEffect(() => {
    if (!signedIn || !uid || !ownerReady) return;
    let unlisten: (() => void) | undefined;
    listen<unknown>("desktop-notification-local", (event) => {
      if (boundUidRef.current !== uid) return;
      ingest(event.payload, { appHidden: appHiddenRef.current, ownerUid: uid })
        .then((result) => {
          if (result.isNew) refresh();
        })
        .catch((err) => logError("useDesktopNotifications: ingest local", err));
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("useDesktopNotifications: listen local", err));
    return () => unlisten?.();
  }, [signedIn, uid, ownerReady, refresh]);

  // Register capability independently from hydration. A transient API failure
  // must not prevent local inbox ownership or future polling, and is retried
  // until the backend has a current authenticated desktop heartbeat.
  useEffect(() => {
    if (!signedIn || !uid || !ownerReady) return;
    let cancelled = false;
    const syncCapability = async () => {
      try {
        const disabled = await isDisabled();
        await updateDesktopNotificationPreferences({
          enabled: !disabled,
          committed_enabled: true,
          proactive_enabled: true,
          account_enabled: true,
          notification_contract_version: 1,
          research_ui_version: 1,
          supported_actions: ["view_research", "answer_research_question"],
        });
      } catch (err) {
        if (!cancelled) {
          logError("useDesktopNotifications: capability heartbeat", err);
        }
      }
    };
    void syncCapability();
    const interval = setInterval(() => void syncCapability(), 5 * 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [signedIn, uid, ownerReady]);

  // Cursor polling is deliberately thin: the backend owns policy and the
  // broker owns validation/dedup/toasts. Cursor persistence happens only after
  // a page has been ingested, so a crash replays safely through local dedup.
  useEffect(() => {
    if (!signedIn || !uid || !ownerReady || !notificationsEnabled) return;
    let cancelled = false;
    let running = false;

    const poll = async () => {
      if (cancelled || running || boundUidRef.current !== uid) return;
      running = true;
      try {
        for (let pageNumber = 0; pageNumber < OUTBOX_MAX_PAGES_PER_POLL; pageNumber++) {
          const previousCursor = outboxCursorRef.current;
          let page;
          try {
            page = await fetchDesktopOutboxPage(previousCursor);
          } catch (err) {
            if (err instanceof Error && err.name === "InvalidDesktopOutboxCursorError") {
              outboxCursorRef.current = "";
              await resetOutboxCursor(uid);
              return;
            }
            throw err;
          }
          if (cancelled || boundUidRef.current !== uid) return;
          let unparseable = 0;
          for (const raw of page.items) {
            const result = await ingest(raw, {
              appHidden: appHiddenRef.current,
              ownerUid: uid,
            });
            if (result.parseFailed) unparseable += 1;
            if (result.notification) {
              await acknowledgeDesktopNotification(
                result.notification.notificationId,
                "received",
              );
              trackEvent("desktop_notification_fetched", {
                type: result.notification.type,
              });
            }
          }

          // An event this build cannot parse is usually a backend that shipped a
          // new notification type first. Advancing the durable cursor past it
          // loses it permanently, including after the client release that would
          // have understood it, so hold the cursor and re-read the page next
          // poll instead.
          if (unparseable > 0) {
            const attempts = (unparseableAttemptsRef.current.get(previousCursor) ?? 0) + 1;
            unparseableAttemptsRef.current.set(previousCursor, attempts);
            if (attempts < UNPARSEABLE_PAGE_MAX_ATTEMPTS) {
              logError(
                "useDesktopNotifications: holding outbox cursor on unparseable page",
                new Error(
                  `${unparseable} unparseable event(s), attempt ${attempts}`,
                ),
              );
              break;
            }
            // Dead-letter. Retrying forever would wedge the poller and stop every
            // LATER notification too, which is a worse failure than losing this
            // page. Loud, because it is real data loss.
            logError(
              "useDesktopNotifications: skipping unparseable outbox page",
              new Error(
                `${unparseable} event(s) dropped after ${attempts} attempts`,
              ),
            );
            trackEvent("desktop_notification_page_dropped", { count: unparseable });
          }
          unparseableAttemptsRef.current.delete(previousCursor);

          if (page.nextCursor && page.nextCursor !== previousCursor) {
            outboxCursorRef.current = page.nextCursor;
            await saveOutboxCursor(uid, page.nextCursor);
          } else {
            break;
          }
        }
        refresh();
      } catch (err) {
        logError("useDesktopNotifications: poll", err);
      } finally {
        running = false;
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), OUTBOX_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [signedIn, uid, ownerReady, notificationsEnabled, refresh]);

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
      ids.forEach((id) => void acknowledgeDesktopNotification(id, "seen"));
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
  const acknowledgeAction = useCallback((notification: StoredNotification) => {
    if (!notification.action) return;
    void acknowledgeDesktopNotification(
      notification.notificationId,
      "acted",
      notification.action,
    );
  }, []);
  const enablePermission = useCallback(() => {
    setPermissionPromptVisible(false);
    void ensurePermission().catch((err) =>
      logError("useDesktopNotifications: enable permission", err),
    );
  }, []);
  const dismissPermissionPrompt = useCallback(() => {
    setPermissionPromptVisible(false);
  }, []);
  const setNotificationsEnabled = useCallback((enabled: boolean) => {
    setNotificationsEnabledState(enabled);
    void setDisabled(!enabled);
    void updateDesktopNotificationPreferences({
      enabled,
      committed_enabled: true,
      proactive_enabled: true,
      account_enabled: true,
      notification_contract_version: 1,
      research_ui_version: 1,
      supported_actions: ["view_research", "answer_research_question"],
    }).catch((err) => {
      setNotificationsEnabledState(!enabled);
      void setDisabled(enabled);
      logError("useDesktopNotifications: update preference", err);
    });
  }, []);
  const reset = useCallback(() => {
    boundUidRef.current = null;
    setOwnerReady(false);
    outboxCursorRef.current = "";
    setInbox([]);
    setPermissionPromptVisible(false);
    setNotificationsEnabledState(true);
  }, []);

  return {
    inbox,
    unreadCount: countUnread(inbox),
    refresh,
    markSeen,
    markAllSeen,
    dismiss,
    acknowledgeAction,
    permissionPromptVisible,
    enablePermission,
    dismissPermissionPrompt,
    notificationsEnabled,
    setNotificationsEnabled,
    reset,
  };
}
