import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  MEETING_CALL_GONE,
  MEETING_CALL_SEEN,
  type AmbientCallPayload,
  type AmbientGonePayload,
} from "../lib/ipcEvents";
import type { UpcomingMeeting } from "../lib/calendar";
import { isEligibleForNotes } from "./useMeetingArm";
import type { OverlayPresentation } from "./overlayPresentation";
import type { RecordCallOutcome } from "./useMeetingCapture";
import { trackEvent } from "../lib/analytics";
import { logError, logInfo } from "../lib/log";

/** How long the card waits for an answer while it is actually on screen. */
export const PROMPT_TIMEOUT_MS = 15_000;
/** An ignored prompt gets ONE second chance this long later if the call is
 * still there and nothing is recording: the first prompt often fires on a
 * lobby page before the user has joined. */
const REPROMPT_AFTER_MS = 2 * 60_000;
/** Snooze brings the card back this long later, as often as the user asks. */
const SNOOZE_MS = 2 * 60_000;
/** After an expiry, no prompt for the same app for this long. */
const APP_COOLDOWN_MS = 60_000;
/** How long the cap / failure line stays up after a Record press. */
const STATUS_LINGER_MS = 6_000;
/** A calendar meeting counts as "this call" from this long before its start. */
const EVENT_LEAD_MS = 5 * 60_000;

export type MeetingPromptStatus = "prompt" | "starting" | "cap" | "failed";

type Decision = "declined" | "expired" | "recorded" | "snoozed";

export interface MeetingPromptInputs {
  uid: string | null;
  ownsRuntime: boolean;
  recording: boolean;
  events: UpcomingMeeting[];
  presentation: OverlayPresentation;
  dictationHold: boolean;
  callLive: boolean;
  interviewLive: boolean;
  chatOpen: boolean;
  recordCall: (
    call: AmbientCallPayload,
    event: UpcomingMeeting | null,
  ) => Promise<RecordCallOutcome>;
}

export interface MeetingPromptState {
  /** The card wants the notch slot. */
  visible: boolean;
  call: AmbientCallPayload | null;
  /** The eligible calendar meeting this call overlaps, if any. */
  event: UpcomingMeeting | null;
  status: MeetingPromptStatus;
  /** The auto-dismiss clock is running (the card is really on screen). */
  ticking: boolean;
  /** Bumped every time a fresh prompt appears, so the drain bar restarts. */
  promptId: number;
  record: () => void;
  decline: () => void;
  snooze: () => void;
}

/** The eligible calendar meeting overlapping `now`, nearest start first.
 * Mirrors the window the old per-event watch used, plus a short lead so a
 * punctual join still attaches. */
export function matchEvent(events: UpcomingMeeting[], now: number): UpcomingMeeting | null {
  let best: { event: UpcomingMeeting; start: number } | null = null;
  for (const event of events) {
    if (!isEligibleForNotes(event)) continue;
    const start = Date.parse(event.startTime);
    const end = Date.parse(event.endTime);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (now < start - EVENT_LEAD_MS || now > end) continue;
    if (!best || start < best.start) best = { event, start };
  }
  return best?.event ?? null;
}

/**
 * The "Record this meeting?" state machine. Rust's ambient scanner says which
 * call is on screen (`meeting-call-seen` / `meeting-call-gone`); this hook
 * decides whether to ask, summons the notch without taking focus, times the
 * card out while it is really visible, and remembers one answer per call
 * until that call goes away. Decisions are in memory only: a stored "Not now"
 * would outlive the call (native Zoom calls all share a key) and a restart
 * mid-call asking once more is the better failure.
 *
 * Suppression is deferral, never a decision: a live voice call, a running
 * Interview Companion, an active capture, or a presentation other than the
 * hidden/bar pair hides the card, and it returns with a fresh clock once the
 * suppressor lifts if the call is still there. A dictation hold or an open
 * chat only pauses the clock, because the card is still mounted underneath.
 */
export function useMeetingPrompt(inputs: MeetingPromptInputs): MeetingPromptState {
  const {
    uid,
    ownsRuntime,
    recording,
    events,
    presentation,
    dictationHold,
    callLive,
    interviewLive,
    chatOpen,
    recordCall,
  } = inputs;

  const [current, setCurrent] = useState<AmbientCallPayload | null>(null);
  const [visible, setVisible] = useState(false);
  const [status, setStatus] = useState<MeetingPromptStatus>("prompt");
  const [promptId, setPromptId] = useState(0);
  // Bumped when a re-prompt clears a decision, so the eligibility effect
  // re-runs without any input having changed.
  const [evalNonce, setEvalNonce] = useState(0);

  const currentRef = useRef<AmbientCallPayload | null>(null);
  const decisionsRef = useRef<Map<string, Decision>>(new Map());
  const repromptedRef = useRef<Set<string>>(new Set());
  const appCooldownRef = useRef<Map<string, number>>(new Map());
  const shownRef = useRef<Set<string>>(new Set());
  const summonedKeyRef = useRef<string | null>(null);
  const remainingRef = useRef(PROMPT_TIMEOUT_MS);
  const repromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lingerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  const eventsRef = useRef(events);
  eventsRef.current = events;
  const recordCallRef = useRef(recordCall);
  recordCallRef.current = recordCall;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const statusRef = useRef(status);
  statusRef.current = status;

  const clearRepromptTimer = useCallback(() => {
    if (repromptTimerRef.current !== null) {
      clearTimeout(repromptTimerRef.current);
      repromptTimerRef.current = null;
    }
  }, []);

  const clearLingerTimer = useCallback(() => {
    if (lingerTimerRef.current !== null) {
      clearTimeout(lingerTimerRef.current);
      lingerTimerRef.current = null;
    }
  }, []);

  const hide = useCallback(() => {
    setVisible(false);
    setStatus("prompt");
    clearLingerTimer();
  }, [clearLingerTimer]);

  /** Forget that THIS showing of the card was summoned or seen, so the next
   * showing for the same call starts as a fresh prompt (fresh clock, its own
   * summon, and a native dismiss of it counts as its own answer). */
  const resetPromptInstance = useCallback((callKey: string) => {
    shownRef.current.delete(callKey);
    if (summonedKeyRef.current === callKey) summonedKeyRef.current = null;
    remainingRef.current = PROMPT_TIMEOUT_MS;
  }, []);

  const resetAll = useCallback(() => {
    currentRef.current = null;
    decisionsRef.current.clear();
    repromptedRef.current.clear();
    appCooldownRef.current.clear();
    shownRef.current.clear();
    summonedKeyRef.current = null;
    remainingRef.current = PROMPT_TIMEOUT_MS;
    clearRepromptTimer();
    setCurrent(null);
    hide();
  }, [clearRepromptTimer, hide]);

  const decide = useCallback(
    (callKey: string, decision: Decision) => {
      decisionsRef.current.set(callKey, decision);
      hide();
    },
    [hide],
  );

  const handleSeen = useCallback((call: AmbientCallPayload) => {
    currentRef.current = call;
    setCurrent(call);
  }, []);

  const handleGone = useCallback(
    (callKey: string) => {
      if (currentRef.current?.callKey !== callKey) return;
      currentRef.current = null;
      decisionsRef.current.delete(callKey);
      repromptedRef.current.delete(callKey);
      shownRef.current.delete(callKey);
      summonedKeyRef.current = null;
      clearRepromptTimer();
      setCurrent(null);
      hide();
    },
    [clearRepromptTimer, hide],
  );

  // ── Scanner lifecycle ───────────────────────────────────────────────────
  // Listeners go up BEFORE the start command so the first scan's "seen" is
  // never missed; the command's own reply seeds a call already in progress.
  useEffect(() => {
    if (!uid || !ownsRuntime) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    Promise.all([
      listen<AmbientCallPayload>(MEETING_CALL_SEEN, (event) => {
        if (!disposed) handleSeen(event.payload);
      }),
      listen<AmbientGonePayload>(MEETING_CALL_GONE, (event) => {
        if (!disposed) handleGone(event.payload.callKey);
      }),
    ])
      .then((fns) => {
        if (disposed) {
          fns.forEach((fn) => fn());
          return;
        }
        unlisteners.push(...fns);
        return invoke<AmbientCallPayload | null>("start_ambient_watch").then((snapshot) => {
          if (!disposed && snapshot) handleSeen(snapshot);
        });
      })
      .catch((err) => logError("useMeetingPrompt: start ambient watch", err));
    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
      resetAll();
      void invoke("stop_ambient_watch").catch(() => undefined);
    };
  }, [uid, ownsRuntime, handleSeen, handleGone, resetAll]);

  // ── Eligibility ─────────────────────────────────────────────────────────
  // Hide-class suppressors. A hidden card gets a fresh clock when it returns.
  const suppressed =
    uid === null
    || recording
    || callLive
    || interviewLive
    || (presentation !== "hidden" && presentation !== "bar");

  useEffect(() => {
    if (!current) return;
    const key = current.callKey;
    if (visible) {
      if (status !== "prompt") return;
      if (suppressed) {
        // Deferral, not an answer: the same call gets a fresh prompt later.
        resetPromptInstance(key);
        hide();
        return;
      }
      // The notch may be hidden when the card first wants the slot, or may
      // have gone hidden while chat or another surface covered the card
      // before it was ever seen. Summon once per showing; a hide after the
      // card WAS seen is the user's dismissal (handled below), not a cue to
      // pop back up. Never `summon` and never force foreground: the notch is
      // always-on-top and must appear without pulling focus off the call.
      if (
        presentation === "hidden"
        && !shownRef.current.has(key)
        && summonedKeyRef.current !== key
      ) {
        summonedKeyRef.current = key;
        invoke("summon_bar").catch((err) => logError("useMeetingPrompt: summon_bar", err));
      }
      return;
    }
    if (suppressed) return;
    if (decisionsRef.current.has(key)) return;
    const cooldownUntil = appCooldownRef.current.get(current.app) ?? 0;
    if (Date.now() < cooldownUntil) return;
    resetPromptInstance(key);
    setStatus("prompt");
    setPromptId((id) => id + 1);
    setVisible(true);
  }, [current, visible, suppressed, status, presentation, evalNonce, hide, resetPromptInstance]);

  // A native dismiss (double-tap, Escape) while the card is up is an answer,
  // not a glitch: treat it as Not now rather than summoning straight back.
  useEffect(() => {
    if (!visible || status !== "prompt" || presentation !== "hidden") return;
    const key = currentRef.current?.callKey;
    if (!key || !shownRef.current.has(key)) return;
    trackEvent("meeting_prompt_declined", {
      app: currentRef.current?.app ?? "unknown",
      has_event: matchEvent(eventsRef.current, Date.now()) !== null,
      reprompt: repromptedRef.current.has(key),
      dismissed: true,
    });
    decide(key, "declined");
  }, [visible, status, presentation, decide]);

  // A tray "Capture now" while the card is up answers it.
  useEffect(() => {
    if (!recording || !visible || status !== "prompt") return;
    const key = currentRef.current?.callKey;
    if (key) decide(key, "recorded");
    else hide();
  }, [recording, visible, status, decide, hide]);

  // ── Auto-dismiss clock ──────────────────────────────────────────────────
  // Runs only while the card can actually be seen; a dictation hold or an
  // open chat pauses it and the remainder carries over.
  const ticking =
    visible
    && status === "prompt"
    && presentation === "bar"
    && !dictationHold
    && !chatOpen;

  const expire = useCallback(
    (callKey: string, app: string) => {
      appCooldownRef.current.set(app, Date.now() + APP_COOLDOWN_MS);
      trackEvent("meeting_prompt_expired", {
        app,
        has_event: matchEvent(eventsRef.current, Date.now()) !== null,
        reprompt: repromptedRef.current.has(callKey),
      });
      decide(callKey, "expired");
      if (repromptedRef.current.has(callKey)) return;
      clearRepromptTimer();
      repromptTimerRef.current = setTimeout(() => {
        repromptTimerRef.current = null;
        if (currentRef.current?.callKey !== callKey) return;
        if (recordingRef.current) return;
        if (decisionsRef.current.get(callKey) !== "expired") return;
        repromptedRef.current.add(callKey);
        decisionsRef.current.delete(callKey);
        resetPromptInstance(callKey);
        setEvalNonce((nonce) => nonce + 1);
      }, REPROMPT_AFTER_MS);
    },
    [decide, clearRepromptTimer, resetPromptInstance],
  );

  useEffect(() => {
    if (!ticking) return;
    const call = currentRef.current;
    if (!call) return;
    if (!shownRef.current.has(call.callKey)) {
      shownRef.current.add(call.callKey);
      trackEvent("meeting_prompt_shown", {
        app: call.app,
        has_event: matchEvent(eventsRef.current, Date.now()) !== null,
        reprompt: repromptedRef.current.has(call.callKey),
      });
    }
    const startedAt = Date.now();
    const id = setTimeout(() => expire(call.callKey, call.app), remainingRef.current);
    return () => {
      clearTimeout(id);
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAt));
    };
  }, [ticking, promptId, expire]);

  useEffect(() => () => {
    clearRepromptTimer();
    clearLingerTimer();
  }, [clearRepromptTimer, clearLingerTimer]);

  // ── Answers ─────────────────────────────────────────────────────────────
  const event = current ? matchEvent(events, Date.now()) : null;

  const decline = useCallback(() => {
    // The X also closes the brief cap / failure line.
    if (visibleRef.current && (statusRef.current === "cap" || statusRef.current === "failed")) {
      hide();
      return;
    }
    const call = currentRef.current;
    if (!call || !visibleRef.current || statusRef.current !== "prompt") return;
    trackEvent("meeting_prompt_declined", {
      app: call.app,
      has_event: matchEvent(eventsRef.current, Date.now()) !== null,
      reprompt: repromptedRef.current.has(call.callKey),
      dismissed: false,
    });
    decide(call.callKey, "declined");
  }, [decide, hide]);

  const snooze = useCallback(() => {
    const call = currentRef.current;
    if (!call || !visibleRef.current || statusRef.current !== "prompt") return;
    trackEvent("meeting_prompt_snoozed", {
      app: call.app,
      has_event: matchEvent(eventsRef.current, Date.now()) !== null,
      reprompt: repromptedRef.current.has(call.callKey),
    });
    decide(call.callKey, "snoozed");
    clearRepromptTimer();
    repromptTimerRef.current = setTimeout(() => {
      repromptTimerRef.current = null;
      if (currentRef.current?.callKey !== call.callKey) return;
      if (recordingRef.current) return;
      if (decisionsRef.current.get(call.callKey) !== "snoozed") return;
      decisionsRef.current.delete(call.callKey);
      resetPromptInstance(call.callKey);
      setEvalNonce((nonce) => nonce + 1);
    }, SNOOZE_MS);
  }, [decide, clearRepromptTimer, resetPromptInstance]);

  const record = useCallback(() => {
    const call = currentRef.current;
    if (!call || !visibleRef.current || statusRef.current !== "prompt") return;
    const matched = matchEvent(eventsRef.current, Date.now());
    trackEvent("meeting_prompt_recorded", {
      app: call.app,
      has_event: matched !== null,
      reprompt: repromptedRef.current.has(call.callKey),
    });
    decisionsRef.current.set(call.callKey, "recorded");
    setStatus("starting");
    void recordCallRef.current(call, matched).then((outcome) => {
      if (currentRef.current?.callKey !== call.callKey) return;
      if (outcome === "started" || outcome === "skipped") {
        hide();
        return;
      }
      logInfo("useMeetingPrompt", `record failed: ${outcome}`);
      // A pressed button must never do nothing: say why, briefly, then go.
      setStatus(outcome);
      clearLingerTimer();
      lingerTimerRef.current = setTimeout(() => {
        lingerTimerRef.current = null;
        hide();
      }, STATUS_LINGER_MS);
    });
  }, [hide, clearLingerTimer]);

  return {
    visible,
    call: current,
    event,
    status,
    ticking,
    promptId,
    record,
    decline,
    snooze,
  };
}
