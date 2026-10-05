import { useCallback, useEffect, useRef, useState } from "react";
import { type Room } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { useAgentDataMessage } from "../../lib/useAgentDataMessage";
import { logError, logInfo } from "../../lib/log";
import {
  CONTEXT_REQUEST_TYPE,
  MAX_CONTEXT_BYTES,
  parseContextRequest,
  publishContext,
  publishContextDismissed,
  publishContextShown,
  type ContextRequest,
  type InterviewContextParts,
} from "./interviewContext";

/**
 * The desktop half of the Interview Mode context transfer.
 *
 * Buddy's interview setup asks whether the user has a job description, a resume
 * or notes. When they say yes, the worker asks for one context card; this hook
 * draws it, proves it is on screen, takes what the user gave, and streams it
 * back. The text never touches disk or any API here: it goes straight onto the
 * byte stream and the card's state is cleared.
 *
 * The ack is the part worth being careful about. It is published by
 * `confirmDisplayed`, called from the card's own layout effect once it has
 * actually rendered, never on packet arrival. The worker speaks "the card is on
 * your screen" off the back of it, so acknowledging early would make Buddy lie
 * about something the user is looking straight at.
 *
 * Only the newest request is ever live. The worker increments `revision` per
 * request and accepts exactly one stream per `(interview_id, revision)`, so a
 * card superseded while it was open is replaced rather than stacked.
 */

export type InterviewContextPhase = "idle" | "open" | "sending" | "sent" | "error";

interface InterviewContextData {
  phase: InterviewContextPhase;
  request: ContextRequest | null;
  errorReason: string | null;
}

export interface InterviewContextState extends InterviewContextData {
  /** Send what the user gave back to the worker. Retryable after an error. */
  submit: (parts: InterviewContextParts) => void;
  /** Close without sending, and tell setup to carry on now. */
  dismiss: () => void;
  /** Silent clear (sign-out, session end). */
  reset: () => void;
  /** Called by the card once this request's card is genuinely rendered. */
  confirmDisplayed: () => void;
  maxBytes: number;
}

const INITIAL: InterviewContextData = {
  phase: "idle",
  request: null,
  errorReason: null,
};

function requestKey(request: ContextRequest): string {
  return `${request.interviewId}:${request.revision}`;
}

export function useInterviewContext(room: Room | null): InterviewContextState {
  const [data, setData] = useState<InterviewContextData>(INITIAL);
  const dataRef = useRef(data);
  dataRef.current = data;

  const roomRef = useRef(room);
  roomRef.current = room;

  // Keyed by (interview_id, revision) so the worker's one idempotent resend is
  // deduplicated instead of drawing a second card or acking twice.
  const ackedRef = useRef("");
  const ackInFlightRef = useRef("");

  const reset = useCallback(() => {
    ackedRef.current = "";
    ackInFlightRef.current = "";
    setData(INITIAL);
  }, []);

  // The card is useless behind a hidden or minimized companion: the worker is
  // already telling the user to look at it.
  const ensureVisible = useCallback(async () => {
    try {
      await invoke("summon");
    } catch (err) {
      logError("useInterviewContext: summon", err);
    }
  }, []);

  const handleRequest = useCallback(
    (request: ContextRequest) => {
      const key = requestKey(request);
      const current = dataRef.current.request;
      // The worker resends once at the same id and revision when it has not seen
      // an ack yet. That is the same card, so it must not reset one the user is
      // already filling in, nor a send in flight.
      if (current && requestKey(current) === key && dataRef.current.phase !== "idle") {
        return;
      }
      ackedRef.current = "";
      ackInFlightRef.current = "";
      setData({ phase: "open", request, errorReason: null });
      void ensureVisible();
      logInfo("useInterviewContext: card requested", `revision=${request.revision}`);
    },
    [ensureVisible],
  );

  const confirmDisplayed = useCallback(() => {
    const { request, phase } = dataRef.current;
    const activeRoom = roomRef.current;
    if (!request || !activeRoom || phase !== "open") return;
    const key = requestKey(request);
    if (ackedRef.current === key || ackInFlightRef.current === key) return;
    ackInFlightRef.current = key;
    void publishContextShown(activeRoom, request)
      .then(() => {
        ackedRef.current = key;
      })
      .catch((err) => logError("useInterviewContext: shown ack", err))
      .finally(() => {
        if (ackInFlightRef.current === key) ackInFlightRef.current = "";
      });
  }, []);

  const submit = useCallback((parts: InterviewContextParts) => {
    const { request, phase } = dataRef.current;
    const activeRoom = roomRef.current;
    // "error" is a live state: the worker only claims an arming once a payload
    // parses, so a send that failed on the way out can simply be sent again.
    if (!request || !activeRoom || (phase !== "open" && phase !== "error")) return;

    setData((prev) => ({ ...prev, phase: "sending", errorReason: null }));
    void publishContext(activeRoom, request, parts)
      .then((bytes) => {
        logInfo(
          "useInterviewContext: context sent",
          `revision=${request.revision} bytes=${bytes}`,
        );
        // Cleared, not kept. The text has left the building and this hook is not
        // a place for it to sit for the rest of the call.
        setData({ phase: "sent", request: null, errorReason: null });
      })
      .catch((err) => {
        logError("useInterviewContext: send failed", err);
        setData((prev) => ({ ...prev, phase: "error", errorReason: "send-failed" }));
      });
  }, []);

  const dismiss = useCallback(() => {
    const { request } = dataRef.current;
    const activeRoom = roomRef.current;
    logInfo("useInterviewContext: card dismissed", "");
    // Without this the worker would sit silent until its arrival bound ran out,
    // with the user wondering why Buddy stopped talking.
    if (request && activeRoom) {
      void publishContextDismissed(activeRoom, request).catch((err) =>
        logError("useInterviewContext: dismissed", err),
      );
    }
    setData(INITIAL);
  }, []);

  useAgentDataMessage(
    room,
    CONTEXT_REQUEST_TYPE,
    (event) => {
      const request = parseContextRequest(event.payload);
      if (!request) {
        // Never open a card we cannot correlate: what the user sends would be
        // rejected on arrival with nothing on screen explaining why.
        logInfo("useInterviewContext: request rejected", "unparseable");
        return;
      }
      handleRequest(request);
    },
    "useInterviewContext: onDataReceived",
  );

  // A card outlives its usefulness the moment the call it belongs to ends: the
  // worker that armed it is gone, so anything sent would land nowhere.
  useEffect(() => {
    if (room) return;
    if (dataRef.current.phase !== "idle") reset();
  }, [room, reset]);

  return {
    ...data,
    submit,
    dismiss,
    reset,
    confirmDisplayed,
    maxBytes: MAX_CONTEXT_BYTES,
  };
}
