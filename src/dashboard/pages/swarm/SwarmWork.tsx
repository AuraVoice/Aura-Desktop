import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  approvePendingAction,
  fetchPendingAction,
  pendingActionOutcomeCopy,
  rejectPendingAction,
  type PendingAction,
} from "../../../lib/pendingActions";
import { openPath } from "@tauri-apps/plugin-opener";
import { FORMAT_LABEL, saveDocumentDraft, type DocumentFormat } from "../../../lib/swarmDocumentFile";
import type { SwarmManager, SwarmMessage, SwarmRoundMember, SwarmRoundView, SwarmSessionView } from "../../../lib/swarmApi";
import { mapRoundMember, proposeDraft, SwarmRequestError, TERMINAL_SESSION_STATES } from "../../../lib/swarmApi";
import { SwarmOrb } from "./SwarmOrb";
import type { OrbState, OrbTone } from "./swarmOrbRenderer";
import { thinkingLine } from "./swarmThinking";
import { SwarmMarkdown } from "./SwarmMarkdown";
import {
  BlockGlyph,
  BranchGlyph,
  CaretGlyph,
  CellGlyph,
  CourseGlyph,
  DayGlyph,
  HaltGlyph,
  KeepGlyph,
  LeafGlyph,
  MailGlyph,
  SealGlyph,
  SeekGlyph,
  SignalGlyph,
  SparkGlyph,
  TeamGlyph,
  TickGlyph,
} from "./SwarmGlyphs";

/** Everything a manager's session shows in its DM: the live chip, then the plan and steps
 * folded into one line once it ends, a question it is waiting on, and the report. All of
 * it renders from append-only messages plus the polled session view, so nothing here
 * edits history. */

type Json = Record<string, unknown>;

export const CONNECTOR_LABEL: Record<string, string> = {
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  google_classroom: "Google Classroom",
  github: "GitHub",
  x: "X",
  notion: "Notion",
};

const CAPABILITY_COPY: Record<string, string> = {
  "web.search": "Searched the web",
  "web.read": "Read a page",
  "gmail.search": "Searched Gmail",
  "gmail.read": "Read an email",
  "calendar.events": "Checked the calendar",
  "classroom.due": "Checked Classroom",
  "github.activity": "Checked GitHub",
  "x.bookmarks": "Searched X bookmarks",
  "notion.recent": "Checked Notion",
  "github.repos": "Listed repositories",
  "github.tree": "Listed files",
  "github.file": "Read a file",
  "github.search": "Searched the code",
  "github.issues": "Checked issues",
};

function CapabilityGlyph({ id, size = 15 }: { id: string; size?: number }) {
  if (id === "web.search") return <SeekGlyph size={size} />;
  if (id === "web.read") return <LeafGlyph size={size} />;
  if (id.startsWith("gmail.")) return <MailGlyph size={size} />;
  if (id === "calendar.events") return <DayGlyph size={size} />;
  if (id === "classroom.due") return <CourseGlyph size={size} />;
  if (id.startsWith("github.")) return <BranchGlyph size={size} />;
  if (id === "x.bookmarks") return <KeepGlyph size={size} />;
  if (id === "notion.recent") return <BlockGlyph size={size} />;
  return <SparkGlyph size={size} />;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter((v) => v && typeof v === "object").map((v) => v as Json) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

const PHASE_COPY: Record<string, string> = {
  queued: "Getting started",
  planning: "Planning",
  acting: "Working",
  reporting: "Writing the report",
  verifying: "Checking the report",
  waiting_user: "Waiting on you",
};

function clock(seconds: number): string {
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!since) return null;
  return <span className="db-swarm-run-time">{clock(Math.max(0, Math.floor((now - since) / 1000)))}</span>;
}

/** The Supervisor's orb beside what the round is doing. Only rounds use it now: a manager's
 * own run says what it is doing in its ledger. `activity` is the one live region. */
function ThinkingRow({ id, state, tone, activity }: { id: string; state: OrbState; tone: OrbTone; activity: string }) {
  return (
    <div className="db-swarm-think">
      <SwarmOrb id={id} state={state} tone={tone} />
      <span className="db-swarm-think-activity db-swarm-shimmer" aria-live="polite">{activity}</span>
    </div>
  );
}

/** "Searched 6 sources, read 2 pages": what a finished run did, in one line. */
function workSummary(steps: SwarmMessage[]): string {
  let searched = 0;
  let read = 0;
  let accounts = 0;
  for (const step of steps) {
    const capability = str(step.data.capability_id);
    if (capability === "web.search") searched += num(step.data.sources_added);
    else if (capability === "web.read") read += step.data.ok === true ? 1 : 0;
    else if (capability) accounts += 1;
  }
  const parts: string[] = [];
  if (searched > 0) parts.push(`searched ${searched} source${searched === 1 ? "" : "s"}`);
  if (read > 0) parts.push(`read ${read} page${read === 1 ? "" : "s"}`);
  if (accounts > 0) parts.push(`checked ${accounts} account${accounts === 1 ? "" : "s"}`);
  if (parts.length === 0 && steps.length > 0) parts.push(`took ${steps.length} step${steps.length === 1 ? "" : "s"}`);
  const said = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : parts[0] ?? "";
  return said ? said[0].toUpperCase() + said.slice(1) : "";
}

function workDuration(startedAt: number, endedAt: number): string {
  const seconds = startedAt && endedAt > startedAt ? Math.round((endedAt - startedAt) / 1000) : 0;
  if (seconds >= 60) return `${(seconds / 60).toFixed(seconds >= 600 ? 0 : 1)} min`;
  return seconds > 0 ? `${seconds}s` : "";
}

/** One ledger row: a step, or a run of the same successful step folded into "x N". */
interface LedgerRow {
  key: string;
  step: SwarmMessage;
  count: number;
  duration: number;
  added: number;
}

/** Consecutive successful steps that did the same thing for the same helper read as one
 * row with a count, the way a person would say "read 3 pages". A failed step never folds:
 * it is the row the user may need to act on. */
function ledgerRows(steps: SwarmMessage[]): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const step of steps) {
    const capability = str(step.data.capability_id);
    const prev = rows[rows.length - 1];
    if (
      prev &&
      capability &&
      step.data.ok === true &&
      prev.step.data.ok === true &&
      str(prev.step.data.capability_id) === capability &&
      str(prev.step.data.subagent_title) === str(step.data.subagent_title)
    ) {
      prev.count += 1;
      prev.duration += num(step.data.duration_ms);
      prev.added += num(step.data.sources_added);
      prev.step = step;
      continue;
    }
    rows.push({ key: `${step.channelId}-${step.seq}`, step, count: 1, duration: num(step.data.duration_ms), added: num(step.data.sources_added) });
  }
  return rows;
}

/** The steps as a vertical ledger: done rows from the thread, then, while the run is live,
 * one active row that says what it is doing now. */
function Ledger({
  steps,
  managerId,
  granted,
  onGrant,
  active,
  stopping,
}: {
  steps: SwarmMessage[];
  managerId: string;
  granted: string[];
  onGrant: (managerId: string, connector: string) => void;
  active?: string;
  stopping?: boolean;
}) {
  const rows = ledgerRows(steps);
  if (rows.length === 0 && !active) return null;
  return (
    <ol className="db-swarm-ledger">
      {rows.map((row) => (
        <StepRow key={row.key} row={row} managerId={managerId} granted={granted} onGrant={onGrant} />
      ))}
      {active && (
        <li className={`db-swarm-step is-active${stopping ? " is-stopping" : ""}`}>
          <span className="db-swarm-step-node" aria-hidden="true"><span className="db-swarm-step-spin" /></span>
          <div className="db-swarm-step-body">
            <span className="db-swarm-step-head">
              <strong className="db-swarm-shimmer" aria-live="polite">{active}</strong>
            </span>
          </div>
        </li>
      )}
    </ol>
  );
}

/** A finished session's plan and steps behind one line. A real button so it is keyboard
 * reachable. A run this card watched go live stays open for a beat after it ends, so the
 * last step is seen landing before it folds away. */
function WorkFold({
  managerId,
  plan,
  steps,
  startedAt,
  endedAt,
  granted,
  onGrant,
  settle,
}: {
  managerId: string;
  plan: SwarmMessage | undefined;
  steps: SwarmMessage[];
  startedAt: number;
  endedAt: number;
  granted: string[];
  onGrant: (managerId: string, connector: string) => void;
  settle: boolean;
}) {
  const [open, setOpen] = useState(settle);
  useEffect(() => {
    if (!settle) return;
    const timer = window.setTimeout(() => setOpen(false), FOLD_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [settle]);
  if (!plan && steps.length === 0) return null;
  const summary = workSummary(steps);
  const took = workDuration(startedAt, endedAt);
  return (
    <div className={`db-swarm-fold${open ? " is-open" : ""}`}>
      <button type="button" className="db-swarm-fold-line" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <CaretGlyph size={13} className="db-swarm-fold-caret" />
        <span>
          {summary || "Worked on this"}
          {took && <span className="db-swarm-fold-sum"> in {took}</span>}
        </span>
      </button>
      {open && (
        <div className="db-swarm-fold-body">
          {plan && <PlanEmbed message={plan} />}
          <Ledger steps={steps} managerId={managerId} granted={granted} onGrant={onGrant} />
        </div>
      )}
    </div>
  );
}

/** How long a run that just finished stays open before folding (AI Elements' 1 s). */
const FOLD_SETTLE_MS = 1000;
/** How long a run with no session view yet still reads as starting: a few poll cycles. */
const FRESH_RUN_MS = 60_000;

/** A session's run card. While live it is a ledger that grows as steps land, with what the
 * manager is doing now at the foot; once the session ends it folds to one line. */
export function WorkingEmbed({
  at,
  managerId,
  manager,
  plan,
  steps,
  reportAt,
  granted,
  onGrant,
  session,
  reported,
  stopping,
  onStop,
}: {
  /** When the session's working message landed. */
  at: number;
  managerId: string;
  manager: SwarmManager | undefined;
  plan: SwarmMessage | undefined;
  steps: SwarmMessage[];
  reportAt: number;
  granted: string[];
  onGrant: (managerId: string, connector: string) => void;
  session: SwarmSessionView | undefined;
  reported: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  // Set once this card has rendered the run live, so its end settles open for a beat.
  const sawLive = useRef(false);
  // With no session view yet, only a just-sent run is "starting"; an old one that is no
  // longer polled (it ended without a report) folds like any finished run.
  const fresh = Date.now() - at < FRESH_RUN_MS;
  const ended = reported || (session ? TERMINAL_SESSION_STATES.has(session.state) : !fresh);
  if (ended) {
    return (
      <WorkFold
        managerId={managerId}
        plan={plan}
        steps={steps}
        startedAt={session?.createdAt || plan?.at || steps[0]?.at || 0}
        endedAt={reportAt || session?.endedAt || 0}
        granted={granted}
        onGrant={onGrant}
        settle={sawLive.current}
      />
    );
  }
  sawLive.current = true;
  // Before the first poll lands there is no session yet: the card already stands, so the
  // message never shows a name over an empty body.
  const stopRequested = Boolean(session?.cancelRequested) || stopping;
  const tasks = session ? session.lanes.filter((l) => l.kind === "task") : [];
  const active = session ? thinkingLine(stopRequested ? { ...session, cancelRequested: true } : session, steps[steps.length - 1], manager) : "Getting started";
  const phase = stopRequested ? "Stopping" : session ? PHASE_COPY[session.state] ?? "Working" : "Starting";
  const sources = session?.sources ?? 0;
  return (
    <div className={`db-swarm-run${stopRequested ? " is-stopping" : ""}`}>
      <div className="db-swarm-run-head">
        <span className="db-swarm-run-state">
          <span className="db-swarm-run-dot" aria-hidden="true" />
          {phase}
        </span>
        {session && <Elapsed since={session.createdAt} />}
        {session && (
          <span className="db-swarm-run-budget" title="Model decisions used of this session's limit">
            step {session.decisionsUsed} of {session.maxDecisions}
          </span>
        )}
        {session && (
          <button type="button" className="db-swarm-pill-btn is-stop" onClick={onStop} disabled={stopRequested}>
            <HaltGlyph size={14} /> {stopRequested ? "Stopping" : "Stop"}
          </button>
        )}
      </div>
      {plan?.text && <SwarmMarkdown className="db-swarm-run-plan" text={plan.text} />}
      <Ledger steps={steps} managerId={managerId} granted={granted} onGrant={onGrant} active={active} stopping={stopRequested} />
      {tasks.length > 1 && (
        <ul className="db-swarm-lanes">
          {tasks.map((lane) => (
            <li key={lane.id} className={`is-${lane.state}`}>
              <CellGlyph size={14} />
              <span>
                {lane.subagentTitle && <b>{lane.subagentTitle}: </b>}
                {lane.goal}
              </span>
              <em>{lane.state === "done" ? "done" : lane.state === "failed" ? "dropped" : `step ${lane.n + 1}`}</em>
            </li>
          ))}
        </ul>
      )}
      {sources > 0 && (
        <div className="db-swarm-run-foot">
          {sources} source{sources === 1 ? "" : "s"} so far
        </div>
      )}
    </div>
  );
}

export function PlanEmbed({ message }: { message: SwarmMessage }) {
  const criteria = list(message.data.criteria);
  const tasks = list(message.data.tasks);
  return (
    <div className="db-swarm-plan">
      <div className="db-swarm-kicker"><SparkGlyph size={13} /> Plan</div>
      {message.text && <SwarmMarkdown text={message.text} />}
      {criteria.length > 0 && (
        <ol className="db-swarm-criteria">
          {criteria.map((c) => <li key={str(c.id)}>{str(c.text)}</li>)}
        </ol>
      )}
      {tasks.length > 1 && (
        <div className="db-swarm-plan-tasks">
          {tasks.map((t) => <em key={str(t.id)}>{str(t.goal)}</em>)}
        </div>
      )}
    </div>
  );
}

/** One ledger row: what it did, on whose behalf, and how it went. A refused connector
 * carries its own Grant button, because that is the only thing the user can do about it. */
function StepRow({
  row,
  managerId,
  granted,
  onGrant,
}: {
  row: LedgerRow;
  managerId: string;
  granted: string[];
  onGrant: (managerId: string, connector: string) => void;
}) {
  const data = row.step.data;
  const capability = str(data.capability_id);
  const action = str(data.action);
  const ok = data.ok === true;
  const connector = str(data.connector);
  const label = capability ? CAPABILITY_COPY[capability] ?? "Used a tool" : action === "finish" ? "Finished its part" : "Step";
  const sub = str(data.subagent_title);
  const why = row.count === 1 ? str(data.why) || row.step.text : "";
  const gap = Boolean(capability) && !ok;
  return (
    <li className={`db-swarm-step${gap ? " is-gap" : ""}`}>
      <span className="db-swarm-step-node" aria-hidden="true">
        {capability ? <CapabilityGlyph id={capability} size={13} /> : <TickGlyph size={12} />}
      </span>
      <div className="db-swarm-step-body">
        <span className="db-swarm-step-head">
          <strong>{label}</strong>
          {row.count > 1 && <span className="db-swarm-step-count">×{row.count}</span>}
          {sub && <span className="db-swarm-muted">via {sub}</span>}
          <span className="db-swarm-step-meta">
            {data.cached === true && <span>already read</span>}
            {row.added > 0 && <span>+{row.added} source{row.added === 1 ? "" : "s"}</span>}
            {row.duration > 0 && <span>{(row.duration / 1000).toFixed(1)}s</span>}
          </span>
        </span>
        {why && <span className="db-swarm-step-why">{why}</span>}
        {gap && str(data.gap_reason) && (
          <span className="db-swarm-step-gap">
            {str(data.gap_reason)}
            {str(data.gap_code) === "connector_not_granted" && connector && !granted.includes(connector) && (
              <button type="button" className="db-swarm-pill-btn is-small" onClick={() => onGrant(managerId, connector)}>
                Grant {CONNECTOR_LABEL[connector] ?? connector}
              </button>
            )}
          </span>
        )}
      </div>
    </li>
  );
}

/** A question reads like any other message. The answer is the next thing typed in the
 * composer: a DM to a parked manager, or a #group reply the router recognises, both
 * resume the session (handlers/swarm.handle_run and persisted.route_message). */
export function QuestionEmbed({ message, open }: { message: SwarmMessage; open: boolean }) {
  if (!open) return <SwarmMarkdown className="db-swarm-text" text={message.text} />;
  return (
    <div className="db-swarm-ask-card" role="group" aria-label="Waiting on you">
      <span className="db-swarm-kicker is-warn"><SignalGlyph size={13} /> Waiting on you</span>
      <SwarmMarkdown className="db-swarm-text" text={message.text} />
      <span className="db-swarm-muted">Reply below to answer. The run picks up from here.</span>
    </div>
  );
}

/** Why a run stopped short, from the session's stop_reason (runner.py _terminal_state_for
 * and the fallback paths). An unknown code adds nothing rather than a raw slug. */
const STOP_REASON_COPY: Record<string, string> = {
  missing_access: "Some accounts it needed are not connected to this manager.",
  no_progress: "It kept finding the same things, so it stopped.",
  decision_cap: "It used all its steps for this run.",
  lane_failed: "One part kept failing and was dropped.",
  incomplete: "Some sources could not be read.",
  wallet_exhausted: "Today's Swarm budget ran out.",
  timed_out: "It ran past its 30 minute limit.",
  no_answer: "It asked you something and did not hear back.",
  cancelled: "You stopped it.",
  unavailable: "The model it uses was unavailable, so it stopped.",
  model_timed_out: "The model took too long to answer, so it stopped.",
  provider_config: "Something is misconfigured on Aura's side, not with your request. Retrying will not help yet.",
  retries_exhausted: "The model kept failing, so it stopped.",
  invalid_output: "The model's answer could not be read, so it stopped.",
  too_large: "What it gathered was too large for the model to finish.",
  model_unsupported: "The model it uses is not available right now.",
  model_unpriced: "The model it uses has no price set, so Aura would not spend on it.",
  meter_unavailable: "Aura could not check the Swarm budget, so it stopped.",
  stage_crashed: "Something went wrong on Aura's side, so it stopped.",
  manager_not_found: "This manager was removed while it was working.",
};

const DRAFT_KIND: Record<string, string> = {
  email: "Email draft",
  post: "Post draft",
  message: "Message draft",
  application: "Application draft",
  event: "Calendar hold",
  document: "Document",
};

const TARGET_LABEL: Record<string, string> = {
  x: "Post to X",
  linkedin: "Post to LinkedIn",
  calendar: "Add to your calendar",
  github_issue: "Open an issue",
};
const TARGET_LIMIT: Record<string, number> = { x: 280, linkedin: 3000 };
/** Targets anyone can read. Their approval card takes a different shape, not just a tint. */
const PUBLIC_TARGETS: ReadonlySet<string> = new Set(["x", "linkedin"]);

/** True when a report carries a draft Review can act on, which needs the session's
 * draftActions to find its approval. Every other finished session is already told in full. */
export function hasActionableDraft(report: SwarmMessage): boolean {
  const body = (report.data.report && typeof report.data.report === "object" ? report.data.report : {}) as Json;
  return list(body.drafts).some((d) => Boolean(TARGET_LABEL[str(d.target)] && str(d.id)));
}

/** Why Review could not prepare an approval (actions.py and pending_actions.py codes). */
const PROPOSE_COPY: Record<string, string> = {
  private_data_in_session:
    "This run read your private accounts, so Aura won't post from it. Copy the text and post it yourself if you want to.",
  not_connected: "That account isn't connected. Connect it under Connectors, then try again.",
  when_unclear: "The time in this draft isn't clear enough to book. Ask the manager for an exact time.",
  draft_not_actionable: "This draft can't be acted on any more.",
  text_too_long: "That's longer than this place allows.",
  text_required: "There's nothing to post.",
  time_out_of_range: "That time is in the past or too far ahead to book.",
  time_invalid: "That time doesn't work for a calendar hold.",
  title_required: "The calendar hold needs a title.",
  connector_not_granted: "GitHub isn't granted to this manager. Switch it on under Can read, then try again.",
  repo_invalid: "This draft doesn't name a repository Aura can open an issue in.",
  repo_not_scoped: "This draft names a repository this manager isn't pointed at. Pick it on the manager's card first.",
};

function localTime(iso: string): string {
  const at = Date.parse(iso);
  return Number.isFinite(at)
    ? new Date(at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : iso;
}

/** One report draft that can become a real action. Review prepares an approval on the
 * server (which re-reads the draft and applies any edit); Approve runs exactly what the
 * preview shows, once. Nothing here can post or book without that second click. */
function DraftAction({
  sessionId,
  draft,
  approvalId,
  onOpenLink,
}: {
  sessionId: string;
  draft: Json;
  approvalId: string;
  onOpenLink: (url: string) => void;
}) {
  const target = str(draft.target);
  const limit = TARGET_LIMIT[target] ?? 0;
  const [item, setItem] = useState<PendingAction | null>(null);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(str(draft.body));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!approvalId || item) return;
    let live = true;
    void fetchPendingAction(approvalId)
      .then((found) => live && found && setItem(found))
      .catch(() => live && setError("Couldn't check whether this was already approved. Review it to prepare it again."));
    return () => {
      live = false;
    };
  }, [approvalId, item]);

  const run = async (work: () => Promise<PendingAction | null>) => {
    setBusy(true);
    setError("");
    try {
      const next = await work();
      if (next) setItem(next);
    } catch (err) {
      const reason = err instanceof SwarmRequestError ? err.reason : "";
      setError(PROPOSE_COPY[reason] ?? "That didn't go through. Try again in a moment.");
    } finally {
      setBusy(false);
    }
  };

  const review = () =>
    void run(async () => {
      const next = await proposeDraft(sessionId, str(draft.id), limit ? text : "");
      setEditing(false);
      return next;
    });

  const pending = item?.status === "pending";
  const finished = item !== null && !pending && item.status !== "executing";
  const over = limit > 0 && text.trim().length > limit;
  const isPublic = PUBLIC_TARGETS.has(target);

  return (
    <div className="db-swarm-act">
      {pending && item ? (
        <>
          <span className="db-swarm-act-title">
            {item.title}
            {item.preview.account && <span className="db-swarm-muted"> · {item.preview.account}</span>}
          </span>
          {target === "calendar" ? (
            <p className="db-swarm-act-preview">
              <b>{item.preview.eventTitle}</b>
              {"\n"}
              {localTime(item.preview.start)} to {localTime(item.preview.end)}
            </p>
          ) : target === "github_issue" ? (
            <p className="db-swarm-act-preview">
              <b>{item.preview.issueTitle}</b>
              {"\n"}
              {item.preview.repo}
              {item.preview.labels.length > 0 && ` · ${item.preview.labels.join(", ")}`}
              {"\n\n"}
              {item.preview.text}
            </p>
          ) : (
            <p className="db-swarm-act-preview">{item.preview.text}</p>
          )}
          <p className={`db-swarm-act-fine${isPublic ? " is-public" : ""}`}>
            {isPublic ? "Posts exactly this, once, where anyone can see it." : "Runs exactly this, once."}
            {item.preview.estimatedCostUsd !== null && ` About $${item.preview.estimatedCostUsd.toFixed(2)}.`}
          </p>
          <div className="db-swarm-act-row is-end">
            <button type="button" className="db-swarm-pill-btn" disabled={busy} onClick={() => void run(() => rejectPendingAction(item.approvalId))}>
              Not now
            </button>
            <button type="button" className="db-swarm-pill-btn is-primary" disabled={busy} onClick={() => void run(() => approvePendingAction(item.approvalId))}>
              {busy ? "Working" : isPublic ? "Approve and post" : "Approve"}
            </button>
          </div>
        </>
      ) : editing ? (
        <>
          {limit > 0 ? (
            <textarea rows={Math.min(8, Math.max(3, Math.ceil(text.length / 70)))} value={text} onChange={(e) => setText(e.target.value)} />
          ) : (
            <p className="db-swarm-act-preview">
              <b>{str(draft.title) || (target === "github_issue" ? "Issue" : "Hold")}</b>
              {"\n"}
              {target === "github_issue" ? str(draft.scope) : str(draft.when)}
            </p>
          )}
          <div className="db-swarm-act-row">
            <button type="button" className="db-swarm-pill-btn is-primary" disabled={busy || over || (limit > 0 && !text.trim())} onClick={review}>
              {busy ? "Preparing" : "Prepare"}
            </button>
            <button type="button" className="db-swarm-pill-btn" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
            {limit > 0 && <span className={`db-swarm-act-count${over ? " is-over" : ""}`}>{text.trim().length}/{limit}</span>}
          </div>
        </>
      ) : (
        <div className="db-swarm-act-row">
          {finished && item && (
            <span className={`db-swarm-act-record${item.status === "done" ? " is-done" : ""}`}>
              {item.status === "done" && <TickGlyph size={13} />}
              {pendingActionOutcomeCopy(item)}
            </span>
          )}
          {finished && item?.status === "done" && item.resultUrl && (
            <button type="button" className="db-swarm-pill-btn" onClick={() => onOpenLink(item.resultUrl as string)}>
              Open
            </button>
          )}
          {(!finished || item?.status !== "done") && item?.status !== "executing" && (
            <button type="button" className="db-swarm-pill-btn" onClick={() => { setItem(null); setEditing(true); }}>
              {item ? "Review again" : `Review: ${TARGET_LABEL[target]}`}
            </button>
          )}
          {item?.status === "executing" && <span className="db-swarm-act-record db-swarm-shimmer">Working on it</span>}
        </div>
      )}
      {error && <p className="db-swarm-note">{error}</p>}
    </div>
  );
}

const DOC_PREVIEW_CHARS = 700;
const SAVE_FORMATS: DocumentFormat[] = ["docx", "pdf", "txt"];

/** A document the manager wrote (a revised resume, a cover letter). It is saved on this
 * computer, never sent anywhere, so there is no approval step: the user reads it, can
 * edit it, and picks Word, PDF or text. The original file they attached is never touched. */
function DocumentDraft({ draft }: { draft: Json }) {
  const title = str(draft.title) || "Aura document";
  const preferred = (SAVE_FORMATS as string[]).includes(str(draft.format)) ? (str(draft.format) as DocumentFormat) : "docx";
  const formats = [preferred, ...SAVE_FORMATS.filter((f) => f !== preferred)];
  const [text, setText] = useState(str(draft.body));
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<DocumentFormat | "">("");
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const long = text.length > DOC_PREVIEW_CHARS;

  const save = async (format: DocumentFormat) => {
    setBusy(format);
    setError("");
    try {
      setSaved(await saveDocumentDraft(title, text, format));
    } catch (err) {
      setError(typeof err === "string" ? err : "Aura couldn't save that file. Try again in a moment.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="db-swarm-doc">
      <span className="db-swarm-doc-name">{title}</span>
      {editing ? (
        <textarea
          className="db-swarm-doc-edit"
          rows={Math.min(18, Math.max(6, text.split("\n").length + 1))}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <p className={`db-swarm-doc-body${long && !expanded ? " is-clipped" : ""}`}>
          {long && !expanded ? `${text.slice(0, DOC_PREVIEW_CHARS)}…` : text}
        </p>
      )}
      <div className="db-swarm-act-row">
        {formats.map((format, i) => (
          <button
            key={format}
            type="button"
            className={`db-swarm-pill-btn${i === 0 ? " is-primary" : ""}`}
            disabled={busy !== "" || !text.trim()}
            onClick={() => void save(format)}
          >
            {busy === format ? "Saving" : `Save as ${FORMAT_LABEL[format]}`}
          </button>
        ))}
        <button type="button" className="db-swarm-pill-btn" onClick={() => setEditing((v) => !v)}>
          {editing ? "Done editing" : "Edit"}
        </button>
        {long && !editing && (
          <button type="button" className="db-swarm-pill-btn" onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Show less" : "Show all"}
          </button>
        )}
      </div>
      {saved && (
        <div className="db-swarm-act-row">
          <span className="db-swarm-muted">Saved to Downloads, Aura Documents.</span>
          <button type="button" className="db-swarm-pill-btn" onClick={() => void openPath(saved).catch(() => setError("Aura couldn't open it. Find it in Downloads, Aura Documents."))}>
            Open
          </button>
        </div>
      )}
      {error && <p className="db-swarm-note">{error}</p>}
    </div>
  );
}

/** The report. Every finding shows the sources it cites, a finding with none is marked
 * unsourced, and drafts are labelled as never sent. Gaps carry a Grant button when the
 * missing piece is a connector this manager was not given. */
export function ReportEmbed({
  message,
  managerId,
  granted,
  draftActions,
  onGrant,
  onOpenSource,
  answerable,
  onReply,
}: {
  message: SwarmMessage;
  managerId: string;
  granted: string[];
  draftActions: Record<string, string>;
  onGrant: (managerId: string, connector: string) => void;
  onOpenSource: (url: string) => void;
  /** The newest thing in the channel: its question still waits on the user. */
  answerable: boolean;
  /** Sends a tapped answer to this manager as a DM, which its next run reads as the answer. */
  onReply: (text: string) => void;
}) {
  const data = message.data;
  const state = str(data.state);
  const report = (data.report && typeof data.report === "object" ? data.report : {}) as Json;
  const sources = new Map(list(data.sources).map((s) => [str(s.id), s]));
  const findings = list(report.findings);
  const drafts = list(report.drafts);
  const gaps = list(report.gaps);
  const nextSteps = strings(report.next_steps);
  const question = (report.question && typeof report.question === "object" ? report.question : {}) as Json;
  const questionText = str(question.text);
  const questionChoices = strings(question.choices);
  const verified = data.verified === true;
  // A report built with no model call (runner.py _fallback_report): its findings were
  // raw excerpt lines, so the sources it had are shown instead of prose that was never written.
  const fallback = report.fallback === true;
  const stopCopy = state === "partial" || state === "failed" ? STOP_REASON_COPY[str(data.stop_reason)] ?? "" : "";

  // A source reads as what it is, never as "s3": the page's host for a web result, the
  // connector's own title (GitHub Aura-Desktop issues, Calendar) for a private read, which
  // has no URL to open and so renders as plain text.
  const chip = (ref: string): ReactNode => {
    const source = sources.get(ref);
    const url = str(source?.url);
    const title = str(source?.title) || ref;
    // A private read's title is a path ("GitHub Owner/Repo/src/lib/chatCache.ts"); its
    // last part is what tells two chips apart, and the tooltip keeps the whole thing.
    let label = title.includes("/") ? title.slice(title.lastIndexOf("/") + 1) || title : title;
    if (url) {
      try {
        label = new URL(url).hostname.replace(/^www\./, "");
      } catch {
        label = title;
      }
    }
    return url ? (
      <button key={ref} type="button" className="db-swarm-src" title={title} onClick={() => onOpenSource(url)}>
        {label}
      </button>
    ) : (
      <span key={ref} className="db-swarm-src is-static" title={title}>{label}</span>
    );
  };

  const actionable = (d: Json) => Boolean(TARGET_LABEL[str(d.target)] && str(d.id));
  const foot = gaps.length > 0 || nextSteps.length > 0;

  return (
    <section className={`db-swarm-report is-${state || "done"}`} aria-label="Report">
      {stopCopy && (
        <div className="db-swarm-report-status" role="note">
          <SignalGlyph size={14} />
          <span>{stopCopy}</span>
        </div>
      )}
      {(sources.size > 0 || verified) && <div className="db-swarm-report-head">
        {sources.size > 0 && <span className="db-swarm-muted">{sources.size} source{sources.size === 1 ? "" : "s"}</span>}
        {verified && (
          <span className="db-swarm-verified" title="A separate checker confirmed every goal against the sources">
            <SealGlyph size={13} /> Verified
          </span>
        )}
      </div>}
      {report.summary && !(fallback && stopCopy) ? (
        <SwarmMarkdown className="db-swarm-report-summary" text={str(report.summary)} onOpenLink={onOpenSource} />
      ) : null}
      {fallback && sources.size > 0 && (
        <div className="db-swarm-report-line">
          <span className="db-swarm-report-lead">Sources it had</span>
          <span className="db-swarm-src-row">{[...sources.keys()].map(chip)}</span>
        </div>
      )}
      {!fallback && findings.length > 0 && (
        <ul className="db-swarm-findings">
          {findings.map((f, i) => {
            // Two reads of the same place (one repo's issues, searched twice) are one chip.
            const seen = new Set<string>();
            const refs = strings(f.source_refs).filter((ref) => {
              const s = sources.get(ref);
              const key = str(s?.url) || str(s?.title) || ref;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            });
            return (
              <li key={i} className={`${refs.length === 0 ? "is-unsourced" : ""}${f.verified === true ? " is-verified" : ""}`}>
                <span className="db-swarm-finding-claim">{str(f.claim)}</span>
                {refs.length > 0 ? <FindingSources refs={refs} chip={chip} /> : <em className="db-swarm-report-unsourced">no source</em>}
              </li>
            );
          })}
        </ul>
      )}
      {drafts.map((d, i) => (
        <article key={i} className={`db-swarm-draft-card${PUBLIC_TARGETS.has(str(d.target)) && actionable(d) ? " is-public" : ""}`}>
          <header className="db-swarm-draft-card-head">
            <span className="db-swarm-kicker">{DRAFT_KIND[str(d.kind)] ?? "Draft"}</span>
            {str(d.destination) && <span className="db-swarm-muted">to {str(d.destination)}</span>}
            <span className={`db-swarm-tag${actionable(d) ? " is-ask" : ""}`}>
              {str(d.target) === "file" ? "Saved only on your computer" : actionable(d) ? "Needs your approval" : "Not sent"}
            </span>
          </header>
          {str(d.target) === "file" ? <DocumentDraft draft={d} /> : <p className="db-swarm-draft-card-body">{str(d.body)}</p>}
          {actionable(d) && message.sessionId && (
            <DraftAction
              sessionId={message.sessionId}
              draft={d}
              approvalId={draftActions[str(d.id)] ?? ""}
              onOpenLink={onOpenSource}
            />
          )}
        </article>
      ))}
      {foot && (
        <div className="db-swarm-report-foot">
          {gaps.length > 0 && (
            <div className="db-swarm-report-line is-gap">
              <span className="db-swarm-report-lead">Couldn't read</span>
              {gaps.map((g, i) => {
                const connector = str(g.connector);
                return (
                  <span key={i} className="db-swarm-report-gap">
                    {str(g.reason)}
                    {str(g.code) === "connector_not_granted" && connector && !granted.includes(connector) && (
                      <button type="button" className="db-swarm-link-btn" onClick={() => onGrant(managerId, connector)}>
                        Grant {CONNECTOR_LABEL[connector] ?? connector}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          )}
          {nextSteps.length > 0 && (
            <div className="db-swarm-report-line">
              <span className="db-swarm-report-lead">What's next</span>
              <ul className="db-swarm-report-next">
                {nextSteps.map((step, i) => <li key={i}>{step}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
      {questionText && (
        <div className={`db-swarm-report-ask${answerable ? " is-open" : ""}`}>
          <span className="db-swarm-kicker is-warn"><SignalGlyph size={13} /> Your call</span>
          <SwarmMarkdown className="db-swarm-text" text={questionText} />
          {answerable && questionChoices.length > 0 && (
            <div className="db-swarm-choice-row">
              {questionChoices.map((choice) => (
                <button key={choice} type="button" className="db-swarm-choice" onClick={() => onReply(choice)}>
                  {choice}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** How many source chips a finding shows before "+N" folds the rest. */
const SOURCES_SHOWN = 2;

/** A finding's sources at the end of its claim: the first few by domain, then "+N". */
function FindingSources({ refs, chip }: { refs: string[]; chip: (ref: string) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? refs : refs.slice(0, SOURCES_SHOWN);
  const rest = refs.length - shown.length;
  return (
    <span className="db-swarm-src-row">
      {shown.map(chip)}
      {rest > 0 && (
        <button type="button" className="db-swarm-src is-more" onClick={() => setAll(true)} aria-label={`Show ${rest} more source${rest === 1 ? "" : "s"}`}>
          +{rest}
        </button>
      )}
    </span>
  );
}

/** Why a manager could not join a #group round (rounds.py _SKIP_COPY codes). */
const ROUND_SKIP_COPY: Record<string, string> = {
  manager_busy: "busy with something else",
  too_many_live: "too many already running",
  manager_paused: "paused",
  manager_not_found: "no longer exists",
  wallet_exhausted: "budget used up today",
  models_unset: "Swarm is not set up yet",
  model_unpriced: "Swarm is not set up yet",
  model_unsupported: "Swarm is not set up yet",
};

const END_COPY: Record<string, string> = {
  done: "done",
  partial: "stopped short",
  failed: "could not finish",
  cancelled: "stopped",
};

function roundMembers(message: SwarmMessage, round: SwarmRoundView | undefined): SwarmRoundMember[] {
  return round?.members.length ? round.members : list(message.data.members).map(mapRoundMember);
}

/** The Supervisor's "asked these managers" card in #group. Each member's state is live from
 * its polled session; Stop ends every one still working. The answer arrives as its own
 * round_reply message once they have all finished. */
export function RoundEmbed({
  message,
  round,
  sessions,
  stopping,
  onStop,
  onOpen,
}: {
  message: SwarmMessage;
  round: SwarmRoundView | undefined;
  sessions: Record<string, SwarmSessionView>;
  stopping: boolean;
  onStop: () => void;
  onOpen: (managerId: string) => void;
}) {
  const members = roundMembers(message, round);
  const ended = (m: SwarmRoundMember) => {
    const s = sessions[m.sessionId];
    return m.state !== "running" || (s !== undefined && TERMINAL_SESSION_STATES.has(s.state));
  };
  const running = members.filter((m) => !ended(m));
  const done = round?.state === "done";
  const label = (m: SwarmRoundMember): string => {
    if (m.state === "skipped") return ROUND_SKIP_COPY[m.reason] ?? "could not start";
    const s = sessions[m.sessionId];
    if (s && !TERMINAL_SESSION_STATES.has(s.state)) return PHASE_COPY[s.state] ?? "Working";
    return END_COPY[s?.state ?? m.endState] ?? (m.state === "running" ? "Starting" : "done");
  };
  return (
    <div className={`db-swarm-run is-round${stopping ? " is-stopping" : ""}${done ? " is-done" : ""}`}>
      {done ? (
        <span className="db-swarm-kicker"><TeamGlyph size={13} /> Team round</span>
      ) : (
        <ThinkingRow
          id="swarm"
          state={stopping ? "stopping" : running.length > 0 ? "round" : "reporting"}
          tone={stopping ? "warn" : "sup"}
          activity={running.length > 0 ? (stopping ? "Stopping after this step" : `${running.length} of ${members.length} working`) : "Writing the answer"}
        />
      )}
      {message.text && <p className="db-swarm-run-plan">{message.text}</p>}
      <ul className="db-swarm-lanes">
        {members.map((m) => (
          <li key={m.managerId} className={m.state === "skipped" ? "is-failed" : ended(m) ? "is-done" : "is-leased"}>
            <CellGlyph size={14} />
            <span>
              <button type="button" className="db-swarm-link-btn" onClick={() => onOpen(m.managerId)} title={`Open ${m.title}'s DM`}>
                {m.title}
              </button>
            </span>
            <em>{label(m)}</em>
          </li>
        ))}
      </ul>
      {running.length > 0 && (
        <div className="db-swarm-run-foot">
          <span>The answer lands here when they finish.</span>
          <button type="button" className="db-swarm-pill-btn is-stop" onClick={onStop} disabled={stopping}>
            <HaltGlyph size={14} /> Stop all
          </button>
        </div>
      )}
    </div>
  );
}

/** The Supervisor's one combined answer to a round: the reply, what needs the user, and a
 * line per manager that opens its DM for the full report. A plain summary (no Supervisor
 * model set, or the model failed) is labelled as such rather than passed off as written. */
export function RoundReplyEmbed({ message, onOpen }: { message: SwarmMessage; onOpen: (managerId: string) => void }) {
  const members = list(message.data.members);
  const needs = strings(message.data.needs_you);
  const reply = str(message.data.reply) || message.text;
  const short = members.some((m) => str(m.state) === "skipped" || str(m.end_state) !== "done");
  return (
    <section className={`db-swarm-report is-${short ? "partial" : "done"}`} aria-label="Team answer">
      {message.data.fallback === true && (
        <div className="db-swarm-report-status" role="note">
          <SignalGlyph size={14} />
          <span>A plain summary: the team's writer was not available.</span>
        </div>
      )}
      <div className="db-swarm-report-head"><span className="db-swarm-kicker"><TeamGlyph size={13} /> Team answer</span></div>
      <SwarmMarkdown className="db-swarm-report-summary" text={reply} />
      {needs.length > 0 && (
        <p className="db-swarm-report-line is-gap">
          <span className="db-swarm-report-lead">Needs you</span>
          {needs.map((n, i) => <span key={i} className="db-swarm-report-gap">{n}</span>)}
        </p>
      )}
      <ul className="db-swarm-report-list">
        {members.map((m) => (
          <li key={str(m.manager_id)} className={str(m.state) === "skipped" || str(m.end_state) !== "done" ? "is-unsourced" : ""}>
            <b>{str(m.title)}:</b> {str(m.line)}
            {str(m.state) !== "skipped" && (
              <button type="button" className="db-swarm-link-btn db-swarm-report-open" onClick={() => onOpen(str(m.manager_id))}>
                Open report
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
