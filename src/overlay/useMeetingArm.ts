import { useCallback, useEffect, useRef, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import type { UpcomingMeeting } from "../lib/calendar";
import { localDateString } from "../lib/memory";
import { trackEvent } from "../lib/analytics";
import { logError } from "../lib/log";

/** TEMPORARY 60-MINUTE CLAMP (product decision 2026-07-11): meeting notes
 * only supports meetings up to one hour for now. Longer events (classes,
 * workshops, all-day blocks with an auto-attached Meet link) are not
 * armable at all - not silently truncated - until long-meeting support
 * lands. The Rust capture engine and the backend synthesis caps carry the
 * same clamp; this is the earliest gate of the three. */
export const MAX_NOTES_MEETING_MINUTES = 60;

/** Whether an event can carry meeting notes at all: it needs a conferencing
 * link (in-person events have nothing to capture from loopback) and a
 * scheduled duration within the clamp. An unparseable end time is allowed
 * through - the capture engine's own 60-minute hard stop bounds it. */
export function isEligibleForNotes(event: UpcomingMeeting): boolean {
  if (!event.meetingLink) return false;
  const start = Date.parse(event.startTime);
  const end = Date.parse(event.endTime);
  if (Number.isNaN(start) || Number.isNaN(end)) return true;
  const durationMs = end - start;
  return durationMs > 0 && durationMs <= MAX_NOTES_MEETING_MINUTES * 60_000;
}

// Shares useMeetings' calendar.json store (plugin-store dedups the handle),
// same pruned id -> local-date map idiom as dismissed/summoned events.
// Every key is namespaced by Firebase uid: recording consent belongs to the
// PERSON who granted it, not the Windows install - user B signing into the
// same profile must never inherit user A's opt-in.
const CALENDAR_STORE = "calendar.json";
const AUTO_NOTES_KEY = "auto_meeting_notes";
const ARMED_KEY = "armed_events";
const DISARMED_KEY = "disarmed_events";

function scopedKey(base: string, uid: string): string {
  return `${base}:${uid}`;
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

export interface MeetingArmState {
  /** The global default (persisted, OFF until the user flips it - the
   * opt-in-arm trust model in MEETING_NOTES_PLAN.md section 1). */
  autoNotes: boolean;
  toggleAutoNotes: () => void;
  /** Effective per-meeting decision: global default plus today's per-meeting
   * overrides in either direction. */
  isArmed: (eventId: string) => boolean;
  toggleArm: (eventId: string) => void;
  /** Bumped on every arm-state change so effects can depend on one value. */
  revision: number;
}

/**
 * Who gets meeting notes captured. Capture is user-armed, never default-on:
 * the global toggle starts OFF, and arming is a deliberate choice made from
 * the agenda card. Per-meeting overrides are day-scoped maps (like dismissed
 * events) because a calendar instance id only means something on its day.
 * All state is keyed by the signed-in uid; a null uid resolves everything to
 * disarmed and persists nothing.
 */
export function useMeetingArm(uid: string | null): MeetingArmState {
  const [autoNotes, setAutoNotes] = useState(false);
  const [revision, setRevision] = useState(0);

  const storeRef = useRef<Store | null>(null);
  const armedRef = useRef<IdDateMap>({});
  const disarmedRef = useRef<IdDateMap>({});
  const autoNotesRef = useRef(autoNotes);
  autoNotesRef.current = autoNotes;
  const uidRef = useRef(uid);
  uidRef.current = uid;

  const getStore = useCallback(async () => {
    return storeRef.current ?? (storeRef.current = await load(CALENDAR_STORE));
  }, []);

  useEffect(() => {
    // Account switch: drop the previous user's arm state immediately, then
    // load the new user's (or stay disarmed when signed out).
    armedRef.current = {};
    disarmedRef.current = {};
    setAutoNotes(false);
    setRevision((r) => r + 1);
    if (!uid) return;
    let cancelled = false;
    (async () => {
      try {
        const store = await getStore();
        const today = localDateString();
        const armed = prunedToToday(
          await store.get<IdDateMap>(scopedKey(ARMED_KEY, uid)),
          today,
        );
        const disarmed = prunedToToday(
          await store.get<IdDateMap>(scopedKey(DISARMED_KEY, uid)),
          today,
        );
        const auto = (await store.get<boolean>(scopedKey(AUTO_NOTES_KEY, uid))) === true;
        if (cancelled) return;
        armedRef.current = armed;
        disarmedRef.current = disarmed;
        setAutoNotes(auto);
        setRevision((r) => r + 1);
      } catch (err) {
        logError("useMeetingArm: load store", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid, getStore]);

  const persist = useCallback(
    async (baseKey: string, value: IdDateMap | boolean) => {
      const currentUid = uidRef.current;
      if (!currentUid) return;
      try {
        const store = await getStore();
        await store.set(scopedKey(baseKey, currentUid), value);
        await store.save();
      } catch (err) {
        logError("useMeetingArm: persist", err);
      }
    },
    [getStore],
  );

  const isArmed = useCallback((eventId: string): boolean => {
    if (!uidRef.current) return false;
    const today = localDateString();
    if (armedRef.current[eventId] === today) return true;
    if (disarmedRef.current[eventId] === today) return false;
    return autoNotesRef.current;
  }, []);

  const toggleArm = useCallback(
    (eventId: string) => {
      const today = localDateString();
      const next = !isArmed(eventId);
      if (next) {
        armedRef.current = { ...armedRef.current, [eventId]: today };
        const { [eventId]: _, ...rest } = disarmedRef.current;
        disarmedRef.current = rest;
      } else {
        disarmedRef.current = { ...disarmedRef.current, [eventId]: today };
        const { [eventId]: _, ...rest } = armedRef.current;
        armedRef.current = rest;
      }
      void persist(ARMED_KEY, armedRef.current);
      void persist(DISARMED_KEY, disarmedRef.current);
      setRevision((r) => r + 1);
      trackEvent("meeting_notes_arm_toggled", { armed: next });
    },
    [isArmed, persist],
  );

  const toggleAutoNotes = useCallback(() => {
    const next = !autoNotesRef.current;
    setAutoNotes(next);
    void persist(AUTO_NOTES_KEY, next);
    setRevision((r) => r + 1);
    trackEvent("meeting_notes_auto_toggled", { enabled: next });
  }, [persist]);

  return { autoNotes, toggleAutoNotes, isArmed, toggleArm, revision };
}
