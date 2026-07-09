import { useCallback, useEffect, useRef, useState } from "react";
import { load, type Store } from "@tauri-apps/plugin-store";
import { trackEvent } from "../lib/analytics";
import { logError } from "../lib/log";
import {
  deleteMemory,
  fetchCallbackCard,
  localDateString,
  type MemoryChip,
} from "../lib/memory";

/** Card renders only if the read beats this; slower means silent no-card and
 * the day stays unconsumed so a later summon retries. */
const FETCH_BUDGET_MS = 1500;
const ENGAGED_WINDOW_MS = 10_000;
const DELETE_FAILED_FLASH_MS = 3000;

const CALLBACK_STORE = "callback-card.json";
const LAST_SHOWN_KEY = "last_shown_date";
const DISABLED_KEY = "disabled";

interface CallbackCardData {
  visible: boolean;
  line: string;
  chips: MemoryChip[];
  expanded: boolean;
  /** Chip id whose delete just failed, for the brief inline flash. */
  deleteFailedId: string | null;
}

export interface CallbackCardState extends CallbackCardData {
  expand: () => void;
  deleteChip: (id: string) => void;
  dismiss: () => void;
  turnOff: () => void;
  /** Silent clear (sign-out, call start); dismiss() is the user-facing one. */
  reset: () => void;
}

const INITIAL: CallbackCardData = {
  visible: false,
  line: "",
  chips: [],
  expanded: false,
  deleteFailedId: null,
};

interface CallbackCardInputs {
  presentation: "hidden" | "panel" | "pill" | "pointing";
  signedIn: boolean;
  callLive: boolean;
  draftActive: boolean;
}

/**
 * The daily catch-up card state machine. At most one card per user-local
 * calendar day: the day is consumed (persisted in tauri-plugin-store, so an
 * app restart can't re-show it) only when a card actually renders. Every
 * failure path is silent by design - this is an ambient nicety, and a card
 * that shows something generic or an error would be worse than no card.
 */
export function useCallbackCard(inputs: CallbackCardInputs): CallbackCardState {
  const { presentation, signedIn, callLive, draftActive } = inputs;
  const [data, setData] = useState<CallbackCardData>(INITIAL);

  const dataRef = useRef(data);
  dataRef.current = data;

  const storeRef = useRef<Store | null>(null);
  const fetchInFlightRef = useRef(false);
  const shownAtRef = useRef<number | null>(null);
  const engagedTrackedRef = useRef(false);
  const deleteFailedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (deleteFailedTimerRef.current) clearTimeout(deleteFailedTimerRef.current);
    },
    [],
  );

  // The window's height follows visibility: OverlayRoot watches callbackCard
  // .visible and drives set_slot_height, so reset() only clears React state.
  const reset = useCallback(() => {
    if (!dataRef.current.visible) return;
    setData(INITIAL);
    shownAtRef.current = null;
  }, []);

  // A call starting or a draft arriving takes the slot; the catch-up bows out
  // silently (no dismissed analytics - the user didn't act on it).
  useEffect(() => {
    if (callLive || draftActive) reset();
  }, [callLive, draftActive, reset]);

  // The trigger: entering the signed-in bar, at most once per local day.
  useEffect(() => {
    if (presentation !== "panel" || !signedIn || callLive || draftActive) return;
    if (dataRef.current.visible || fetchInFlightRef.current) return;

    let cancelled = false;
    fetchInFlightRef.current = true;

    (async () => {
      try {
        const store =
          storeRef.current ?? (storeRef.current = await load(CALLBACK_STORE));
        if ((await store.get<boolean>(DISABLED_KEY)) === true) return;
        const today = localDateString();
        if ((await store.get<string>(LAST_SHOWN_KEY)) === today) return;

        const payload = await fetchCallbackCard(FETCH_BUDGET_MS);
        if (cancelled || payload === null) return;
        // Re-check the world after the await: a call or draft may have
        // started while the fetch was in flight.
        if (presentation !== "panel") return;

        setData({ ...INITIAL, visible: true, line: payload.line, chips: payload.chips });
        shownAtRef.current = Date.now();
        engagedTrackedRef.current = false;
        // Day consumed only now, when a card actually rendered (OverlayRoot
        // grows the window off this visibility change).
        await store.set(LAST_SHOWN_KEY, today);
        await store.save();
        trackEvent("callback_card_shown", { chips: payload.chips.length });
      } catch (err) {
        logError("useCallbackCard: trigger", err);
      } finally {
        fetchInFlightRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [presentation, signedIn, callLive, draftActive]);

  const trackEngagedOnce = useCallback(() => {
    if (engagedTrackedRef.current || shownAtRef.current === null) return;
    if (Date.now() - shownAtRef.current <= ENGAGED_WINDOW_MS) {
      engagedTrackedRef.current = true;
      trackEvent("callback_card_engaged_10s", {});
    }
  }, []);

  const expand = useCallback(() => {
    trackEngagedOnce();
    setData((prev) => (prev.visible ? { ...prev, expanded: !prev.expanded } : prev));
  }, [trackEngagedOnce]);

  const deleteChip = useCallback(
    (id: string) => {
      const chip = dataRef.current.chips.find((c) => c.id === id);
      if (!chip) return;
      trackEngagedOnce();
      // Optimistic: the chip vanishes now, comes back only if the server says no.
      setData((prev) => ({
        ...prev,
        chips: prev.chips.filter((c) => c.id !== id),
        deleteFailedId: null,
      }));
      deleteMemory(id).then((ok) => {
        if (ok) {
          // Dimensions only, never the memory's content (privacy contract).
          trackEvent("callback_chip_deleted", { source: chip.source ?? "unknown" });
          return;
        }
        setData((prev) =>
          prev.visible
            ? { ...prev, chips: [...prev.chips, chip], deleteFailedId: id }
            : prev,
        );
        if (deleteFailedTimerRef.current) clearTimeout(deleteFailedTimerRef.current);
        deleteFailedTimerRef.current = setTimeout(() => {
          deleteFailedTimerRef.current = null;
          setData((prev) => ({ ...prev, deleteFailedId: null }));
        }, DELETE_FAILED_FLASH_MS);
      });
    },
    [trackEngagedOnce],
  );

  const dismiss = useCallback(() => {
    if (!dataRef.current.visible) return;
    reset();
    trackEvent("callback_card_dismissed", {});
  }, [reset]);

  const turnOff = useCallback(() => {
    (async () => {
      try {
        const store =
          storeRef.current ?? (storeRef.current = await load(CALLBACK_STORE));
        await store.set(DISABLED_KEY, true);
        await store.save();
      } catch (err) {
        logError("useCallbackCard: turnOff", err);
      }
    })();
    reset();
    trackEvent("callback_card_toggle_off", {});
  }, [reset]);

  return { ...data, expand, deleteChip, dismiss, turnOff, reset };
}
