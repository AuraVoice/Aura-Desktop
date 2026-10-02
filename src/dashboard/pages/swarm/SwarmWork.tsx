import { useEffect, useState, type ReactNode } from "react";
import {
  approvePendingAction,
  fetchPendingAction,
  pendingActionOutcomeCopy,
  rejectPendingAction,
  type PendingAction,
} from "../../../lib/pendingActions";
import type { SwarmMessage, SwarmRoundMember, SwarmRoundView, SwarmSessionView } from "../../../lib/swarmApi";
import { mapRoundMember, proposeDraft, SwarmRequestError, TERMINAL_SESSION_STATES } from "../../../lib/swarmApi";
import {
  BlockGlyph,
  BranchGlyph,
  CellGlyph,
  CourseGlyph,
  CrownGlyph,
  DartGlyph,
  DayGlyph,
  DeepGlyph,
  HaltGlyph,
  KeepGlyph,
  LeafGlyph,
  MailGlyph,
  SealGlyph,
  SeekGlyph,
  SignalGlyph,
  SparkGlyph,
  TeamGlyph,
} from "./SwarmGlyphs";

/** Everything a manager's session shows in its DM: the live chip, the plan, one row per
 * step, a question it is waiting on, and the report. All of it renders from append-only
 * messages plus the polled session view, so nothing here edits history. */

type Json = Record<string, unknown>;

const ANSWER_MAX = 1000;

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
  "aura.research": "Started a Research run",
};

function CapabilityGlyph({ id, size = 15 }: { id: string; size?: number }) {
  if (id === "web.search") return <SeekGlyph size={size} />;
  if (id === "web.read") return <LeafGlyph size={size} />;
  if (id.startsWith("gmail.")) return <MailGlyph size={size} />;
  if (id === "calendar.events") return <DayGlyph size={size} />;
  if (id === "classroom.due") return <CourseGlyph size={size} />;
  if (id === "github.activity") return <BranchGlyph size={size} />;
  if (id === "x.bookmarks") return <KeepGlyph size={size} />;
  if (id === "notion.recent") return <BlockGlyph size={size} />;
  if (id === "aura.research") return <DeepGlyph size={size} />;
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

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  if (!since) return null;
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  const label = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return <span className="db-swarm-work-time">{label}</span>;
}

/** The live chip on a session's "working" message. Once the session ends it folds to one line. */
export function WorkingEmbed({
  name,
  session,
  reported,
  stopping,
  onStop,
}: {
  name: string;
  session: SwarmSessionView | undefined;
  reported: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  if (!session && !reported) return <p className="db-swarm-muted">{name} took this on.</p>;
  if (!session || TERMINAL_SESSION_STATES.has(session.state)) {
    return <p className="db-swarm-muted">{name} worked on this. The report is below.</p>;
  }
  const tasks = session.lanes.filter((l) => l.kind === "task");
  const stopRequested = session.cancelRequested || stopping;
  return (
    <div className={`db-swarm-embed is-work${stopRequested ? " is-stopping" : ""}`} aria-live="polite">
      <div className="db-swarm-embed-kicker">
        <span className="db-swarm-work-dots" aria-hidden="true"><i /><i /><i /></span>
        {stopRequested ? "Stopping after this step" : PHASE_COPY[session.state] ?? "Working"}
        <Elapsed since={session.createdAt} />
        <span className="db-swarm-work-budget" title="Model decisions used of this session's limit">
          {session.decisionsUsed}/{session.maxDecisions} steps
        </span>
      </div>
      {tasks.length > 0 && (
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
      <div className="db-swarm-work-foot">
        <span className="db-swarm-muted">{session.sources} source{session.sources === 1 ? "" : "s"} so far</span>
        <button type="button" className="db-swarm-pill-btn is-stop" onClick={onStop} disabled={stopRequested}>
          <HaltGlyph size={14} /> Stop
        </button>
      </div>
    </div>
  );
}

export function PlanEmbed({ message }: { message: SwarmMessage }) {
  const criteria = list(message.data.criteria);
  const tasks = list(message.data.tasks);
  return (
    <div className="db-swarm-embed is-plan">
      <div className="db-swarm-embed-kicker"><SparkGlyph size={15} /> Plan</div>
      {message.text && <p>{message.text}</p>}
      {criteria.length > 0 && (
        <ol className="db-swarm-criteria">
          {criteria.map((c) => <li key={str(c.id)}>{str(c.text)}</li>)}
        </ol>
      )}
      {tasks.length > 1 && (
        <div className="db-swarm-embed-row">
          {tasks.map((t) => <em key={str(t.id)}>{str(t.goal)}</em>)}
        </div>
      )}
    </div>
  );
}

/** One step: what it did, on whose behalf, and how it went. A refused connector carries
 * its own Grant button, because that is the only thing the user can do about it. */
export function StepRow({
  message,
  managerId,
  granted,
  onGrant,
}: {
  message: SwarmMessage;
  managerId: string;
  granted: string[];
  onGrant: (managerId: string, connector: string) => void;
}) {
  const data = message.data;
  const capability = str(data.capability_id);
  const action = str(data.action);
  const ok = data.ok === true;
  const connector = str(data.connector);
  const label = capability ? CAPABILITY_COPY[capability] ?? capability : action === "finish" ? "Finished its part" : "Step";
  const duration = num(data.duration_ms);
  const added = num(data.sources_added);
  const sub = str(data.subagent_title);
  return (
    <div className={`db-swarm-step${capability && !ok ? " is-gap" : ""}`}>
      <span className="db-swarm-step-icon">{capability ? <CapabilityGlyph id={capability} /> : <SparkGlyph size={15} />}</span>
      <div className="db-swarm-step-body">
        <span className="db-swarm-step-head">
          <strong>{label}</strong>
          {sub && <span className="db-swarm-muted">via {sub}</span>}
          {duration > 0 && <span className="db-swarm-muted">{(duration / 1000).toFixed(1)}s</span>}
          {added > 0 && <span className="db-swarm-muted">+{added} source{added === 1 ? "" : "s"}</span>}
        </span>
        {(str(data.why) || message.text) && <span className="db-swarm-step-why">{str(data.why) || message.text}</span>}
        {capability && !ok && str(data.gap_reason) && (
          <span className="db-swarm-step-gap">
            {str(data.gap_reason)}
            {str(data.gap_code) === "connector_not_granted" && connector && !granted.includes(connector) && (
              <button type="button" className="db-swarm-pill-btn" onClick={() => onGrant(managerId, connector)}>
                Grant {CONNECTOR_LABEL[connector] ?? connector}
              </button>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

export function QuestionEmbed({
  message,
  open,
  busy,
  onAnswer,
}: {
  message: SwarmMessage;
  open: boolean;
  busy: boolean;
  onAnswer: (text: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <>
      <p className="db-swarm-text">{message.text}</p>
      {open && (
        <div className="db-swarm-embed is-ask">
          <div className="db-swarm-embed-kicker"><SignalGlyph size={16} /> Waiting on you</div>
          <form
            className="db-swarm-free-answer"
            onSubmit={(event) => {
              event.preventDefault();
              if (value.trim()) onAnswer(value.trim());
            }}
          >
            <input
              value={value}
              maxLength={ANSWER_MAX}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Your answer"
              aria-label="Your answer"
            />
            <button type="submit" className="db-swarm-send is-small" disabled={busy || !value.trim()} aria-label="Send answer">
              <DartGlyph size={16} />
            </button>
          </form>
        </div>
      )}
    </>
  );
}

const REPORT_KICKER: Record<string, string> = {
  done: "Report",
  partial: "Partial report",
  cancelled: "Stopped",
  failed: "Could not finish",
};

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
};

const DRAFT_KIND: Record<string, string> = {
  email: "Email draft",
  post: "Post draft",
  message: "Message draft",
  application: "Application draft",
  event: "Calendar hold",
};

const TARGET_LABEL: Record<string, string> = {
  x: "Post to X",
  linkedin: "Post to LinkedIn",
  calendar: "Add to your calendar",
};
const TARGET_LIMIT: Record<string, number> = { x: 280, linkedin: 3000 };

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
    void fetchPendingAction(approvalId).then((found) => live && found && setItem(found)).catch(() => undefined);
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

  return (
    <div className="db-swarm-act">
      {pending && item ? (
        <>
          <span className="db-swarm-gaps-label">
            {item.title}
            {item.preview.account && ` · ${item.preview.account}`}
          </span>
          {target === "calendar" ? (
            <p className="db-swarm-act-preview">
              <b>{item.preview.eventTitle}</b>
              {"\n"}
              {localTime(item.preview.start)} to {localTime(item.preview.end)}
            </p>
          ) : (
            <p className="db-swarm-act-preview">{item.preview.text}</p>
          )}
          <div className="db-swarm-act-row">
            <button type="button" className="db-swarm-pill-btn is-primary" disabled={busy} onClick={() => void run(() => approvePendingAction(item.approvalId))}>
              {busy ? "Working" : "Approve"}
            </button>
            <button type="button" className="db-swarm-pill-btn" disabled={busy} onClick={() => void run(() => rejectPendingAction(item.approvalId))}>
              Not now
            </button>
            <span className="db-swarm-act-count">
              {item.preview.estimatedCostUsd !== null && `about $${item.preview.estimatedCostUsd.toFixed(2)} · `}
              Exactly this, once
            </span>
          </div>
        </>
      ) : editing ? (
        <>
          {limit > 0 ? (
            <textarea rows={Math.min(8, Math.max(3, Math.ceil(text.length / 70)))} value={text} onChange={(e) => setText(e.target.value)} />
          ) : (
            <p className="db-swarm-act-preview">
              <b>{str(draft.title) || "Hold"}</b>
              {"\n"}
              {str(draft.when)}
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
          {finished && item && <span className="db-swarm-muted">{pendingActionOutcomeCopy(item)}</span>}
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
          {item?.status === "executing" && <span className="db-swarm-muted">Working on it.</span>}
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
  onOpenResearch,
}: {
  message: SwarmMessage;
  managerId: string;
  granted: string[];
  draftActions: Record<string, string>;
  onGrant: (managerId: string, connector: string) => void;
  onOpenSource: (url: string) => void;
  onOpenResearch: (runId: string) => void;
}) {
  const data = message.data;
  const state = str(data.state);
  const report = (data.report && typeof data.report === "object" ? data.report : {}) as Json;
  const sources = new Map(list(data.sources).map((s) => [str(s.id), s]));
  const findings = list(report.findings);
  const drafts = list(report.drafts);
  const gaps = list(report.gaps);
  const nextSteps = strings(report.next_steps);
  const runs = strings(data.research_runs);
  const verified = data.verified === true;

  const chip = (ref: string): ReactNode => {
    const source = sources.get(ref);
    const url = str(source?.url);
    const title = str(source?.title) || ref;
    return url ? (
      <button key={ref} type="button" className="db-swarm-src" title={title} onClick={() => onOpenSource(url)}>
        {ref}
      </button>
    ) : (
      <span key={ref} className="db-swarm-src is-static" title={title}>{ref}</span>
    );
  };

  return (
    <div className={`db-swarm-embed is-report is-${state || "done"}`}>
      <div className="db-swarm-embed-kicker">
        <SparkGlyph size={15} /> {REPORT_KICKER[state] ?? "Report"}
        {verified && (
          <span className="db-swarm-verified" title="A separate checker confirmed every goal against the sources">
            <SealGlyph size={14} /> Verified
          </span>
        )}
      </div>
      {state === "partial" && STOP_REASON_COPY[str(data.stop_reason)] && (
        <p className="db-swarm-note">{STOP_REASON_COPY[str(data.stop_reason)]}</p>
      )}
      {report.summary ? <p className="db-swarm-report-summary">{str(report.summary)}</p> : null}
      {findings.length > 0 && (
        <ul className="db-swarm-findings">
          {findings.map((f, i) => {
            const refs = strings(f.source_refs);
            return (
              <li key={i} className={`${refs.length === 0 ? "is-unsourced" : ""}${f.verified === true ? " is-verified" : ""}`}>
                <span>{str(f.claim)}</span>
                <span className="db-swarm-src-row">
                  {refs.length > 0 ? refs.map(chip) : <em>no source</em>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {drafts.length > 0 && (
        <div className="db-swarm-drafts">
          {drafts.map((d, i) => (
            <div key={i} className="db-swarm-draft">
              <span className="db-swarm-draft-head">
                <b>{DRAFT_KIND[str(d.kind)] ?? "Draft"}</b>
                {str(d.destination) && <span> to {str(d.destination)}</span>}
                <em>{TARGET_LABEL[str(d.target)] && str(d.id) ? "needs your approval" : "not sent"}</em>
              </span>
              <p>{str(d.body)}</p>
              {TARGET_LABEL[str(d.target)] && str(d.id) && message.sessionId && (
                <DraftAction
                  sessionId={message.sessionId}
                  draft={d}
                  approvalId={draftActions[str(d.id)] ?? ""}
                  onOpenLink={onOpenSource}
                />
              )}
            </div>
          ))}
        </div>
      )}
      {gaps.length > 0 && (
        <div className="db-swarm-gaps">
          <span className="db-swarm-gaps-label">Could not read</span>
          {gaps.map((g, i) => {
            const connector = str(g.connector);
            return (
              <p key={i}>
                {str(g.reason)}
                {str(g.code) === "connector_not_granted" && connector && !granted.includes(connector) && (
                  <button type="button" className="db-swarm-pill-btn" onClick={() => onGrant(managerId, connector)}>
                    Grant {CONNECTOR_LABEL[connector] ?? connector}
                  </button>
                )}
              </p>
            );
          })}
        </div>
      )}
      {nextSteps.length > 0 && (
        <ul className="db-swarm-next">
          {nextSteps.map((step, i) => <li key={i}>{step}</li>)}
        </ul>
      )}
      {runs.length > 0 && (
        <div className="db-swarm-embed-foot">
          {runs.map((runId) => (
            <button key={runId} type="button" className="db-swarm-pill-btn" onClick={() => onOpenResearch(runId)}>
              <DeepGlyph size={14} /> Open the Research run
            </button>
          ))}
        </div>
      )}
    </div>
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
    <div className={`db-swarm-embed is-work${stopping ? " is-stopping" : ""}`} aria-live="polite">
      <div className="db-swarm-embed-kicker">
        {running.length > 0 ? <span className="db-swarm-work-dots" aria-hidden="true"><i /><i /><i /></span> : <TeamGlyph size={15} />}
        {done ? "Team round" : running.length > 0 ? (stopping ? "Stopping after this step" : `${running.length} working`) : "Writing the answer"}
      </div>
      {message.text && <p className="db-swarm-muted">{message.text}</p>}
      <ul className="db-swarm-lanes">
        {members.map((m) => (
          <li key={m.managerId} className={m.state === "skipped" ? "is-failed" : ended(m) ? "is-done" : "is-leased"}>
            <CellGlyph size={14} />
            <span>
              <button type="button" className="db-swarm-src is-static" onClick={() => onOpen(m.managerId)} title={`Open ${m.title}'s DM`}>
                {m.title}
              </button>
            </span>
            <em>{label(m)}</em>
          </li>
        ))}
      </ul>
      {running.length > 0 && (
        <div className="db-swarm-work-foot">
          <span className="db-swarm-muted">The answer lands here when they finish.</span>
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
    <div className={`db-swarm-embed is-report is-${short ? "partial" : "done"}`}>
      <div className="db-swarm-embed-kicker">
        <CrownGlyph size={15} /> Team answer
        {message.data.fallback === true && <span className="db-swarm-tag">Plain summary</span>}
      </div>
      <p className="db-swarm-report-summary">{reply}</p>
      {needs.length > 0 && (
        <div className="db-swarm-gaps">
          <span className="db-swarm-gaps-label">Needs you</span>
          {needs.map((n, i) => <p key={i} className="db-swarm-note">{n}</p>)}
        </div>
      )}
      <ul className="db-swarm-lanes">
        {members.map((m) => (
          <li key={str(m.manager_id)} className={str(m.state) === "skipped" ? "is-failed" : str(m.end_state) === "done" ? "" : "is-failed"}>
            <CellGlyph size={14} />
            <span><b>{str(m.title)}:</b> {str(m.line)}</span>
            {str(m.state) !== "skipped" && (
              <button type="button" className="db-swarm-pill-btn" onClick={() => onOpen(str(m.manager_id))}>
                Open report
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
