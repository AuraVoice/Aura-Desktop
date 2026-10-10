import { useCallback, useEffect, useState } from "react";
import { CircleAlert, LoaderCircle, Monitor, ShieldCheck, Square } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  desktopTaskFailureMessage,
  desktopTaskStatus,
  listDesktopTasks,
  loadDesktopTask,
  loadDesktopTaskConsent,
  setDesktopTaskConsent,
  startDesktopTask,
  stopDesktopTask,
  type DesktopTaskDetail,
} from "../../../lib/desktopTask";
import { OPERATOR_TASK_STATUS, type BrowserTaskStatusPayload } from "../../../lib/ipcEvents";
import { isMac } from "../../../lib/platformKeys";
import { useTauriEvent } from "../../../lib/useTauriEvent";
import { logError } from "../../../lib/log";
import { useDashboardUser } from "../../useDashboardUser";
import { SwarmMarkdown } from "./SwarmMarkdown";

/**
 * The Start card a `desktop_task` decision shows in #group: the desktop Operator
 * (src-tauri/src/agent_operator) runs on this PC only when the user taps Start
 * here, never on its own. The task is stamped with `origin` "swarm:<item key>",
 * which is how this card finds it again after a reload: the run, its live step
 * and its report all come from the Operator's own encrypted store on this
 * computer, never from the backend, so another device sees only the decision.
 */

const LIVE_PHASES = new Set(["starting", "running", "awaiting_approval", "awaiting_checkin"]);
const MAX_BRIEF_CHARS = 500;

const CONSENT_COPY =
  "Only when you tap Start. Buddy works the way a coding agent does in a terminal: it reads files and app settings with commands, reads the web, and opens an app only when nothing else can. Read-only commands run on their own. Anything that changes your PC, every new website, and anything that sends, buys, deletes or signs out waits for your yes. Touch the mouse or keyboard and it pauses.";

function originFor(itemKey: string): string {
  return `swarm:${itemKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function DesktopTaskStart({ itemKey, initialBrief }: { itemKey: string; initialBrief: string }) {
  const uid = useDashboardUser()?.uid ?? "";
  const origin = originFor(itemKey);
  const [consent, setConsent] = useState<boolean | null>(null);
  const [brief, setBrief] = useState(() => initialBrief.slice(0, MAX_BRIEF_CHARS));
  const [taskId, setTaskId] = useState<string | null>(null);
  const [live, setLive] = useState<BrowserTaskStatusPayload | null>(null);
  const [detail, setDetail] = useState<DesktopTaskDetail | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const [dismissed, setDismissed] = useState(false);

  // This card's task, if it ever started one: the newest row stamped with its origin.
  const reload = useCallback(() => {
    if (!uid) return;
    listDesktopTasks(uid)
      .then((rows) => {
        const mine = rows.filter((row) => row.origin === origin).sort((a, b) => b.startedAtMs - a.startedAtMs)[0];
        if (!mine) return;
        setTaskId(mine.taskId);
        return loadDesktopTask(uid, mine.taskId).then((row) => setDetail(row));
      })
      .catch((err) => logError("DesktopTaskStart: load", err));
  }, [uid, origin]);

  useEffect(() => {
    loadDesktopTaskConsent()
      .then(setConsent)
      .catch((err) => {
        logError("DesktopTaskStart: consent", err);
        setConsent(false);
      });
    desktopTaskStatus()
      .then((payload) => {
        if (payload.origin === origin && LIVE_PHASES.has(payload.phase)) setLive(payload);
      })
      .catch((err) => logError("DesktopTaskStart: status", err));
    reload();
  }, [origin, reload]);

  useTauriEvent<BrowserTaskStatusPayload>(OPERATOR_TASK_STATUS, (payload) => {
    if (payload.origin !== origin) return;
    if (LIVE_PHASES.has(payload.phase)) {
      setLive(payload);
      if (payload.taskId) setTaskId(payload.taskId);
    } else {
      setLive(null);
      reload();
    }
  });

  const start = async () => {
    const text = brief.trim();
    if (!text || starting) return;
    setStarting(true);
    setError("");
    try {
      if (!consent) {
        const accepted = await setDesktopTaskConsent(true);
        setConsent(accepted);
        if (!accepted) return;
      }
      const status = await startDesktopTask(text, origin);
      setLive(status);
      if (status.taskId) setTaskId(status.taskId);
    } catch (err) {
      // Tauri rejects Result<T, String> with the bare string; keep the reason.
      setError(typeof err === "string" ? err : "Buddy could not start this task.");
      logError("DesktopTaskStart: start", err);
    } finally {
      setStarting(false);
    }
  };

  if (isMac()) {
    return (
      <div className="db-swarm-embed db-swarm-desktop">
        <span className="db-swarm-embed-kicker"><Monitor size={13} /> Desktop task</span>
        <p>Desktop tasks run on Windows for now. Mac support is on the way.</p>
      </div>
    );
  }

  // Running: the live step, with Stop. Approvals and check-ins show in the overlay card.
  if (live) {
    const waiting = live.phase === "awaiting_approval" || live.phase === "awaiting_checkin";
    return (
      <div className="db-swarm-embed db-swarm-desktop is-live">
        <span className="db-swarm-embed-kicker"><LoaderCircle size={13} className="db-swarm-desktop-spin" /> Working on this PC</span>
        <p className="db-swarm-desktop-brief">{live.brief}</p>
        <p>
          {waiting
            ? "Waiting for your answer on the card at the top of the screen."
            : live.phase === "running"
              ? `Step ${live.steps}${live.app ? ` in ${live.app}` : ""}`
              : "Getting started"}
        </p>
        <div className="db-swarm-choice-row">
          <button type="button" className="db-swarm-choice" onClick={() => stopDesktopTask().catch((err) => logError("DesktopTaskStart: stop", err))}>
            <Square size={12} /> Stop
          </button>
        </div>
      </div>
    );
  }

  // Finished: the report, or why it stopped.
  if (taskId && detail && detail.endedAtMs > 0) {
    const ok = detail.state === "done";
    const seconds = Math.round(detail.trace.reduce((sum, entry) => sum + entry.ms, 0) / 1000);
    return (
      <div className={`db-swarm-embed db-swarm-desktop${ok ? "" : " is-stopped"}`}>
        <span className="db-swarm-embed-kicker">
          <Monitor size={13} /> {ok ? "Done on this PC" : detail.state === "stopped" ? "You stopped it" : "Stopped early"}
        </span>
        {!ok && detail.state !== "stopped" && <p>{desktopTaskFailureMessage(detail.failureCode)}</p>}
        {detail.answer ? (
          <SwarmMarkdown
            className="db-swarm-desktop-answer"
            text={detail.answer}
            onOpenLink={(url) => openUrl(url).catch((err) => logError("DesktopTaskStart: open link", err))}
          />
        ) : (
          ok && <p>No answer was written down.</p>
        )}
        <p className="db-swarm-desktop-meta">{detail.steps} steps · {seconds}s</p>
        <details className="db-swarm-desktop-trace">
          <summary>Steps</summary>
          <ol>
            {detail.trace.map((entry) => (
              <li key={entry.step}>
                <span>{entry.action}</span>
                {entry.app && <span>{entry.app}</span>}
                <span>{entry.result}</span>
              </li>
            ))}
          </ol>
        </details>
      </div>
    );
  }

  if (dismissed) {
    return (
      <div className="db-swarm-choice-row">
        <button type="button" className="db-swarm-choice" onClick={() => setDismissed(false)}>
          <Monitor size={13} /> Run it on this PC
        </button>
      </div>
    );
  }

  return (
    <div className="db-swarm-embed db-swarm-desktop">
      <span className="db-swarm-embed-kicker"><Monitor size={13} /> Desktop task · runs on this PC</span>
      {consent === false && <p>{CONSENT_COPY}</p>}
      <textarea
        className="db-swarm-desktop-input"
        value={brief}
        maxLength={MAX_BRIEF_CHARS}
        rows={3}
        aria-label="What Buddy should do on this PC"
        onChange={(event) => setBrief(event.target.value)}
      />
      {error && (
        <p className="db-swarm-desktop-error"><CircleAlert size={13} /> {error}</p>
      )}
      <div className="db-swarm-choice-row">
        <button type="button" className="db-swarm-choice" onClick={() => setDismissed(true)}>
          Not now
        </button>
        <button type="button" className="db-swarm-choice is-primary" disabled={starting || !brief.trim() || consent === null} onClick={() => void start()}>
          {starting ? <LoaderCircle size={13} className="db-swarm-desktop-spin" /> : consent ? <Monitor size={13} /> : <ShieldCheck size={13} />}
          {consent ? " Start" : " Turn on and start"}
        </button>
      </div>
    </div>
  );
}
