import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { trackEvent } from "../lib/analytics";
import {
  refineDraft,
  steppedLength,
  type DraftChannel,
  type DraftLength,
  type RefineChip,
} from "../lib/draft";
import { logError } from "../lib/log";
import { installDraftDebugInjector } from "../debug/draftDebug";

const COPIED_FLASH_MS = 2500;
const REFINE_FAILED_FLASH_MS = 3000;

export type DraftPhase = "idle" | "generating" | "shown" | "refining" | "error";

export interface DraftInfo {
  draftId: string;
  channel: DraftChannel;
  length: DraftLength;
  text: string;
  contextSummary: string;
  revision: number;
}

interface DraftCardData {
  phase: DraftPhase;
  /** Known as soon as draft.generating arrives, before any text exists. */
  channel: DraftChannel | null;
  draft: DraftInfo | null;
  errorReason: string | null;
  copied: boolean;
  refineFailed: boolean;
}

export interface DraftCardState extends DraftCardData {
  copy: () => void;
  refine: (chip: RefineChip) => void;
  dismiss: () => void;
  /** Silent clear (sign-out); dismiss() is the user-facing, analytics-tracked one. */
  reset: () => void;
}

const INITIAL: DraftCardData = {
  phase: "idle",
  channel: null,
  draft: null,
  errorReason: null,
  copied: false,
  refineFailed: false,
};

interface DraftEvent {
  type: string;
  payload?: Record<string, unknown>;
}

function asChannel(value: unknown): DraftChannel | null {
  return value === "email_reply" || value === "cold_dm" ? value : null;
}

function asLength(value: unknown): DraftLength | null {
  return value === "short" || value === "medium" || value === "detailed" ? value : null;
}

function parseCreated(payload: Record<string, unknown>): DraftInfo | null {
  const channel = asChannel(payload.channel);
  const length = asLength(payload.length);
  const text = typeof payload.text === "string" ? payload.text : "";
  const draftId = typeof payload.draft_id === "string" ? payload.draft_id : "";
  if (!channel || !length || !text || !draftId) return null;
  return {
    draftId,
    channel,
    length,
    text,
    contextSummary: typeof payload.context_summary === "string" ? payload.context_summary : "",
    revision: typeof payload.revision === "number" ? payload.revision : 1,
  };
}

/**
 * The Buddy Drafts card state machine. Lives in OverlayRoot (which stays
 * mounted across presentations and calls) so a draft survives call teardown;
 * new drafts arrive over the LiveKit data channel from the voice tool, refine
 * chips always go over REST (one code path during and after the call), and
 * Rust is told to grow/shrink the window via set_draft_card_open.
 */
export function useDraftCard(
  room: Room | null,
  presentation: "hidden" | "panel" | "pill" | "pointing",
): DraftCardState {
  const [data, setData] = useState<DraftCardData>(INITIAL);

  // Mirrors for imperative reads inside stable callbacks. presentation decides
  // whether a fresh draft must first pull the window out of pill mode.
  const dataRef = useRef(data);
  dataRef.current = data;
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;

  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refineFailedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      if (refineFailedTimerRef.current) clearTimeout(refineFailedTimerRef.current);
    },
    [],
  );

  const openCardWindow = useCallback(async () => {
    try {
      // A draft arriving mid-pill force-restores the panel first; the card
      // only renders under the bar (pill/setup ignore the Rust flag too).
      if (presentationRef.current === "pill") {
        await invoke("pill_activated");
      }
      await invoke("set_draft_card_open", { open: true });
    } catch (err) {
      logError("useDraftCard: open card window", err);
    }
  }, []);

  const closeCardWindow = useCallback(() => {
    invoke("set_draft_card_open", { open: false }).catch((err) =>
      logError("useDraftCard: close card window", err),
    );
  }, []);

  const markRefineFailed = useCallback(() => {
    setData((prev) =>
      prev.draft ? { ...prev, phase: "shown", refineFailed: true } : prev,
    );
    if (refineFailedTimerRef.current) clearTimeout(refineFailedTimerRef.current);
    refineFailedTimerRef.current = setTimeout(() => {
      refineFailedTimerRef.current = null;
      setData((prev) => ({ ...prev, refineFailed: false }));
    }, REFINE_FAILED_FLASH_MS);
  }, []);

  const handleDraftEvent = useCallback(
    (event: DraftEvent) => {
      const payload = event.payload ?? {};
      switch (event.type) {
        case "draft.generating": {
          const channel = asChannel(payload.channel);
          if (payload.mode === "refine" && dataRef.current.draft) {
            setData((prev) => ({ ...prev, phase: "refining", refineFailed: false }));
          } else {
            setData((prev) => ({
              ...INITIAL,
              phase: "generating",
              channel: channel ?? prev.channel,
            }));
          }
          void openCardWindow();
          break;
        }
        case "draft.created": {
          const draft = parseCreated(payload);
          if (!draft) {
            logError("useDraftCard: malformed draft.created", JSON.stringify(Object.keys(payload)));
            return;
          }
          setData({ ...INITIAL, phase: "shown", channel: draft.channel, draft });
          void openCardWindow();
          break;
        }
        case "draft.updated": {
          setData((prev) => {
            if (!prev.draft || prev.draft.draftId !== payload.draft_id) return prev;
            return {
              ...prev,
              phase: "shown",
              refineFailed: false,
              draft: {
                ...prev.draft,
                text: typeof payload.text === "string" ? payload.text : prev.draft.text,
                length: asLength(payload.length) ?? prev.draft.length,
                revision:
                  typeof payload.revision === "number"
                    ? payload.revision
                    : prev.draft.revision + 1,
              },
            };
          });
          break;
        }
        case "draft.failed": {
          const reason = typeof payload.reason === "string" ? payload.reason : "model_error";
          if (dataRef.current.draft) {
            // A failed refine keeps the last good draft on screen.
            markRefineFailed();
            return;
          }
          if (dataRef.current.phase === "idle" && reason !== "quota_exceeded") {
            // Nothing was showing and Buddy already spoke the failure; a card
            // popping up just to display an error would be noise. Quota is the
            // exception: it deserves a durable, readable explanation.
            return;
          }
          setData((prev) => ({ ...prev, phase: "error", draft: null, errorReason: reason }));
          if (reason === "quota_exceeded") void openCardWindow();
          break;
        }
        default:
          break;
      }
    },
    [openCardWindow, markRefineFailed],
  );

  // New drafts ride the same data channel as element.point / screen_save.created
  // (see useScreenSight) - parse-and-ignore-unknown, never throw into LiveKit.
  useEffect(() => {
    if (!room) return;

    function onDataReceived(payload: Uint8Array) {
      try {
        const event = JSON.parse(new TextDecoder().decode(payload)) as DraftEvent;
        if (typeof event.type === "string" && event.type.startsWith("draft.")) {
          handleDraftEvent(event);
        }
      } catch {
        // not JSON - not one of ours, ignore
      }
    }

    room.on(RoomEvent.DataReceived, onDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room, handleDraftEvent]);

  // Dev-only: window.__injectDraftEvent(...) drives this same handler so the
  // card is testable without a voice call (see debug/draftDebug.ts).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    return installDraftDebugInjector((event) => handleDraftEvent(event as DraftEvent));
  }, [handleDraftEvent]);

  const copy = useCallback(() => {
    const draft = dataRef.current.draft;
    if (!draft) return;
    writeText(draft.text)
      .then(() => {
        setData((prev) => ({ ...prev, copied: true }));
        if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = setTimeout(() => {
          copiedTimerRef.current = null;
          setData((prev) => ({ ...prev, copied: false }));
        }, COPIED_FLASH_MS);
        // Breakdown dimensions only - never the draft text (privacy contract).
        trackEvent("draft_card_copied", { channel: draft.channel, length: draft.length });
      })
      .catch((err) => logError("useDraftCard: copy to clipboard", err));
  }, []);

  const refine = useCallback(
    (chip: RefineChip) => {
      const { draft, phase } = dataRef.current;
      if (!draft || phase === "refining" || phase === "generating") return;

      let targetLength = draft.length;
      if (chip === "shorter" || chip === "longer") {
        const stepped = steppedLength(draft.length, chip === "shorter" ? -1 : 1);
        if (!stepped) return; // chip is disabled at the ladder's ends anyway
        targetLength = stepped;
      }

      setData((prev) => ({ ...prev, phase: "refining", refineFailed: false }));
      refineDraft({
        channel: draft.channel,
        length: targetLength,
        priorDraft: draft.text,
        chip,
        contextSummary: draft.contextSummary,
        draftId: draft.draftId,
      })
        .then((result) => {
          // A voice refine may have replaced the draft mid-flight; the newer
          // revision wins and this REST result is dropped.
          if (dataRef.current.draft?.draftId !== draft.draftId) return;
          if (result.reason !== "ok" || !result.text) {
            markRefineFailed();
            return;
          }
          setData((prev) =>
            prev.draft
              ? {
                  ...prev,
                  phase: "shown",
                  draft: {
                    ...prev.draft,
                    text: result.text,
                    length: targetLength,
                    revision: prev.draft.revision + 1,
                  },
                }
              : prev,
          );
        })
        .catch((err) => {
          if (err instanceof AuthRequiredError) {
            logError("useDraftCard: refine auth expired", err);
            void routeToDashboardForExpiredSession();
            return;
          }
          logError("useDraftCard: refine", err);
          markRefineFailed();
        });
    },
    [markRefineFailed],
  );

  const reset = useCallback(() => {
    if (dataRef.current.phase === "idle") return;
    if (copiedTimerRef.current) {
      clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = null;
    }
    if (refineFailedTimerRef.current) {
      clearTimeout(refineFailedTimerRef.current);
      refineFailedTimerRef.current = null;
    }
    setData(INITIAL);
    closeCardWindow();
  }, [closeCardWindow]);

  const dismiss = useCallback(() => {
    const channel = dataRef.current.channel;
    if (dataRef.current.phase === "idle") return;
    reset();
    trackEvent("draft_card_dismissed", { channel: channel ?? "unknown" });
  }, [reset]);

  return { ...data, copy, refine, dismiss, reset };
}
