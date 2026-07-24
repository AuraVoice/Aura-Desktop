import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, type RemoteParticipant } from "livekit-client";
import { invoke } from "@tauri-apps/api/core";
import { validateAgentDataMessage } from "../lib/agentData";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { trackEvent } from "../lib/analytics";
import {
  refineDraft,
  steppedLength,
  type DraftChannel,
  type ArtifactKind,
  type DraftContentFormat,
  type DraftLength,
  type RefineChip,
} from "../lib/draft";
import { logError, logInfo } from "../lib/log";
import { installDraftDebugInjector } from "../debug/draftDebug";
import {
  pendingDraftRestoreAction,
  type DraftPresentation,
} from "./draftVisibility";

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
  artifactKind: ArtifactKind | null;
  contentFormat: DraftContentFormat;
  title: string;
  language: string;
  persisted: boolean;
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
  return value === "on_screen" ||
    value === "email_reply" ||
    value === "cold_dm" ||
    value === "snippet"
    ? value
    : null;
}

function asLength(value: unknown): DraftLength | null {
  return value === "short" || value === "medium" || value === "detailed" ? value : null;
}

function asArtifactKind(value: unknown): ArtifactKind | null {
  return value === "command" ||
    value === "code" ||
    value === "config" ||
    value === "prompt" ||
    value === "steps" ||
    value === "checklist" ||
    value === "note"
    ? value
    : null;
}

function asContentFormat(value: unknown, channel: DraftChannel): DraftContentFormat {
  if (value === "plain_text" || value === "code" || value === "markdown") return value;
  return channel === "snippet" ? "code" : "plain_text";
}

export function parseCreatedDraft(payload: Record<string, unknown>): DraftInfo | null {
  const channel = asChannel(payload.channel);
  const text = typeof payload.text === "string" ? payload.text : "";
  const draftId = typeof payload.draft_id === "string" ? payload.draft_id : "";
  // Only channel/text/id are load-bearing. length just drives the shorter/longer
  // chip ladder, and adaptive channels (on_screen, snippet) legitimately ship no
  // ladder length - dropping the whole draft over a missing/unknown length left
  // the card stuck on its skeleton (see lessons-learnt, forced-release-order enum
  // drift). Default it instead of rejecting the draft.
  if (!channel || !text || !draftId) return null;
  const length = asLength(payload.length) ?? "medium";
  return {
    draftId,
    channel,
    length,
    text,
    contextSummary: typeof payload.context_summary === "string" ? payload.context_summary : "",
    revision: typeof payload.revision === "number" ? payload.revision : 1,
    artifactKind: asArtifactKind(payload.artifact_kind),
    contentFormat: asContentFormat(payload.content_format, channel),
    title: typeof payload.title === "string" ? payload.title.slice(0, 80) : "",
    language: typeof payload.language === "string" ? payload.language.slice(0, 32) : "",
    persisted: typeof payload.persisted === "boolean" ? payload.persisted : true,
  };
}

/**
 * The Buddy Drafts card state machine. Lives in OverlayRoot (which stays
 * mounted across presentations and calls) so a draft survives call teardown;
 * new drafts arrive over the LiveKit data channel from the voice tool, refine
 * chips always go over REST (one code path during and after the call), and
 * OverlayRoot grows/shrinks the window's slot off this card's phase (a fresh
 * draft or artifact summons the panel when hidden and restores it from pill).
 */
export function useDraftCard(
  room: Room | null,
  presentation: DraftPresentation,
): DraftCardState {
  const [data, setData] = useState<DraftCardData>(INITIAL);

  // Mirrors for imperative reads inside stable callbacks. presentation decides
  // whether a fresh draft must first pull the window out of pill mode.
  const dataRef = useRef(data);
  dataRef.current = data;
  const presentationRef = useRef(presentation);
  presentationRef.current = presentation;
  const pendingPanelRestoreRef = useRef(false);

  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refineFailedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      if (refineFailedTimerRef.current) clearTimeout(refineFailedTimerRef.current);
    },
    [],
  );

  const ensurePanelVisible = useCallback(async () => {
    // Requested text must be visible even when the user hid or minimized Buddy.
    // Pointing is allowed to finish; if it restores Hidden, the effect below
    // restores the companion immediately afterward.
    const current = presentationRef.current;
    if (current !== "hidden") return;
    try {
      await invoke("summon");
    } catch (err) {
      logError("useDraftCard: ensure panel visible", err);
    }
  }, []);

  const requestPanelVisibility = useCallback(() => {
    if (presentationRef.current === "pointing") {
      pendingPanelRestoreRef.current = true;
      return;
    }
    void ensurePanelVisible();
  }, [ensurePanelVisible]);

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
          requestPanelVisibility();
          break;
        }
        case "draft.created": {
          const draft = parseCreatedDraft(payload);
          if (!draft) {
            logError("useDraftCard: malformed draft.created", JSON.stringify(Object.keys(payload)));
            return;
          }
          setData({ ...INITIAL, phase: "shown", channel: draft.channel, draft });
          requestPanelVisibility();
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
          logInfo("useDraftCard: draft failed", `reason=${reason}`);
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
          if (reason === "quota_exceeded") requestPanelVisibility();
          break;
        }
        default:
          break;
      }
    },
    [markRefineFailed, requestPanelVisibility],
  );

  // An artifact can arrive while the full-screen pointer is in flight. Let the
  // pointer finish, then restore only that newly-arrived artifact. An existing
  // draft must not immediately reopen the overlay after the user hides it.
  useEffect(() => {
    const action = pendingDraftRestoreAction(
      pendingPanelRestoreRef.current,
      data.phase,
      presentation,
    );
    if (action === "none" || action === "wait") return;
    pendingPanelRestoreRef.current = false;
    if (action === "restore") void ensurePanelVisible();
  }, [data.phase, presentation, ensurePanelVisible]);

  // New drafts ride the same data channel as element.point / screen_save.created
  // (see useScreenSight) - validated for sender/topic/schema first
  // (agentData.ts) so a non-agent participant can't inject a draft, then
  // ignore-unknown, never throw into LiveKit.
  useEffect(() => {
    if (!room) return;

    function onDataReceived(
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: unknown,
      topic?: string,
    ) {
      try {
        const verdict = validateAgentDataMessage(payload, participant, topic);
        if (verdict.kind !== "valid" || !verdict.type.startsWith("draft.")) return;
        handleDraftEvent({ type: verdict.type, payload: verdict.payload });
      } catch (err) {
        logError("useDraftCard: onDataReceived", err);
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
        trackEvent("draft_card_copied", {
          channel: draft.channel,
          length: draft.length,
          artifactKind: draft.artifactKind ?? "message",
        });
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
    pendingPanelRestoreRef.current = false;
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
  }, []);

  const dismiss = useCallback(() => {
    const channel = dataRef.current.channel;
    if (dataRef.current.phase === "idle") return;
    reset();
    trackEvent("draft_card_dismissed", { channel: channel ?? "unknown" });
  }, [reset]);

  return { ...data, copy, refine, dismiss, reset };
}
