import { useEffect, useState, type ReactNode } from "react";
import type { SwarmMessage, SwarmSessionView } from "../../../lib/swarmApi";
import { TERMINAL_SESSION_STATES } from "../../../lib/swarmApi";
import {
  BlockGlyph,
  BranchGlyph,
  CellGlyph,
  CourseGlyph,
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
  stopping,
  onStop,
}: {
  name: string;
  session: SwarmSessionView | undefined;
  stopping: boolean;
  onStop: () => void;
}) {
  if (!session) return <p className="db-swarm-muted">{name} took this on.</p>;
  if (TERMINAL_SESSION_STATES.has(session.state)) {
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

const DRAFT_KIND: Record<string, string> = {
  email: "Email draft",
  post: "Post draft",
  message: "Message draft",
  application: "Application draft",
};

/** The report. Every finding shows the sources it cites, a finding with none is marked
 * unsourced, and drafts are labelled as never sent. Gaps carry a Grant button when the
 * missing piece is a connector this manager was not given. */
export function ReportEmbed({
  message,
  managerId,
  granted,
  onGrant,
  onOpenSource,
  onOpenResearch,
}: {
  message: SwarmMessage;
  managerId: string;
  granted: string[];
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
                <em>not sent</em>
              </span>
              <p>{str(d.body)}</p>
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
