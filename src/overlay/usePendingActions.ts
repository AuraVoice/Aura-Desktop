import { useCallback, useEffect, useRef, useState } from "react";
import { RoomEvent, type RemoteParticipant, type Room } from "livekit-client";
import { validateAgentDataMessage } from "../lib/agentData";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { logError } from "../lib/log";
import {
  approvePendingAction,
  fetchPendingActions,
  proposeAction,
  rejectPendingAction,
  type PendingAction,
  type PendingActionTool,
  type ProposeResult,
} from "../lib/pendingActions";

const DONE_OUTCOME_MS = 8_000;

export interface PendingActionsState {
  /** The card to show: an outcome first, otherwise the newest pending action. */
  current: PendingAction | null;
  /** True while the card is showing the result of the user's click. */
  showingOutcome: boolean;
  busy: boolean;
  error: string | null;
  refresh: () => void;
  approve: (approvalId: string) => void;
  reject: (approvalId: string) => void;
  dismissOutcome: () => void;
  propose: (tool: PendingActionTool, args: Record<string, string>) => Promise<ProposeResult>;
}

/**
 * The approval queue behind ActionApprovalCard.
 *
 * Three things ask it to look: the voice worker's `action.proposed` message
 * (a tool just prepared something mid-call), a chat turn that ran one of the
 * approval tools (OverlayRoot calls refresh), and a draft's Post button
 * (propose). All three only trigger a GET /actions/pending; the list is the
 * backend's, so a card never shows something the server does not hold.
 */
export function usePendingActions(room: Room | null, uid: string | null): PendingActionsState {
  const [items, setItems] = useState<PendingAction[]>([]);
  const [outcome, setOutcome] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const requestSeq = useRef(0);

  const refresh = useCallback(() => {
    if (!uidRef.current) return;
    const seq = ++requestSeq.current;
    const requestUid = uidRef.current;
    fetchPendingActions()
      .then((next) => {
        if (seq !== requestSeq.current || uidRef.current !== requestUid) return;
        setItems(next);
      })
      .catch((err) => {
        if (err instanceof AuthRequiredError) return;
        logError("usePendingActions: refresh", err);
      });
  }, []);

  // One account's cards never survive into the next session.
  useEffect(() => {
    requestSeq.current += 1;
    setItems([]);
    setOutcome(null);
    setBusy(false);
    setError(null);
    if (uid) refresh();
  }, [uid, refresh]);

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
        if (verdict.kind === "valid" && verdict.type === "action.proposed") refresh();
      } catch (err) {
        logError("usePendingActions: onDataReceived", err);
      }
    }
    room.on(RoomEvent.DataReceived, onDataReceived);
    return () => {
      room.off(RoomEvent.DataReceived, onDataReceived);
    };
  }, [room, refresh]);

  // Drop cards when they expire server-side, so an ignored card goes away on
  // its own instead of offering a click that can only fail.
  useEffect(() => {
    const expiries = items
      .map((item) => Date.parse(item.expiresAt))
      .filter((value) => Number.isFinite(value));
    if (expiries.length === 0) return;
    const delay = Math.max(0, Math.min(...expiries) - Date.now()) + 250;
    const timer = setTimeout(() => {
      setItems((current) => current.filter((item) => {
        const expiry = Date.parse(item.expiresAt);
        return !Number.isFinite(expiry) || expiry > Date.now();
      }));
    }, delay);
    return () => clearTimeout(timer);
  }, [items]);

  useEffect(() => {
    if (!outcome || outcome.status !== "done") return;
    const timer = setTimeout(() => setOutcome(null), DONE_OUTCOME_MS);
    return () => clearTimeout(timer);
  }, [outcome]);

  const approve = useCallback((approvalId: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    approvePendingAction(approvalId)
      .then((item) => {
        setItems((current) => current.filter((entry) => entry.approvalId !== approvalId));
        if (item) setOutcome(item);
        else setError("That one is gone. Ask again to prepare it.");
      })
      .catch((err) => {
        if (err instanceof AuthRequiredError) {
          void routeToDashboardForExpiredSession();
          return;
        }
        logError("usePendingActions: approve", err);
        // The click may still have landed (a timeout after the provider
        // accepted). Never offer a blind retry: re-read the real state.
        setError("Aura couldn't confirm that went through. Check before trying again.");
        refresh();
      })
      .finally(() => setBusy(false));
  }, [busy, refresh]);

  const reject = useCallback((approvalId: string) => {
    setItems((current) => current.filter((entry) => entry.approvalId !== approvalId));
    setError(null);
    rejectPendingAction(approvalId).catch((err) => {
      if (err instanceof AuthRequiredError) return;
      logError("usePendingActions: reject", err);
    });
  }, []);

  const dismissOutcome = useCallback(() => {
    setOutcome(null);
    setError(null);
  }, []);

  const propose = useCallback(async (tool: PendingActionTool, args: Record<string, string>) => {
    const result = await proposeAction(tool, args, crypto.randomUUID().replace(/-/g, ""));
    if (result.kind === "proposed") {
      setOutcome(null);
      setItems((current) => [
        result.item,
        ...current.filter((entry) => entry.approvalId !== result.item.approvalId),
      ]);
    }
    return result;
  }, []);

  const current = outcome ?? items[0] ?? null;
  return {
    current,
    showingOutcome: outcome !== null,
    busy,
    error,
    refresh,
    approve,
    reject,
    dismissOutcome,
    propose,
  };
}
