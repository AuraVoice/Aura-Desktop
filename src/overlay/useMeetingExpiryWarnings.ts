import { useEffect, useRef } from "react";
import { notifyLocal } from "../lib/desktopNotifications";
import { logError } from "../lib/log";
import { fetchRecentMeetings } from "../lib/meetings";

/** First look a little after launch, so it never competes with startup. */
const FIRST_CHECK_MS = 60_000;
const CHECK_EVERY_MS = 6 * 60 * 60_000;
/** Warn once a note has less than a day left. */
const WARN_WITHIN_MS = 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

/** Warns a day before an unpinned note is deleted (free and Companion notes
 *  expire 7 days after they're ready). Lives in the overlay because that is
 *  the window that is always running; the backend has no scheduler for this.
 *  The dedup key carries the deadline, so the broker toasts each deadline
 *  once, and a note unpinned later gets a fresh warning for its new one. */
export function useMeetingExpiryWarnings({
  uid,
  appHidden,
}: {
  uid: string | null;
  appHidden: boolean;
}) {
  const appHiddenRef = useRef(appHidden);
  appHiddenRef.current = appHidden;

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;

    const check = async () => {
      const meetings = await fetchRecentMeetings(20, FETCH_TIMEOUT_MS);
      if (cancelled || !meetings) return;
      const now = Date.now();
      for (const meeting of meetings) {
        if (meeting.status !== "ready" || meeting.pinned || !meeting.expiresAt) continue;
        const deadline = Date.parse(meeting.expiresAt);
        if (!Number.isFinite(deadline) || deadline <= now || deadline - now > WARN_WITHIN_MS) continue;
        const title = meeting.title || "A meeting";
        void notifyLocal(
          {
            type: "meeting_expiring",
            severity: "warning",
            title: "Meeting notes deleted soon",
            body: `${title} will be deleted within a day. Pin it to keep it.`,
            dedupKey: `meeting:${meeting.meetingId}:expiring:${meeting.expiresAt}`,
            action: "view_meeting",
            resourceId: meeting.meetingId,
            toastPolicy: "when_hidden",
            sensitive: true,
            expiresAt: meeting.expiresAt,
          },
          { appHidden: appHiddenRef.current, ownerUid: uid },
        ).catch((err) => logError("useMeetingExpiryWarnings: notify", err));
      }
    };

    const first = window.setTimeout(() => void check(), FIRST_CHECK_MS);
    const every = window.setInterval(() => void check(), CHECK_EVERY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, [uid]);
}
