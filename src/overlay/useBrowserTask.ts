import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Room } from "livekit-client";
import { useTauriEvent } from "../lib/useTauriEvent";
import {
  BROWSER_TASK_APPROVAL,
  BROWSER_TASK_CHECKIN,
  BROWSER_TASK_STATUS,
  OPERATOR_TASK_APPROVAL,
  OPERATOR_TASK_CHECKIN,
  OPERATOR_TASK_STATUS,
  type BrowserTaskApprovalPayload,
  type BrowserTaskCheckinPayload,
  type BrowserTaskStatusPayload,
} from "../lib/ipcEvents";
import {
  approveBrowserTask,
  browserTaskFailureMessage,
  browserTaskStatus,
  stopBrowserTask,
  watchBrowserTask,
} from "../lib/browserTask";
import {
  approveDesktopTask,
  desktopTaskFailureMessage,
  desktopTaskStatus,
  stopDesktopTask,
} from "../lib/desktopTask";
import { notifyLocal } from "../lib/desktopNotifications";
import type { DesktopNotificationType, NotificationAction } from "../lib/desktopNotificationContract";
import { logError } from "../lib/log";

/**
 * The overlay's view of one live agent task: the browser agent
 * (src-tauri/src/agent_browser) or the desktop Operator
 * (src-tauri/src/agent_operator). Both emit the same three events under their
 * own names: status on every phase change and step, approval when the guard
 * pauses on a risky action, and check-in when the task crosses a spend mark
 * (and, for the Operator, when the person touches the mouse or keyboard
 * mid-task). This hook folds those into what the slot card needs: a running
 * chip, a question, or a result. It is also the ONE producer of the task's
 * notifications, through the desktop broker, so a finished task toasts once
 * and lands in the inbox like every other event.
 */

export type AgentTaskKind = "browser" | "desktop";

const LIVE_PHASES = new Set(["starting", "launching", "running", "awaiting_approval", "awaiting_checkin"]);
/** How long a result card stays in the slot before it folds away on its own. */
const RESULT_LINGER_MS = 60_000;

interface KindConfig {
  statusEvent: string;
  approvalEvent: string;
  checkinEvent: string;
  status: () => Promise<BrowserTaskStatusPayload>;
  stop: () => Promise<unknown>;
  approve: (allow: boolean) => Promise<void>;
  /** Only Aura's own browser can be shown and hidden. */
  watch: (() => Promise<void>) | null;
  failureMessage: (code: string | null | undefined) => string;
  types: { ready: DesktopNotificationType; partial: DesktopNotificationType; failed: DesktopNotificationType };
  action: NotificationAction;
  noun: string;
  /** Voice can start a browser task, so a live call hears how it ended. */
  publishToCall: boolean;
}

const KINDS: Record<AgentTaskKind, KindConfig> = {
  browser: {
    statusEvent: BROWSER_TASK_STATUS,
    approvalEvent: BROWSER_TASK_APPROVAL,
    checkinEvent: BROWSER_TASK_CHECKIN,
    status: browserTaskStatus,
    stop: stopBrowserTask,
    approve: approveBrowserTask,
    watch: watchBrowserTask,
    failureMessage: browserTaskFailureMessage,
    types: { ready: "browser_task_ready", partial: "browser_task_partial", failed: "browser_task_failed" },
    action: "view_browser_task",
    noun: "browser task",
    publishToCall: true,
  },
  desktop: {
    statusEvent: OPERATOR_TASK_STATUS,
    approvalEvent: OPERATOR_TASK_APPROVAL,
    checkinEvent: OPERATOR_TASK_CHECKIN,
    status: desktopTaskStatus,
    stop: stopDesktopTask,
    approve: approveDesktopTask,
    watch: null,
    failureMessage: desktopTaskFailureMessage,
    types: { ready: "desktop_task_ready", partial: "desktop_task_partial", failed: "desktop_task_failed" },
    action: "view_desktop_task",
    noun: "desktop task",
    publishToCall: false,
  },
};

export interface BrowserTaskState {
  kind: AgentTaskKind;
  /** The latest status while a task is live, else null. */
  status: BrowserTaskStatusPayload | null;
  live: boolean;
  approval: BrowserTaskApprovalPayload | null;
  /** Set while the task waits at a check-in; Keep going is `approve(true)`. */
  checkin: BrowserTaskCheckinPayload | null;
  /** The terminal payload, held for the result card until dismissed. */
  result: BrowserTaskStatusPayload | null;
  watching: boolean;
  canWatch: boolean;
  stop: () => void;
  approve: (allow: boolean) => void;
  watch: () => void;
  dismissResult: () => void;
  failureMessage: (code: string | null | undefined) => string;
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
  kind = "browser",
}: {
  uid: string | null;
  appHidden: boolean;
  /** The live voice room, when there is one. */
  room: Room | null;
  kind?: AgentTaskKind;
}): BrowserTaskState {
  const config = KINDS[kind];
  const [status, setStatus] = useState<BrowserTaskStatusPayload | null>(null);
  const [approval, setApproval] = useState<BrowserTaskApprovalPayload | null>(null);
  const [checkin, setCheckin] = useState<BrowserTaskCheckinPayload | null>(null);
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
    config
      .status()
      .then((payload) => {
        if (cancelled) return;
        setStatus(LIVE_PHASES.has(payload.phase) ? payload : null);
      })
      .catch((err) => logError(`useBrowserTask(${kind}): status`, err));
    return () => {
      cancelled = true;
    };
  }, [config, kind]);

  const summon = useCallback(() => {
    // The notch may be hidden; the card has to be seen. summon_bar never
    // takes focus and refuses while the notch is being moved, which is fine.
    invoke("summon_bar").catch((err) => logError("useBrowserTask: summon_bar", err));
  }, []);

  useTauriEvent<BrowserTaskStatusPayload>(
    config.statusEvent,
    (payload) => {
      if (LIVE_PHASES.has(payload.phase)) {
        setStatus(payload);
        setResult(null);
        if (payload.phase !== "awaiting_approval") setApproval(null);
        if (payload.phase !== "awaiting_checkin") setCheckin(null);
        return;
      }
      setStatus(null);
      setApproval(null);
      setCheckin(null);
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
      if (config.publishToCall && liveRoom && liveRoom.state === "connected") {
        publishDesktopResult(liveRoom, payload).catch((err) =>
          logError("useBrowserTask: publish desktop.result", err),
        );
      }
      const owner = uidRef.current;
      if (!owner || !payload.taskId) return;
      const type =
        payload.phase === "done"
          ? config.types.ready
          : payload.phase === "partial"
            ? config.types.partial
            : config.types.failed;
      const title =
        payload.phase === "done"
          ? `Buddy finished a ${config.noun}`
          : payload.phase === "partial"
            ? "Buddy stopped early"
            : `A ${config.noun} did not finish`;
      const answer = (payload.answer ?? "").trim();
      const body = answer
        ? answer.length > 140 ? `${answer.slice(0, 137)}...` : answer
        : config.failureMessage(payload.reason);
      void notifyLocal(
        {
          type,
          severity: payload.phase === "done" ? "success" : payload.phase === "partial" ? "warning" : "error",
          title,
          body,
          dedupKey: `${kind}_task:${payload.taskId}:${payload.phase}`,
          action: config.action,
          resourceId: payload.taskId,
          toastPolicy: "when_hidden",
        },
        { appHidden: appHiddenRef.current, ownerUid: owner },
      );
    },
    `useBrowserTask(${kind}): status`,
  );

  useTauriEvent<BrowserTaskApprovalPayload>(
    config.approvalEvent,
    (payload) => {
      setApproval(payload);
      summon();
    },
    `useBrowserTask(${kind}): approval`,
  );

  useTauriEvent<BrowserTaskCheckinPayload>(
    config.checkinEvent,
    (payload) => {
      setCheckin(payload);
      summon();
    },
    `useBrowserTask(${kind}): checkin`,
  );

  // The result folds away on its own; the row in History keeps it.
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setResult(null), RESULT_LINGER_MS);
    return () => clearTimeout(timer);
  }, [result]);

  const stop = useCallback(() => {
    config.stop().catch((err) => logError(`useBrowserTask(${kind}): stop`, err));
  }, [config, kind]);
  const approve = useCallback(
    (allow: boolean) => {
      setApproval(null);
      setCheckin(null);
      config.approve(allow).catch((err) => logError(`useBrowserTask(${kind}): approve`, err));
    },
    [config, kind],
  );
  const watch = useCallback(() => {
    const toggle = config.watch;
    if (!toggle) return;
    setWatching((current) => !current);
    toggle().catch((err) => logError(`useBrowserTask(${kind}): watch`, err));
  }, [config, kind]);
  const dismissResult = useCallback(() => setResult(null), []);

  return {
    kind,
    status,
    live: status !== null,
    approval,
    checkin,
    result,
    watching,
    canWatch: config.watch !== null,
    stop,
    approve,
    watch,
    dismissResult,
    failureMessage: config.failureMessage,
  };
}
