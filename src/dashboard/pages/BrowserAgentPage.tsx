import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Eye,
  EyeOff,
  Globe2,
  LoaderCircle,
  ShieldCheck,
  Square,
  Trash2,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  browserTaskFailureMessage,
  browserTaskStatus,
  deleteBrowserTask,
  listBrowserTasks,
  loadBrowserTask,
  loadBrowserTaskConsent,
  setBrowserTaskConsent,
  startBrowserTask,
  stopBrowserTask,
  watchBrowserTask,
  type BrowserTaskDetail,
  type BrowserTaskSummary,
} from "../../lib/browserTask";
import { BROWSER_TASK_STATUS, type BrowserTaskStatusPayload } from "../../lib/ipcEvents";
import { useTauriEvent } from "../../lib/useTauriEvent";
import { logError } from "../../lib/log";
import { EmptyState } from "../components/EmptyState";
import { shortDateTime } from "../format";
import { useDashboardUser } from "../useDashboardUser";

/**
 * The Agents page's Computer tab: the Background Browser Agent. A brief box,
 * the live run, and a library of past tasks read back with their trace
 * (per-step action, where, milliseconds, tokens). Everything here is local:
 * the rows come from the agent's own encrypted store in Rust, never from the
 * backend. The desktop Operator starts from Swarm instead (DesktopTaskStart).
 */

export type AgentTaskKind = "browser";

const LIVE_PHASES = new Set(["starting", "launching", "running", "awaiting_approval", "awaiting_checkin"]);

interface PageKind {
  statusEvent: string;
  status: () => Promise<BrowserTaskStatusPayload>;
  start: (brief: string) => Promise<BrowserTaskStatusPayload>;
  stop: () => Promise<unknown>;
  watch: (() => Promise<void>) | null;
  list: (uid: string) => Promise<BrowserTaskSummary[]>;
  load: (uid: string, taskId: string) => Promise<BrowserTaskDetail | null>;
  remove: (uid: string, taskId: string) => Promise<void>;
  loadConsent: () => Promise<boolean>;
  setConsent: (accepted: boolean) => Promise<boolean>;
  failureMessage: (code: string | null | undefined) => string;
  examples: string[];
  Icon: typeof Globe2;
  copy: {
    consentHeading: string;
    consentBody: string;
    consentButton: string;
    eyebrow: string;
    heading: string;
    body: string;
    hint: string;
    starting: string;
    emptyHeading: string;
    emptyBody: string;
    withdraw: string;
    whereColumn: string;
    deleteBody: string;
  };
}

const PAGE_KINDS: Record<AgentTaskKind, PageKind> = {
  browser: {
    statusEvent: BROWSER_TASK_STATUS,
    status: browserTaskStatus,
    start: (brief) => startBrowserTask(brief, "dashboard"),
    stop: stopBrowserTask,
    watch: watchBrowserTask,
    list: listBrowserTasks,
    load: loadBrowserTask,
    remove: deleteBrowserTask,
    loadConsent: loadBrowserTaskConsent,
    setConsent: setBrowserTaskConsent,
    failureMessage: browserTaskFailureMessage,
    examples: [
      "Compare the monthly price of Cursor, Windsurf and Claude Code Pro from their pricing pages.",
      "Find three software engineering internships in Seattle posted this week and list their deadlines.",
      "Find the three most cited 2026 arXiv papers on speculative decoding and summarize each.",
      "What is the current price of the Dell U2723QE on dell.com?",
    ],
    Icon: Globe2,
    copy: {
      consentHeading: "Buddy can use its own separate browser to do web tasks for you",
      consentBody:
        "It never sees your Chrome, your tabs or your passwords. It opens a separate browser with an empty profile, works through the task one step at a time, and pauses to ask before anything that would buy, send, sign up or apply. You can watch it or stop it at any point.",
      consentButton: "Turn on browser tasks",
      eyebrow: "Browser Agent",
      heading: "What should Buddy go and do?",
      body: "Buddy opens its own browser, works through the task, and comes back with an answer and the pages it used.",
      hint: "Public pages only. Buddy never logs in, pays or submits on its own.",
      starting: "Opening a browser",
      emptyHeading: "No browser tasks yet",
      emptyBody: "Start one above. Every finished task, its answer, its sources and its step-by-step trace stay here on this computer.",
      withdraw: "Turn off browser tasks",
      whereColumn: "Page",
      deleteBody: "The brief, answer, sources and trace are removed from this computer.",
    },
  },
};

function stateLabel(task: { state: string; failureCode: string | null; partial: boolean }): string {
  switch (task.state) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "partial":
      return "Stopped early";
    case "stopped":
      return "Stopped";
    case "failed":
      return "Failed";
    default:
      return task.state;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function briefTitle(brief: string): string {
  const text = brief.trim();
  return text.length > 90 ? `${text.slice(0, 87)}...` : text;
}

const HistoryRow = memo(function HistoryRow({
  task,
  onOpen,
  showSources,
}: {
  task: BrowserTaskSummary;
  onOpen: (taskId: string) => void;
  showSources: boolean;
}) {
  const icon =
    task.state === "done" ? <CheckCircle2 size={19} /> : task.state === "running" ? <LoaderCircle size={19} /> : <CircleAlert size={19} />;
  return (
    <button type="button" onClick={() => onOpen(task.taskId)}>
      <span className={`db-research-history-icon is-${task.state === "done" ? "ready" : task.state === "partial" ? "partial" : "failed"}`}>{icon}</span>
      <span className="db-research-history-copy">
        <span className="db-browser-agent-state">{stateLabel(task)}</span>
        <strong>{briefTitle(task.brief)}</strong>
        <small>{shortDateTime(new Date(task.endedAtMs || task.startedAtMs).toISOString())} · {task.steps} steps · {task.origin}</small>
      </span>
      {showSources && <span className="db-research-history-source-count"><Globe2 size={14} /> {task.sourceCount} sources</span>}
      <ChevronRight size={17} />
    </button>
  );
});

function TaskDetailView({
  kind,
  uid,
  taskId,
  onBack,
  onDeleted,
}: {
  kind: PageKind;
  uid: string;
  taskId: string;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const [detail, setDetail] = useState<BrowserTaskDetail | null | undefined>(undefined);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const reload = useCallback(() => {
    kind
      .load(uid, taskId)
      .then(setDetail)
      .catch((err) => {
        logError("BrowserAgentPage: load", err);
        setDetail(null);
      });
  }, [kind, uid, taskId]);
  useEffect(reload, [reload]);
  // A live task's row changes on every step; follow it.
  useTauriEvent<BrowserTaskStatusPayload>(kind.statusEvent, (payload) => {
    if (payload.taskId === taskId) reload();
  });

  if (detail === undefined) return <div className="db-research-page"><p className="db-muted">Loading...</p></div>;
  if (detail === null) {
    return (
      <div className="db-research-page">
        <button type="button" className="db-research-back" onClick={onBack}><ArrowLeft size={16} /> Back</button>
        <EmptyState Icon={CircleAlert} heading="This task is gone" copy="It was deleted, or it belonged to another account." />
      </div>
    );
  }
  const totalIn = detail.trace.reduce((sum, entry) => sum + entry.tokensIn, 0);
  const totalOut = detail.trace.reduce((sum, entry) => sum + entry.tokensOut, 0);
  const totalMs = detail.trace.reduce((sum, entry) => sum + entry.ms, 0);
  const live = detail.endedAtMs === 0;
  return (
    <div className="db-research-page">
      <div className="db-research-detail-bar">
        <button type="button" className="db-research-back" onClick={onBack}><ArrowLeft size={16} /> All tasks</button>
        {!live && (
          <button type="button" className="db-research-secondary" onClick={() => setConfirmDelete(true)}><Trash2 size={15} /> Delete</button>
        )}
      </div>

      <header className="db-research-run-head">
        <div>
          <span className="db-browser-agent-state">{stateLabel(detail)}</span>
          <h1 title={detail.brief}>{briefTitle(detail.brief)}</h1>
          <p>Started {shortDateTime(new Date(detail.startedAtMs).toISOString())} from {detail.origin}</p>
        </div>
        <div className="db-research-run-summary">
          <span><strong>{detail.steps}</strong> steps</span>
          <span><strong>{Math.round(totalMs / 1000)}s</strong> total</span>
          <span><strong>{(totalIn / 1000).toFixed(1)}k</strong> tokens in</span>
          <span><strong>{totalOut}</strong> tokens out</span>
        </div>
      </header>

      {live && <div className="db-research-inline-error"><LoaderCircle size={17} /><span>Buddy is still working on this one. The trace fills in as it goes.</span></div>}

      {(detail.state === "done" || detail.state === "partial") && (
        <section className="db-browser-agent-answer">
          <span className="db-research-section-kicker">{detail.state === "done" ? "Answer" : "What Buddy found before it stopped"}</span>
          {detail.state === "partial" && detail.failureCode && <p className="db-browser-agent-reason">{kind.failureMessage(detail.failureCode)}</p>}
          <p>{detail.answer || "No answer was written down."}</p>
          {detail.sources.length > 0 && (
            <ul className="db-browser-agent-sources">
              {detail.sources.map((source) => (
                <li key={source}>
                  <button type="button" onClick={() => openUrl(source).catch((err) => logError("BrowserAgentPage: open source", err))} title={source}>
                    <Globe2 size={14} /> {hostOf(source)} <ArrowUpRight size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {(detail.state === "failed" || detail.state === "stopped") && (
        <section className="db-browser-agent-fail">
          <CircleAlert size={16} />
          <p>{detail.state === "stopped" ? "You stopped this task" : kind.failureMessage(detail.failureCode)}</p>
          {detail.answer && <p className="db-browser-agent-fail-answer">{detail.answer}</p>}
        </section>
      )}

      <section className="db-browser-agent-trace">
        <span className="db-research-section-kicker">Trace</span>
        {detail.trace.length === 0 ? (
          <p className="db-muted">No steps were recorded.</p>
        ) : (
          <table>
            <thead>
              <tr><th>#</th><th>Action</th><th>Ref</th><th>Result</th><th>{kind.copy.whereColumn}</th><th>ms</th><th>In</th><th>Out</th></tr>
            </thead>
            <tbody>
              {detail.trace.map((entry) => (
                <tr key={entry.step}>
                  <td>{entry.step}</td>
                  <td>{entry.action}</td>
                  <td>{entry.refId || ""}</td>
                  <td>{entry.result}</td>
                  <td title={entry.url}>{entry.url ? (kind.watch ? hostOf(entry.url) : entry.url) : ""}</td>
                  <td>{entry.ms}</td>
                  <td>{entry.tokensIn}</td>
                  <td>{entry.tokensOut}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {confirmDelete && (
        <div className="db-research-confirm" role="dialog" aria-modal="true" aria-labelledby="browser-task-delete-title">
          <button type="button" className="db-research-confirm-scrim" onClick={() => setConfirmDelete(false)} aria-label="Cancel deletion" />
          <div>
            <Trash2 size={22} />
            <h2 id="browser-task-delete-title">Delete this task?</h2>
            <p>{kind.copy.deleteBody}</p>
            <span>
              <button type="button" className="db-research-secondary" onClick={() => setConfirmDelete(false)}>Keep it</button>
              <button
                type="button"
                className="db-research-danger"
                onClick={() => {
                  kind
                    .remove(uid, taskId)
                    .then(onDeleted)
                    .catch((err) => logError("BrowserAgentPage: delete", err));
                }}
              >
                Delete task
              </button>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export function BrowserAgentPage({ kind: kindName = "browser" }: { kind?: AgentTaskKind } = {}) {
  const kind = PAGE_KINDS[kindName];
  const examples = kind.examples;
  const user = useDashboardUser();
  const uid = user?.uid ?? "";
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedId = searchParams.get("run");
  const [consent, setConsent] = useState<boolean | null>(null);
  const [brief, setBrief] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState("");
  const [live, setLive] = useState<BrowserTaskStatusPayload | null>(null);
  const [watching, setWatching] = useState(false);
  const [tasks, setTasks] = useState<BrowserTaskSummary[]>([]);
  const [exampleIndex, setExampleIndex] = useState(0);

  useEffect(() => {
    kind.loadConsent().then(setConsent).catch((err) => {
      logError("BrowserAgentPage: consent", err);
      setConsent(false);
    });
    kind
      .status()
      .then((payload) => setLive(LIVE_PHASES.has(payload.phase) ? payload : null))
      .catch((err) => logError("BrowserAgentPage: status", err));
  }, [kind]);

  const reloadTasks = useCallback(() => {
    if (!uid) return;
    kind.list(uid).then(setTasks).catch((err) => logError("BrowserAgentPage: list", err));
  }, [kind, uid]);
  useEffect(reloadTasks, [reloadTasks]);

  useTauriEvent<BrowserTaskStatusPayload>(kind.statusEvent, (payload) => {
    const isLive = LIVE_PHASES.has(payload.phase);
    setLive(isLive ? payload : null);
    if (!isLive) {
      setWatching(false);
      reloadTasks();
    } else if (payload.steps === 0) {
      reloadTasks();
    }
  });

  useEffect(() => {
    if (brief.length > 0) return;
    const timer = setInterval(() => setExampleIndex((index) => (index + 1) % examples.length), 4500);
    return () => clearInterval(timer);
  }, [brief, examples.length]);

  // Keep `?tab=`: this panel lives inside the Agents page, whose tab is the
  // other search param, and replacing the whole set would bounce the user.
  const openTask = useCallback((taskId: string) => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set("run", taskId); return next; }), [setSearchParams]);
  const closeTask = useCallback(() => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.delete("run"); return next; }), [setSearchParams]);

  const { activeTasks, historyTasks } = useMemo(() => {
    const active: BrowserTaskSummary[] = [];
    const history: BrowserTaskSummary[] = [];
    for (const task of tasks) {
      if (task.endedAtMs === 0) active.push(task);
      else history.push(task);
    }
    return { activeTasks: active, historyTasks: history };
  }, [tasks]);

  if (selectedId && uid) {
    return (
      <TaskDetailView
        kind={kind}
        uid={uid}
        taskId={selectedId}
        onBack={closeTask}
        onDeleted={() => {
          closeTask();
          reloadTasks();
        }}
      />
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!brief.trim() || starting) return;
    setStarting(true);
    setStartError("");
    try {
      const status = await kind.start(brief.trim());
      setLive(status);
      setBrief("");
      reloadTasks();
    } catch (err) {
      // Tauri rejects Result<T, String> with the bare string; keep the reason.
      setStartError(typeof err === "string" ? err : "Buddy could not start this task.");
      logError("BrowserAgentPage: start", err);
    } finally {
      setStarting(false);
    }
  };

  const acceptConsent = () => {
    kind
      .setConsent(true)
      .then(setConsent)
      .catch((err) => logError("BrowserAgentPage: consent accept", err));
  };
  const withdrawConsent = () => {
    kind
      .setConsent(false)
      .then(setConsent)
      .catch((err) => logError("BrowserAgentPage: consent withdraw", err));
  };

  return (
    <div className="db-research-page db-research-home">
      {consent === false && (
        <section className="db-research-command db-browser-agent-consent">
          <div className="db-research-command-copy">
            <span className="db-research-eyebrow">Before the first task</span>
            <h1>{kind.copy.consentHeading}</h1>
            <p>{kind.copy.consentBody}</p>
          </div>
          <div className="db-research-composer-col">
            <div className="db-browser-agent-consent-actions">
              <button type="button" className="db-research-primary" onClick={acceptConsent}><ShieldCheck size={17} /> {kind.copy.consentButton}</button>
            </div>
          </div>
        </section>
      )}

      {consent && (
        <section className="db-research-command">
          <div className="db-research-command-copy">
            <span className="db-research-eyebrow">{kind.copy.eyebrow}</span>
            <h1>{kind.copy.heading}</h1>
            <p>{kind.copy.body}</p>
          </div>
          <div className="db-research-composer-col">
            <form onSubmit={submit}>
              <label htmlFor="browser-task-brief">Task</label>
              <textarea
                id="browser-task-brief"
                value={brief}
                onChange={(event) => setBrief(event.target.value)}
                maxLength={500}
                placeholder={examples[exampleIndex]}
                disabled={live !== null}
              />
              <div className="db-research-composer-foot">
                <span>{live ? "One task at a time. Stop the current one to start another." : kind.copy.hint}</span>
                <button type="submit" className="db-research-primary" disabled={starting || !brief.trim() || live !== null}>
                  {starting ? <LoaderCircle size={17} /> : <kind.Icon size={17} />} {starting ? "Starting" : "Start task"}
                </button>
              </div>
            </form>
          </div>
        </section>
      )}

      {startError && <div className="db-research-inline-error"><CircleAlert size={17} /><span>{startError}</span><button type="button" onClick={() => setStartError("")}>Dismiss</button></div>}

      {live && (
        <section className="db-research-active-runs">
          <div className="db-research-section-head"><div><span className="db-research-section-kicker">In progress</span><h2>Buddy is on it</h2></div></div>
          <div className="db-research-active-run db-browser-agent-live">
            <span className="db-research-active-symbol"><LoaderCircle size={20} /></span>
            <span>
              <span className="db-browser-agent-state">{live.phase === "awaiting_approval" || live.phase === "awaiting_checkin" ? "Waiting for your answer in the overlay" : live.phase === "running" ? `Step ${live.steps}` : kind.copy.starting}</span>
              <strong>{briefTitle(live.brief ?? "")}</strong>
              <small>{live.url ? hostOf(live.url) : live.app ? live.app : "Starting up"}</small>
            </span>
            <span className="db-browser-agent-live-actions">
              {kind.watch && (
                <button
                  type="button"
                  className="db-research-secondary"
                  onClick={() => {
                    setWatching((current) => !current);
                    kind.watch?.().catch((err) => logError("BrowserAgentPage: watch", err));
                  }}
                >
                  {watching ? <EyeOff size={15} /> : <Eye size={15} />} {watching ? "Hide" : "Watch"}
                </button>
              )}
              <button type="button" className="db-research-danger" onClick={() => kind.stop().catch((err) => logError("BrowserAgentPage: stop", err))}>
                <Square size={14} /> Stop
              </button>
            </span>
          </div>
        </section>
      )}

      <section className="db-research-history">
        <div className="db-research-section-head">
          <div><span className="db-research-section-kicker">Library</span><h2>Past tasks</h2></div>
          {consent && <button type="button" className="db-browser-agent-withdraw" onClick={withdrawConsent}>{kind.copy.withdraw}</button>}
        </div>
        {historyTasks.length === 0 && activeTasks.length === 0 ? (
          <EmptyState Icon={kind.Icon} heading={kind.copy.emptyHeading} copy={kind.copy.emptyBody} />
        ) : (
          <div className="db-research-history-list">
            {historyTasks.map((task) => <HistoryRow key={task.taskId} task={task} onOpen={openTask} showSources={kind.watch !== null} />)}
          </div>
        )}
      </section>
    </div>
  );
}
