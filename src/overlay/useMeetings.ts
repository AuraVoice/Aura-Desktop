import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { load, type Store } from "@tauri-apps/plugin-store";
import { fetchUpcomingMeetings, type UpcomingMeeting } from "../lib/calendar";
import { localDateString } from "../lib/memory";
import { trackEvent } from "../lib/analytics";
import { logError } from "../lib/log";

/** Generous budget: unlike the catch-up card this poll runs in the background,
 * not on the critical summon path, so it can wait a little longer for a result. */
const FETCH_BUDGET_MS = 4000;
const POLL_INTERVAL_MS = 5 * 60_000;
/** Local recompute cadence: refreshes the countdown and re-checks the ticker/
 * auto-summon thresholds without re-hitting the network. */
const TICK_MS = 30_000;
/** Meeting is "imminent" (ticker eligible) within this many minutes. */
const TICKER_WINDOW_MIN = 60;
/** Auto-summon the hidden bar this many minutes before a meeting starts. */
const AUTOSUMMON_LEAD_MIN = 10;
/** If polls keep failing, drop the last event list after this long so a dead
 * network can never leave a wrong "in 25 min" frozen on screen. */
const STALE_MAX_MS = 15 * 60_000;

const CALENDAR_STORE = "calendar.json";
// Both maps are eventId -> local date string; pruned to today on load so they
// stay bounded (an entry is only meaningful for the day it was written).
const DISMISSED_KEY = "dismissed_events";
const SUMMONED_KEY = "auto_summoned_events";
const ALERTS_DISABLED_KEY = "alerts_disabled";

interface MeetingsInputs {
  presentation: "hidden" | "panel" | "pill" | "pointing";
  signedIn: boolean;
  callLive: boolean;
}

export interface SoonestMeeting {
  meeting: UpcomingMeeting;
  /** Whole minutes until start; 0 means "starting now". */
  minutesUntil: number;
}

export interface MeetingsState {
  /** false = no Google Calendar connected for this account (drives the agenda's
   * "Connect in the Aura app" empty state). */
  connected: boolean;
  /** Whether at least one successful fetch has resolved (agenda loading state). */
  loaded: boolean;
  /** True when a fetch failed (network/backend error, not "not connected")
   * before any successful load - lets the agenda show a terminal retry state
   * instead of sticking on the skeleton forever. Cleared on the next success. */
  loadFailed: boolean;
  /** Today's remaining events, for the agenda card. */
  events: UpcomingMeeting[];
  /** The soonest not-snoozed event within the ticker window, or null. */
  soonest: SoonestMeeting | null;
  alertsDisabled: boolean;
  /** Snooze a meeting for the rest of today (ticker + auto-summon skip it). */
  dismiss: (eventId: string) => void;
  /** Kill switch: no ticker, no auto-summon, for this device. */
  turnOffAlerts: () => void;
  /** Re-run the poll now, for the agenda's retry button after a load failure. */
  refresh: () => void;
}

type IdDateMap = Record<string, string>;

function prunedToToday(map: IdDateMap | undefined, today: string): IdDateMap {
  if (!map) return {};
  const next: IdDateMap = {};
  for (const [id, date] of Object.entries(map)) {
    if (date === today) next[id] = date;
  }
  return next;
}

/**
 * The calendar meeting state machine. Mounted once in OverlayRoot and polls
 * regardless of presentation (the webview process stays alive while the window
 * is hidden), so it can auto-summon the bar before a meeting the user never
 * opened. Every failure path is silent - like the catch-up card, this is an
 * ambient surface that must never surface an error.
 */
export function useMeetings(inputs: MeetingsInputs): MeetingsState {
  const { presentation, signedIn, callLive } = inputs;

  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [events, setEvents] = useState<UpcomingMeeting[]>([]);
  const [soonest, setSoonest] = useState<SoonestMeeting | null>(null);
  const [alertsDisabled, setAlertsDisabled] = useState(false);

  const storeRef = useRef<Store | null>(null);
  const eventsRef = useRef<UpcomingMeeting[]>(events);
  eventsRef.current = events;
  // Mirror so poll()'s stable closure can tell "never loaded yet" (terminal
  // error) apart from "already have data" (a transient failed refresh) without
  // re-subscribing on every load state change.
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const dismissedRef = useRef<IdDateMap>({});
  const summonedRef = useRef<IdDateMap>({});
  const lastGoodAtRef = useRef<number | null>(null);

  // Mirrors so the poll/tick interval closures read live values without
  // re-subscribing every render.
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const callLiveRef = useRef(callLive);
  callLiveRef.current = callLive;
  const signedInRef = useRef(signedIn);
  signedInRef.current = signedIn;
  const alertsDisabledRef = useRef(alertsDisabled);
  alertsDisabledRef.current = alertsDisabled;

  const getStore = useCallback(async () => {
    return storeRef.current ?? (storeRef.current = await load(CALENDAR_STORE));
  }, []);

  const persistMap = useCallback(
    async (key: string, map: IdDateMap) => {
      try {
        const store = await getStore();
        await store.set(key, map);
        await store.save();
      } catch (err) {
        logError("useMeetings: persistMap", err);
      }
    },
    [getStore],
  );

  // Load persisted state once, pruning both id maps to today.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await getStore();
        const today = localDateString();
        const dismissed = prunedToToday(await store.get<IdDateMap>(DISMISSED_KEY), today);
        const summoned = prunedToToday(await store.get<IdDateMap>(SUMMONED_KEY), today);
        const disabled = (await store.get<boolean>(ALERTS_DISABLED_KEY)) === true;
        if (cancelled) return;
        dismissedRef.current = dismissed;
        summonedRef.current = summoned;
        setAlertsDisabled(disabled);
      } catch (err) {
        logError("useMeetings: load store", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getStore]);

  // Recompute the soonest eligible meeting from the cached list, and fire the
  // one-shot auto-summon when a meeting crosses the lead threshold.
  const recompute = useCallback(() => {
    // Kill switch suppresses the proactive surfaces (ticker + auto-summon)
    // entirely; the agenda card still lists events on demand.
    if (alertsDisabledRef.current) {
      setSoonest(null);
      return;
    }
    const now = Date.now();
    const today = localDateString();
    let best: { meeting: UpcomingMeeting; ms: number } | null = null;
    for (const ev of eventsRef.current) {
      if (dismissedRef.current[ev.id] === today) continue;
      const start = Date.parse(ev.startTime);
      if (Number.isNaN(start)) continue;
      const ms = start - now;
      if (ms < 0) continue; // already started
      if (ms > TICKER_WINDOW_MIN * 60_000) continue; // beyond the ticker window
      if (!best || ms < best.ms) best = { meeting: ev, ms };
    }

    setSoonest(
      best ? { meeting: best.meeting, minutesUntil: Math.max(0, Math.round(best.ms / 60_000)) } : null,
    );

    if (
      best &&
      !alertsDisabledRef.current &&
      best.ms <= AUTOSUMMON_LEAD_MIN * 60_000 &&
      presentationRef.current === "hidden" &&
      !callLiveRef.current &&
      summonedRef.current[best.meeting.id] !== today
    ) {
      summonedRef.current = { ...summonedRef.current, [best.meeting.id]: today };
      void persistMap(SUMMONED_KEY, summonedRef.current);
      invoke("summon").catch((err) => logError("useMeetings: auto-summon", err));
      trackEvent("meeting_auto_summon", { minutes_until: Math.round(best.ms / 60_000) });
    }
  }, [persistMap]);

  const poll = useCallback(async () => {
    if (!signedInRef.current) return;
    const result = await fetchUpcomingMeetings(FETCH_BUDGET_MS);
    if (result === null) {
      // Before any successful load this is a terminal failure - surface a retry
      // so the agenda never sticks on the skeleton (e.g. the endpoint 404s or
      // the network is down on first open).
      if (!loadedRef.current) setLoadFailed(true);
      // Staleness guard: only clear a previously-good list once it's too old to
      // trust, so a single failed poll doesn't blank a valid ticker.
      if (lastGoodAtRef.current !== null && Date.now() - lastGoodAtRef.current > STALE_MAX_MS) {
        setEvents([]);
        setConnected(false);
        lastGoodAtRef.current = null;
      }
      return;
    }
    lastGoodAtRef.current = Date.now();
    setConnected(result.connected);
    setEvents(result.events);
    setLoaded(true);
    setLoadFailed(false);
  }, []);

  // Retry after a load failure: clear the error and re-poll immediately.
  const refresh = useCallback(() => {
    setLoadFailed(false);
    void poll();
  }, [poll]);

  // Poll on mount, on an interval, and whenever the user brings the panel up
  // (so an opened bar always reflects a fresh calendar).
  useEffect(() => {
    if (!signedIn) {
      setConnected(false);
      setLoaded(false);
      setLoadFailed(false);
      setEvents([]);
      setSoonest(null);
      lastGoodAtRef.current = null;
      return;
    }
    void poll();
    const id = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [signedIn, poll]);

  useEffect(() => {
    if (signedIn && presentation === "panel") void poll();
  }, [signedIn, presentation, poll]);

  // Recompute on every event-list change and on a steady local tick.
  useEffect(() => {
    recompute();
    const id = setInterval(recompute, TICK_MS);
    return () => clearInterval(id);
  }, [events, recompute]);

  const dismiss = useCallback(
    (eventId: string) => {
      const today = localDateString();
      dismissedRef.current = { ...dismissedRef.current, [eventId]: today };
      void persistMap(DISMISSED_KEY, dismissedRef.current);
      recompute();
      trackEvent("meeting_ticker_dismissed", {});
    },
    [persistMap, recompute],
  );

  const turnOffAlerts = useCallback(() => {
    setAlertsDisabled(true);
    setSoonest(null);
    (async () => {
      try {
        const store = await getStore();
        await store.set(ALERTS_DISABLED_KEY, true);
        await store.save();
      } catch (err) {
        logError("useMeetings: turnOffAlerts", err);
      }
    })();
    trackEvent("meeting_alerts_toggle_off", {});
  }, [getStore]);

  return { connected, loaded, loadFailed, events, soonest, alertsDisabled, dismiss, turnOffAlerts, refresh };
}
