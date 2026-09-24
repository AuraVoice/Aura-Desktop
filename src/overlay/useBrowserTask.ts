import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Room } from "livekit-client";
import { useTauriEvent } from "../lib/useTauriEvent";
import {
  BROWSER_TASK_APPROVAL,
  BROWSER_TASK_STATUS,
  type BrowserTaskApprovalPayload,
  type BrowserTaskStatusPayload,
} from "../lib/ipcEvents";
import {
  approveBrowserTask,
  browserTaskFailureMessage,
  browserTaskStatus,
  stopBrowserTask,
  watchBrowserTask,
} from "../lib/browserTask";
import { notifyLocal } from "../lib/desktopNotifications";
import { logError } from "../lib/log";

/**
 * The overlay's view of the one live browser task (src-tauri/src/agent_browser).
 *
 * Rust emits `browser-task-status` on every phase change and step and
 * `browser-task-approval` when the guard pauses on a risky click. This hook
 * folds those into what the slot card needs: a running chip, an approval
 * question, or a result. It is also the ONE producer of the task's
 * notifications, through the desktop broker, so a finished task toasts once
 * and lands in the inbox like every other event.
 */

const LIVE_PHASES = new Set(["starting", "launching", "running", "awaiting_approval"]);
/** How long a result card stays in the slot before it folds away on its own. */
const RESULT_LINGER_MS = 60_000;

export interface BrowserTaskState {
  /** The latest status while a task is live, else null. */
  status: BrowserTaskStatusPayload | null;
  live: boolean;
  approval: BrowserTaskApprovalPayload | null;
  /** The terminal payload, held for the result card until dismissed. */
  result: BrowserTaskStatusPayload | null;
  watching: boolean;
  stop: () => void;
  approve: (allow: boolean) => void;
  watch: () => void;
  dismissResult: () => void;
}

/** Tells a live Buddy call how the task ended, so Buddy can read it out
 * (voice/desktop_run.py `deliver_desktop_result`). Flat message on
 * `client_events`, like the other client controls. Never the page text:
 * the answer, the first sources and the reason are all it carries. */
async function publishDesktopResult(room: Room, payload: BrowserTaskStatusPayload): Promise<void> {
  const answer = (payload.answer ?? "").trim();
  const message = {
    type: "desktop.result",
    id: "browser_task",
    task_id: payload.taskId,
    status: payload.phase,
    answer: answer.length > 1200 ? `${answer.slice(0, 1197)}...` : answer,
    reason: payload.reason ?? "",
    sources: payload.sources.slice(0, 3),
  };
  await room.localParticipant.publishData(new TextEncoder().encode(JSON.stringify(message)), {
    reliable: true,
    topic: "client_events",
  });
}

export function useBrowserTask({
  uid,
  appHidden,
  room,
}: {
  uid: string | null;
  appHidden: boolean;
  /** The live voice room, when there is one. */
  room: Room | null;
}): BrowserTaskState {
  const [status, setStatus] = useState<BrowserTaskStatusPayload | null>(null);
  const [approval, setApproval] = useState<BrowserTaskApprovalPayload | null>(null);
  const [result, setResult] = useState<BrowserTaskStatusPayload | null>(null);
  const [watching, setWatching] = useState(false);
  const appHiddenRef = useRef(appHidden);
  appHiddenRef.current = appHidden;
  const uidRef = useRef(uid);
  uidRef.current = uid;
  const roomRef = useRef(room);
  roomRef.current = room;

  // Hydrate: the overlay can mount (or remount) while a task is running.
  useEffect(() => {
    let cancelled = false;
    browserTaskStatus()
      .then((payload) => {
        if (cancelled) return;
        setStatus(LIVE_PHASES.has(payload.phase) ? payload : null);
      })
      .catch((err) => logError("useBrowserTask: status", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const summon = useCallback(() => {
    // The notch may be hidden; the card has to be seen. summon_bar never
    // takes focus and refuses while the notch is being moved, which is fine.
    invoke("summon_bar").catch((err) => logError("useBrowserTask: summon_bar", err));
  }, []);

  useTauriEvent<BrowserTaskStatusPayload>(
    BROWSER_TASK_STATUS,
    (payload) => {
      if (LIVE_PHASES.has(payload.phase)) {
        setStatus(payload);
        setResult(null);
        if (payload.phase !== "awaiting_approval") setApproval(null);
        return;
      }
      setStatus(null);
      setApproval(null);
      setWatching(false);
      if (payload.phase === "idle") return;
      // A user Stop needs no card and no toast: they were looking at it.
      if (payload.phase === "stopped" && payload.reason === "user") {
        setResult(null);
        return;
      }
      setResult(payload);
      summon();
      const liveRoom = roomRef.current;
      if (liveRoom && liveRoom.state === "connected") {
        publishDesktopResult(liveRoom, payload).catch((err) =>
          logError("useBrowserTask: publish desktop.result", err),
        );
      }
      const owner = uidRef.current;
      if (!owner || !payload.taskId) return;
      const type =
        payload.phase === "done"
          ? "browser_task_ready"
          : payload.phase === "partial"
            ? "browser_task_partial"
            : "browser_task_failed";
      const title =
        payload.phase === "done"
          ? "Buddy finished a browser task"
          : payload.phase === "partial"
            ? "Buddy stopped early"
            : "A browser task did not finish";
      const answer = (payload.answer ?? "").trim();
      const body = answer
        ? answer.length > 140 ? `${answer.slice(0, 137)}...` : answer
        : browserTaskFailureMessage(payload.reason);
      void notifyLocal(
        {
          type,
          severity: payload.phase === "done" ? "success" : payload.phase === "partial" ? "warning" : "error",
          title,
          body,
          dedupKey: `browser_task:${payload.taskId}:${payload.phase}`,
          action: "view_browser_task",
          resourceId: payload.taskId,
          toastPolicy: "when_hidden",
        },
        { appHidden: appHiddenRef.current, ownerUid: owner },
      );
    },
    "useBrowserTask: status",
  );

  useTauriEvent<BrowserTaskApprovalPayload>(
    BROWSER_TASK_APPROVAL,
    (payload) => {
      setApproval(payload);
      summon();
    },
    "useBrowserTask: approval",
  );

  // The result folds away on its own; the row in History keeps it.
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), RESULT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [result]);

  const stop = useCallback(() => {
    stopBrowserTask().catch((err) => logError("useBrowserTask: stop", err));
  }, []);
  const approve = useCallback((allow: boolean) => {
    setApproval(null);
    approveBrowserTask(allow).catch((err) => logError("useBrowserTask: approve", err));
  }, []);
  const watch = useCallback(() => {
    setWatching((current) => !current);
    watchBrowserTask().catch((err) => logError("useBrowserTask: watch", err));
  }, []);
  const dismissResult = useCallback(() => setResult(null), []);

  return {
    status,
    live: status !== null,
    approval,
    result,
    watching,
    stop,
    approve,
    watch,
    dismissResult,
  };
}
