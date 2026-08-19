import { useCallback, useEffect, useRef, useState } from "react";
import { RoomEvent, type Room, type RemoteParticipant } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { validateAgentDataMessage } from "../../lib/agentData";
import { logError, logInfo } from "../../lib/log";
import {
  MATERIAL_REQUEST_TYPE,
  MAX_MATERIAL_BYTES,
  parseMaterialRequest,
  publishInterviewMaterial,
  publishOverlayShown,
  type MaterialRequest,
} from "./interviewMaterial";

/**
 * The desktop half of the Interview Mode job-description transfer.
 *
 * Buddy's interview setup asks whether the user has the job description. When
 * they say yes, the worker asks for one paste box; this hook draws it, proves it
 * is on screen, takes the paste, and streams it back. The text never touches
 * disk, the clipboard, or any API here: it goes straight onto the byte stream and
 * the component state is cleared.
 *
 * The ack is the part worth being careful about. It is published by
 * `confirmDisplayed`, called from the card's own layout effect once it has
 * actually rendered, never on packet arrival. The worker speaks "the box is on
 * your screen" off the back of it, so acknowledging early would make Buddy lie
 * about something the user is looking straight at.
 *
 * Only the newest request is ever live. The worker increments `revision` per
 * request and accepts exactly one stream per `(interview_id, revision)`, so a box
 * superseded while it was open is replaced rather than stacked: two boxes on
 * screen would let the user paste into one the worker has already stopped
 * listening to.
 */

export type InterviewPastePhase = "idle" | "open" | "sending" | "sent" | "error";

interface InterviewMaterialData {
  phase: InterviewPastePhase;
  request: MaterialRequest | null;
  errorReason: string | null;
}

export interface InterviewMaterialState extends InterviewMaterialData {
  /** Send the pasted text back to the worker and close the box. */
  submit: (text: string) => void;
  /** Close without sending; the worker's own timeout takes over from here. */
  dismiss: () => void;
  /** Silent clear (sign-out, session end). */
  reset: () => void;
  /** Called by the card once this request's box is genuinely rendered. */
  confirmDisplayed: () => void;
  maxBytes: number;
}

const INITIAL: InterviewMaterialData = {
  phase: "idle",
  request: null,
  errorReason: null,
};

function requestKey(request: MaterialRequest): string {
  return `${request.interviewId}:${request.revision}`;
}

export function useInterviewMaterial(room: Room | null): InterviewMaterialState {
  const [data, setData] = useState<InterviewMaterialData>(INITIAL);
  const dataRef = useRef(data);
  dataRef.current = data;

  const roomRef = useRef(room);
  roomRef.current = room;

  // Keyed by (interview_id, revision) so the worker's one idempotent resend is
  // deduplicated instead of drawing a second box or acking twice.
  const ackedRef = useRef("");
  const ackInFlightRef = useRef("");

  const reset = useCallback(() => {
    ackedRef.current = "";
    ackInFlightRef.current = "";
    setData(INITIAL);
  }, []);

  // The box is useless behind a hidden or minimized companion: the worker is
  // already telling the user to look at it.
  const ensureVisible = useCallback(async () => {
    try {
      await invoke("summon");
    } catch (err) {
      logError("useInterviewMaterial: summon", err);
    }
  }, []);

  const handleRequest = useCallback(
    (request: MaterialRequest) => {
      const key = requestKey(request);
      const current = dataRef.current.request;
      // The worker resends once at the same id and revision when it has not seen
      // an ack yet. That is the same box, so it must not reopen a box the user is
      // already typing in, and must not reset a send in flight.
      if (current && requestKey(current) === key && dataRef.current.phase !== "idle") {
        return;
      }
      ackedRef.current = "";
      ackInFlightRef.current = "";
      setData({ phase: "open", request, errorReason: null });
      void ensureVisible();
      logInfo(
        "useInterviewMaterial: paste box requested",
        `revision=${request.revision}`,
      );
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
    void publishOverlayShown(activeRoom, request)
      .then(() => {
        ackedRef.current = key;
      })
      .catch((err) => logError("useInterviewMaterial: overlay ack", err))
      .finally(() => {
        if (ackInFlightRef.current === key) ackInFlightRef.current = "";
      });
  }, []);

  const submit = useCallback((text: string) => {
    const { request, phase } = dataRef.current;
    const activeRoom = roomRef.current;
    if (!request || !activeRoom || phase !== "open") return;
    const trimmed = text.trim();
    if (!trimmed) return;

    setData((prev) => ({ ...prev, phase: "sending", errorReason: null }));
    void publishInterviewMaterial(activeRoom, request, trimmed)
      .then((bytes) => {
        logInfo(
          "useInterviewMaterial: job description sent",
          `revision=${request.revision} bytes=${bytes}`,
        );
        // Cleared, not kept. The pasted text has left the building and this hook
        // is not a place for it to sit for the rest of the call.
        setData({ phase: "sent", request: null, errorReason: null });
      })
      .catch((err) => {
        logError("useInterviewMaterial: send failed", err);
        setData((prev) => ({
          ...prev,
          phase: "error",
          errorReason: "send-failed",
        }));
      });
  }, []);

  const dismiss = useCallback(() => {
    // No packet on the way out. The contract has no "user closed the box"
    // message, and the worker's own arrival timeout already falls back to asking
    // for the role by voice, so inventing one here would be a second protocol.
    logInfo("useInterviewMaterial: paste box dismissed", "");
    setData({ phase: "idle", request: null, errorReason: null });
  }, []);

  useEffect(() => {
    if (!room) return;
    let disposed = false;

    function onDataReceived(
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) {
      try {
        const verdict = validateAgentDataMessage(payload, participant, topic);
        if (verdict.kind !== "valid" || verdict.type !== MATERIAL_REQUEST_TYPE) return;
        const request = parseMaterialRequest(verdict.payload);
        if (!request) {
          // Never open a box we cannot correlate: the paste would be rejected on
          // arrival with nothing on screen explaining why.
          logInfo("useInterviewMaterial: request rejected", "unparseable");
          return;
        }
        if (disposed) return;
        handleRequest(request);
      } catch (err) {
        logError("useInterviewMaterial: onDataReceived", err);
      }
    }

    room.on(RoomEvent.DataReceived, onDataReceived);
    return () => {
      disposed = true;
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room, handleRequest]);

  // A box outlives its usefulness the moment the call it belongs to ends: the
  // worker that armed it is gone, so a paste would land nowhere.
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
    maxBytes: MAX_MATERIAL_BYTES,
  };
}
