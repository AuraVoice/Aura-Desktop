import { useCallback, useEffect, useRef, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import {
  fetchMeeting,
  fetchRecentMeetings,
  retryMeeting,
  type MeetingDoc,
} from "../lib/meetings";
import type { MeetingActivity } from "../lib/meetingActivity";
import { localDateString } from "../lib/memory";
import { trackEvent } from "../lib/analytics";
import { logError } from "../lib/log";

const FETCH_BUDGET_MS = 4000;
/** After a capture completes, poll its status this often, this long. Synthesis
 * typically lands in a minute or two; past the deadline the panel-open path
 * still delivers it later. */
const READY_POLL_INTERVAL_MS = 30_000;
const READY_POLL_DEADLINE_MS = 10 * 60_000;
const RECENT_LIMIT = 5;

const NOTES_STORE = "meeting-notes-card.json";
const SEEN_KEY = "seen_notes";
const DISABLED_KEY = "disabled";
/** Seen entries older than this are pruned (notes themselves expire server-
 * side at 7 days on free/companion; the map just needs to outlive them). */
const SEEN_MAX_AGE_DAYS = 8;

type IdDateMap = Record<string, string>;

function prunedToRecent(map: IdDateMap | undefined): IdDateMap {
  if (!map) return {};
  const cutoff = Date.now() - SEEN_MAX_AGE_DAYS * 24 * 60 * 60_000;
  const next: IdDateMap = {};
  for (const [id, date] of Object.entries(map)) {
    const stamp = Date.parse(date);
    if (!Number.isNaN(stamp) && stamp >= cutoff) next[id] = date;
  }
  return next;
}

export interface MeetingNotesState {
  visible: boolean;
  doc: MeetingDoc | null;
  activity: MeetingActivity | null;
  dismiss: () => void;
  retry: () => void;
  turnOff: () => void;
  /** Silent clear (sign-out, call start); dismiss() is the user-facing one. */
  reset: () => void;
}

interface MeetingNotesInputs {
  presentation: "hidden" | "panel" | "companion" | "pointing";
  signedIn: boolean;
  callLive: boolean;
  draftActive: boolean;
  activities: MeetingActivity[];
  retryUpload: (meetingId: string) => void;
  /** Ready/attention events arriving after the foreground polling window. */
  notificationMeetingIds: string[];
}

/**
 * Delivery of finished meeting notes into the below-bar slot. Two triggers,
 * both ambient (silent on every failure):
 *  1. Fresh capture: poll the completed meeting until status "ready".
 *  2. Panel open: the most recent ready-and-unseen note (covers notes that
 *     finished while the app was closed).
 * A note is marked seen only when its card actually renders, mirroring the
 * catch-up card's consumed-day rule.
 */
export function useMeetingNotes(inputs: MeetingNotesInputs): MeetingNotesState {
  const {
    presentation,
    signedIn,
    callLive,
    draftActive,
    activities,
    retryUpload,
    notificationMeetingIds,
  } = inputs;

  const [visible, setVisible] = useState(false);
  const [doc, setDoc] = useState<MeetingDoc | null>(null);
  const [activity, setActivity] = useState<MeetingActivity | null>(null);

  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const storeRef = useRef<Store | null>(null);
  const seenRef = useRef<IdDateMap>({});
  const seenLoadedRef = useRef(false);
  const fetchInFlightRef = useRef(false);
  const callLiveRef = useRef(callLive);
  callLiveRef.current = callLive;
  const draftActiveRef = useRef(draftActive);
  draftActiveRef.current = draftActive;

  const getStore = useCallback(async () => {
    return storeRef.current ?? (storeRef.current = await load(NOTES_STORE));
  }, []);

  const ensureSeenLoaded = useCallback(async () => {
    if (seenLoadedRef.current) return;
    const store = await getStore();
    seenRef.current = prunedToRecent(await store.get<IdDateMap>(SEEN_KEY));
    seenLoadedRef.current = true;
  }, [getStore]);

  /** Shows one ready note if allowed; returns whether it rendered. */
  const present = useCallback(
    async (candidate: MeetingDoc): Promise<boolean> => {
      if (candidate.status === "ready" && candidate.note === null) return false;
      if (!["ready", "excluded", "failed"].includes(candidate.status)) return false;
      if (callLiveRef.current || draftActiveRef.current) return false;
      try {
        const store = await getStore();
        if ((await store.get<boolean>(DISABLED_KEY)) === true) return false;
        await ensureSeenLoaded();
        if (seenRef.current[candidate.meetingId]) return false;

        setDoc(candidate);
        setActivity(null);
        setVisible(true);
        // Seen is consumed only now, when a card actually rendered.
        seenRef.current = { ...seenRef.current, [candidate.meetingId]: localDateString() };
        await store.set(SEEN_KEY, seenRef.current);
        await store.save();
        trackEvent("meeting_note_card_shown", {
          status: candidate.status,
          action_items: candidate.note?.actionItems.length ?? 0,
          one_sided: candidate.note?.oneSided ?? false,
        });
        return true;
      } catch (err) {
        logError("useMeetingNotes: present", err);
        return false;
      }
    },
    [getStore, ensureSeenLoaded],
  );

  const processingActivity = activities.find((item) => item.phase === "processing") ?? null;

  // Trigger 1: poll the newest completed capture to a committed terminal state.
  useEffect(() => {
    if (!signedIn || !processingActivity) return;
    let cancelled = false;
    const deadline = Date.now() + READY_POLL_DEADLINE_MS;

    const tick = async () => {
      if (cancelled || Date.now() > deadline) return;
      const fetched = await fetchMeeting(processingActivity.meetingId, FETCH_BUDGET_MS);
      if (cancelled) return;
      if (fetched && (fetched.status === "ready" || fetched.status === "excluded" || fetched.status === "failed")) {
        void present(fetched);
        return; // terminal either way - stop polling
      }
      timer = setTimeout(() => void tick(), READY_POLL_INTERVAL_MS);
    };
    let timer = setTimeout(() => void tick(), READY_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [signedIn, processingActivity?.meetingId, present]);

  // Durable local queue state is immediately user-visible and survives restart.
  useEffect(() => {
    if (presentation !== "companion" || !signedIn || callLive || draftActive) return;
    const candidate = activities[0];
    if (!candidate || candidate.phase === "ready") return;
    if (doc?.meetingId === candidate.meetingId
      && ["ready", "excluded", "failed"].includes(doc.status)) return;
    const seenKey = `${candidate.meetingId}:${candidate.phase}`;
    void ensureSeenLoaded().then(() => {
      if (seenRef.current[seenKey]) return;
      setActivity(candidate);
      setDoc(null);
      setVisible(true);
    });
  }, [
    presentation,
    signedIn,
    callLive,
    draftActive,
    activities,
    doc,
    ensureSeenLoaded,
  ]);

  // An outbox event is the continuation path after foreground polling ends.
  useEffect(() => {
    if (!signedIn || notificationMeetingIds.length === 0) return;
    let cancelled = false;
    void Promise.all(
      notificationMeetingIds.map((meetingId) => fetchMeeting(meetingId, FETCH_BUDGET_MS)),
    ).then((rows) => {
      if (cancelled) return;
      const terminal = rows.find((row) =>
        row !== null && ["ready", "excluded", "failed"].includes(row.status));
      if (terminal) void present(terminal);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn, notificationMeetingIds, present]);

  // Trigger 2: entering the signed-in panel, latest ready-and-unseen note.
  useEffect(() => {
    if (presentation !== "companion" || !signedIn || callLive || draftActive) return;
    if (visibleRef.current || fetchInFlightRef.current) return;
    let cancelled = false;
    fetchInFlightRef.current = true;
    (async () => {
      try {
        const store = await getStore();
        if ((await store.get<boolean>(DISABLED_KEY)) === true) return;
        await ensureSeenLoaded();
        const recent = await fetchRecentMeetings(RECENT_LIMIT, FETCH_BUDGET_MS);
        if (cancelled || recent === null) return;
        const candidate = recent.find((item) =>
          ["ready", "excluded", "failed"].includes(item.status)
          && (item.status !== "ready" || item.note !== null)
          && !seenRef.current[item.meetingId]);
        if (candidate) await present(candidate);
      } catch (err) {
        logError("useMeetingNotes: panel trigger", err);
      } finally {
        fetchInFlightRef.current = false;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [presentation, signedIn, callLive, draftActive, getStore, ensureSeenLoaded, present]);

  const reset = useCallback(() => {
    if (!visibleRef.current) return;
    setVisible(false);
    setDoc(null);
    setActivity(null);
  }, []);

  // A call or draft taking the slot clears the card silently.
  useEffect(() => {
    if (callLive || draftActive) reset();
  }, [callLive, draftActive, reset]);

  const dismiss = useCallback(() => {
    if (!visibleRef.current) return;
    if (activity) {
      const seenKey = `${activity.meetingId}:${activity.phase}`;
      seenRef.current = { ...seenRef.current, [seenKey]: localDateString() };
      void getStore().then(async (store) => {
        await store.set(SEEN_KEY, seenRef.current);
        await store.save();
      });
    }
    reset();
    trackEvent("meeting_note_card_dismissed", {});
  }, [activity, getStore, reset]);

  const retry = useCallback(() => {
    if (activity?.retryable) {
      retryUpload(activity.meetingId);
      return;
    }
    if (doc?.retryable) {
      void retryMeeting(doc.meetingId).catch((err) =>
        logError("useMeetingNotes: retry processing", err),
      );
    }
  }, [activity, doc, retryUpload]);

  const turnOff = useCallback(() => {
    (async () => {
      try {
        const store = await getStore();
        await store.set(DISABLED_KEY, true);
        await store.save();
      } catch (err) {
        logError("useMeetingNotes: turnOff", err);
      }
    })();
    reset();
    trackEvent("meeting_note_card_toggle_off", {});
  }, [getStore, reset]);

  return { visible, doc, activity, dismiss, retry, turnOff, reset };
}
