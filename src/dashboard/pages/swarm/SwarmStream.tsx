import { Fragment, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { SwarmDecision, SwarmManager, SwarmRoster, SwarmSessionView } from "../../../lib/swarmApi";
import { SwarmAvatar } from "./SwarmAvatar";
import {
  AscentGlyph,
  BuildGlyph,
  BurstGlyph,
  CellGlyph,
  CrownGlyph,
  CycleGlyph,
  DartGlyph,
  HopGlyph,
  LatticeGlyph,
  PulseGlyph,
  RewindGlyph,
  SignalGlyph,
  SparkGlyph,
  StudyGlyph,
  SwarmMark,
  TeamGlyph,
  WatchGlyph,
} from "./SwarmGlyphs";
import { PlanEmbed, QuestionEmbed, ReportEmbed, StepRow, WorkingEmbed } from "./SwarmWork";
import {
  CAPABILITY_LABEL,
  DECISION_LABEL,
  dayLabel,
  findManager,
  hueOf,
  timeLabel,
  type Author,
  type StreamItem,
} from "./swarmThread";

/** Equal to juno-backend swarm/models.py's message and answer limits; a larger value
 * here fails every send with invalid_body. */
const MESSAGE_MAX = 4000;
const ANSWER_MAX = 400;

const YOU: Author = { id: "you", name: "You", role: "you", hue: 0 };

const STARTERS = [
  {
    Icon: AscentGlyph,
    title: "Land a job",
    text: "I'm looking for a full-time job: find roles every day, tailor my resume to each one, draft outreach and track every application.",
  },
  {
    Icon: BuildGlyph,
    title: "Ship my side project",
    text: "I'm building an app on my own: keep a weekly plan, watch my GitHub issues, draft release notes and remind me what is blocking launch.",
  },
  {
    Icon: StudyGlyph,
    title: "Ace this semester",
    text: "I'm a student this semester: track every deadline from Google Classroom, build study plans before exams and quiz me on weak topics.",
  },
];

export interface ChannelView {
  kind: "group" | "activity" | "manager";
  name: string;
  topic: string;
  manager?: SwarmManager;
  author?: Author;
}

interface Props {
  view: ChannelView;
  items: StreamItem[];
  roster: SwarmRoster;
  openDrafts: ReadonlySet<string>;
  fresh: ReadonlySet<string>;
  busy: boolean;
  busyHere: boolean;
  busyAuthor: Author;
  busySince: number;
  error: string;
  onDismissError: () => void;
  /** Why managers cannot work right now, as user copy, or "". */
  notice: string;
  /** Show the notice in every channel, not only a manager's DM (a failed load). */
  noticeEverywhere: boolean;
  sessions: Record<string, SwarmSessionView>;
  stopping: ReadonlySet<string>;
  onStop: (sessionId: string) => void;
  onAnswerSession: (sessionId: string, text: string) => void;
  grants: Record<string, string[]>;
  onGrant: (managerId: string, connector: string) => void;
  onOpenSource: (url: string) => void;
  onOpenResearch: (runId: string) => void;
  text: string;
  onText: (value: string) => void;
  onSubmit: () => void;
  freeAnswers: Record<string, string>;
  onFreeAnswer: (draftId: string, value: string) => void;
  onAnswer: (draftId: string, label: string, managerId: string) => void;
  confirmReset: boolean;
  onAskReset: (ask: boolean) => void;
  onReset: () => void;
  rosterOpen: boolean;
  onToggleRoster: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Shown above the messages (the one-time sandbox import). */
  banner?: ReactNode;
}

function Confidence({ decision }: { decision: SwarmDecision }) {
  if (decision.via !== "classifier") {
    return <span className="db-swarm-via">{decision.via === "direct" ? "direct" : "your answer"}</span>;
  }
  const pct = Math.round(decision.confidence * 100);
  return (
    <span className="db-swarm-conf" title="How sure the router was of the owner">
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="db-swarm-conf-track" cx="10" cy="10" r="8" />
        <circle className="db-swarm-conf-fill" cx="10" cy="10" r="8" pathLength={100} style={{ strokeDasharray: `${pct} 100` }} />
      </svg>
      {pct}%
    </span>
  );
}

function HiredEmbed({ manager }: { manager: SwarmManager }) {
  const hue = hueOf(manager.id);
  return (
    <div className={`db-swarm-embed is-hired is-hue-${hue}`}>
      <div className="db-swarm-embed-kicker"><BurstGlyph size={16} /> Manager hired</div>
      <strong className="db-swarm-embed-title">{manager.title}</strong>
      {manager.description && <p>{manager.description}</p>}
      {manager.subagents.length > 0 && (
        <div className="db-swarm-embed-team">
          {manager.subagents.map((s, i) => (
            <span key={s.id} className={s.isVerifier ? "is-verifier" : ""} style={{ animationDelay: `${180 + i * 60}ms` }}>
              {s.isVerifier ? <WatchGlyph size={14} /> : <CellGlyph size={14} />} {s.title}
            </span>
          ))}
        </div>
      )}
      {(manager.connectors.length > 0 || manager.missingCapabilities.length > 0) && (
        <div className="db-swarm-embed-row">
          {manager.connectors.map((c) => <em key={c}>{c}</em>)}
          {manager.missingCapabilities.map((c) => <em key={c} className="is-warn">needs {c}</em>)}
        </div>
      )}
      {manager.routines.length > 0 && (
        <div className="db-swarm-embed-foot"><SparkGlyph size={14} /> {manager.routines.join(" · ")}</div>
      )}
    </div>
  );
}

function AskEmbed({
  decision,
  roster,
  busy,
  freeAnswer,
  onFreeAnswer,
  onAnswer,
}: {
  decision: SwarmDecision;
  roster: SwarmRoster;
  busy: boolean;
  freeAnswer: string;
  onFreeAnswer: (value: string) => void;
  onAnswer: (label: string, managerId: string) => void;
}) {
  const choices = roster.drafts.find((d) => d.id === decision.draftId)?.choices ?? [];
  return (
    <div className="db-swarm-embed is-ask">
      <div className="db-swarm-embed-kicker"><SignalGlyph size={16} /> Waiting on you</div>
      {choices.length > 0 && (
        <div className="db-swarm-choice-row">
          {choices.map((c, i) => (
            <button
              key={`${c.managerId}-${c.label}`}
              type="button"
              className="db-swarm-choice"
              disabled={busy}
              style={{ animationDelay: `${i * 50}ms` }}
              onClick={() => onAnswer(c.label, c.managerId)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      <form
        className="db-swarm-free-answer"
        onSubmit={(event) => {
          event.preventDefault();
          if (freeAnswer.trim()) onAnswer(freeAnswer.trim(), "");
        }}
      >
        <input
          value={freeAnswer}
          maxLength={ANSWER_MAX}
          onChange={(event) => onFreeAnswer(event.target.value)}
          placeholder="Or answer in your own words"
          aria-label="Your answer"
        />
        <button type="submit" className="db-swarm-send is-small" disabled={busy || !freeAnswer.trim()} aria-label="Send answer">
          <DartGlyph size={16} />
        </button>
      </form>
    </div>
  );
}

function Typing({ author, since }: { author: Author; since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - since) / 1000));
  return (
    <div className="db-swarm-typing" aria-live="polite">
      <span className="db-swarm-typing-dots" aria-hidden="true"><i /><i /><i /></span>
      <span><strong>{author.name}</strong> is deciding who owns this</span>
      {seconds >= 4 && <span className="db-swarm-typing-time">{seconds}s</span>}
    </div>
  );
}

function ChannelIntro({ view }: { view: ChannelView }) {
  if (view.kind === "manager" && view.author) {
    return (
      <div className="db-swarm-intro">
        <SwarmAvatar author={view.author} size="lg" />
        <h2>{view.name}</h2>
        <p>This is your direct line to {view.name}. What you send here becomes its brief: it searches, reads what you granted it, and reports back here. It never sends anything.</p>
      </div>
    );
  }
  if (view.kind === "activity") {
    return (
      <div className="db-swarm-intro is-compact">
        <span className="db-swarm-intro-icon"><PulseGlyph size={26} /></span>
        <h2>#activity</h2>
        <p>Every hire, handover, routine and skip, across every channel. Read only.</p>
      </div>
    );
  }
  return null;
}

function GroupHero({ onStarter }: { onStarter: (text: string) => void }) {
  return (
    <div className="db-swarm-hero">
      <div className="db-swarm-hero-orb" aria-hidden="true">
        <span className="db-swarm-hero-core"><SwarmMark size={30} /></span>
        <i className="db-swarm-hero-ring" />
        <i className="db-swarm-hero-ring is-outer" />
        <i className="db-swarm-hero-sat is-a" />
        <i className="db-swarm-hero-sat is-b" />
        <i className="db-swarm-hero-sat is-c" />
      </div>
      <h2>Build your swarm</h2>
      <p>Tell Aura about something ongoing. It hires a manager for it, gives that manager a team, and brings in a Supervisor once you have two.</p>
      <div className="db-swarm-starters">
        {STARTERS.map(({ Icon, title, text }, i) => (
          <button key={title} type="button" className="db-swarm-starter" style={{ animationDelay: `${120 + i * 70}ms` }} onClick={() => onStarter(text)}>
            <Icon size={22} />
            <strong>{title}</strong>
            <span>{text}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function DecisionMessage({
  item,
  roster,
  openDrafts,
  busy,
  freeAnswers,
  onFreeAnswer,
  onAnswer,
}: {
  item: Extract<StreamItem, { kind: "decision" }>;
} & Pick<Props, "roster" | "openDrafts" | "busy" | "freeAnswers" | "onFreeAnswer" | "onAnswer">) {
  const d = item.decision;
  const capability = CAPABILITY_LABEL[d.capability];
  const hired = d.decision === "new_manager" && d.applied ? findManager(roster, d.targetManagerId) : undefined;
  const asking = d.decision === "ask" && openDrafts.has(d.draftId);
  return (
    <>
      <div className="db-swarm-msg-head">
        <strong className={`db-swarm-name is-${item.author.role === "manager" ? `hue-${item.author.hue}` : item.author.role}`}>{item.author.name}</strong>
        <span className={`db-swarm-tag is-${d.decision}`}>{DECISION_LABEL[d.decision]}</span>
        {d.subagentTitle && <span className="db-swarm-muted">via {d.subagentTitle}</span>}
        {capability && <span className="db-swarm-cap">{capability}</span>}
        <Confidence decision={d} />
        {item.at > 0 && <time>{timeLabel(item.at)}</time>}
      </div>
      {d.reason && <p className="db-swarm-text">{d.reason}</p>}
      {d.note && <p className="db-swarm-note">{d.note}</p>}
      {d.alternatives.length > 0 && d.decision !== "ask" && (
        <p className="db-swarm-muted db-swarm-alt">Also considered: {d.alternatives.map((a) => a.why).join("; ")}</p>
      )}
      {hired && <HiredEmbed manager={hired} />}
      {asking && (
        <AskEmbed
          decision={d}
          roster={roster}
          busy={busy}
          freeAnswer={freeAnswers[d.draftId] ?? ""}
          onFreeAnswer={(value) => onFreeAnswer(d.draftId, value)}
          onAnswer={(label, managerId) => onAnswer(d.draftId, label, managerId)}
        />
      )}
    </>
  );
}

/** Centre column: the channel header, its messages, and the composer. */
export function SwarmStream(props: Props) {
  const { view, items, busy, busyHere, error, text, composerRef } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const readOnly = view.kind === "activity";
  // Only a session's newest question can be open; earlier ones were already answered.
  const latestQuestion: Record<string, string> = {};
  for (const item of items) if (item.kind === "question") latestQuestion[item.message.sessionId] = item.key;

  // Stick to the bottom on new content, the way a chat does.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, busyHere, view.name]);

  // The composer grows with its text up to a cap, then scrolls.
  useLayoutEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`;
  }, [text, composerRef]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!busy && text.trim() && !readOnly) props.onSubmit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  let lastDay = "";
  let lastAuthorKey = "";
  const placeholder = readOnly ? "Read only" : view.kind === "manager" ? `Message ${view.name}` : `Message #${view.name}`;
  const showHero = view.kind === "group" && items.length === 0 && !busyHere;

  return (
    <section className="db-swarm-stream" aria-label={view.kind === "manager" ? `Direct messages with ${view.name}` : `#${view.name}`}>
      <header className="db-swarm-stream-head">
        {view.kind === "manager" && view.author ? (
          <SwarmAvatar author={view.author} size="sm" live={view.manager?.status === "active"} />
        ) : (
          <span className="db-swarm-head-hash">{view.kind === "activity" ? <PulseGlyph size={20} /> : <LatticeGlyph size={20} />}</span>
        )}
        <h2>{view.name}</h2>
        <span className="db-swarm-topic">{view.topic}</span>
        <div className="db-swarm-head-tools">
          {props.confirmReset ? (
            <span className="db-swarm-confirm">
              <button type="button" className="db-swarm-pill-btn is-danger" onClick={props.onReset}>Reset everything</button>
              <button type="button" className="db-swarm-pill-btn" onClick={() => props.onAskReset(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="db-swarm-icon-btn" onClick={() => props.onAskReset(true)} disabled={busy} aria-label="Reset roster and thread" title="Reset roster and thread">
              <RewindGlyph size={18} />
            </button>
          )}
          <button
            type="button"
            className={`db-swarm-icon-btn db-swarm-roster-toggle${props.rosterOpen ? " is-active" : ""}`}
            onClick={props.onToggleRoster}
            aria-label="Show team"
            aria-pressed={props.rosterOpen}
            title="Show team"
          >
            <TeamGlyph size={18} />
          </button>
        </div>
      </header>

      {props.banner}
      <div className="db-swarm-scroll" ref={scrollRef}>
        <div key={view.kind === "manager" ? `m-${view.manager?.id}` : view.kind} className="db-swarm-channel-pane">
          {showHero ? (
            <GroupHero onStarter={(starter) => { props.onText(starter); composerRef.current?.focus(); }} />
          ) : (
            <>
              <ChannelIntro view={view} />
              {items.map((item) => {
                const fresh = props.fresh.has(item.key);
                const day = item.at ? dayLabel(item.at) : "";
                const daySep = day && day !== lastDay ? (lastDay = day) : "";
                if (item.kind === "system") {
                  lastAuthorKey = "";
                  return (
                    <Fragment key={item.key}>
                      {daySep && <div className="db-swarm-daysep"><span>{daySep}</span></div>}
                      <div className={`db-swarm-sys${item.tone === "supervisor" ? " is-supervisor" : ""}${fresh ? " is-fresh" : ""}`}>
                        <span className="db-swarm-sys-icon">
                          {item.tone === "supervisor" ? <CrownGlyph size={15} /> : item.tone === "routine" ? <CycleGlyph size={15} /> : <SparkGlyph size={15} />}
                        </span>
                        <span className="db-swarm-sys-text">{item.text}</span>
                        {item.at > 0 && <time>{timeLabel(item.at)}</time>}
                      </div>
                    </Fragment>
                  );
                }
                if (item.kind === "step") {
                  lastAuthorKey = "";
                  return (
                    <Fragment key={item.key}>
                      {daySep && <div className="db-swarm-daysep"><span>{daySep}</span></div>}
                      <div className={`db-swarm-step-wrap${fresh ? " is-fresh" : ""}`}>
                        <StepRow
                          message={item.message}
                          managerId={item.author.id}
                          granted={props.grants[item.author.id] ?? []}
                          onGrant={props.onGrant}
                        />
                      </div>
                    </Fragment>
                  );
                }
                if (item.kind === "crosspost") {
                  lastAuthorKey = "";
                  return (
                    <Fragment key={item.key}>
                      {daySep && <div className="db-swarm-daysep"><span>{daySep}</span></div>}
                      <div className={`db-swarm-sys is-crosspost${fresh ? " is-fresh" : ""}`}>
                        <span className="db-swarm-sys-icon"><HopGlyph size={15} /></span>
                        <span className="db-swarm-sys-text">
                          <b>Routed</b> from #{props.roster.supervisor?.status === "active" ? "group" : "front-door"}: {item.text}
                        </span>
                        {item.at > 0 && <time>{timeLabel(item.at)}</time>}
                      </div>
                    </Fragment>
                  );
                }
                const author = item.kind === "user" ? YOU : item.author;
                const authorKey = item.kind === "user" ? "you" : `${author.id}-${item.key}`;
                const continued = item.kind === "user" && authorKey === lastAuthorKey && !daySep;
                lastAuthorKey = authorKey;
                return (
                  <Fragment key={item.key}>
                    {daySep && <div className="db-swarm-daysep"><span>{daySep}</span></div>}
                    <article className={`db-swarm-msg${item.kind === "user" ? " is-you" : ""}${continued ? " is-continued" : ""}${fresh ? " is-fresh" : ""}`}>
                      <div className="db-swarm-msg-gutter">{!continued && <SwarmAvatar author={author} />}</div>
                      <div className="db-swarm-msg-body">
                        {item.kind === "user" ? (
                          <>
                            {!continued && (
                              <div className="db-swarm-msg-head">
                                <strong className="db-swarm-name is-you">You</strong>
                                {item.at > 0 && <time>{timeLabel(item.at)}</time>}
                              </div>
                            )}
                            <p className="db-swarm-text">{item.text}</p>
                          </>
                        ) : item.kind !== "decision" ? (
                          <>
                            <div className="db-swarm-msg-head">
                              <strong className={`db-swarm-name is-${item.author.role === "manager" ? `hue-${item.author.hue}` : item.author.role}`}>{item.author.name}</strong>
                              {item.at > 0 && <time>{timeLabel(item.at)}</time>}
                            </div>
                            {item.kind === "say" && <p className="db-swarm-text">{item.text}</p>}
                            {item.kind === "working" && (
                              <WorkingEmbed
                                name={item.author.name}
                                session={props.sessions[item.sessionId]}
                                stopping={props.stopping.has(item.sessionId)}
                                onStop={() => props.onStop(item.sessionId)}
                              />
                            )}
                            {item.kind === "plan" && <PlanEmbed message={item.message} />}
                            {item.kind === "question" && (
                              <QuestionEmbed
                                message={item.message}
                                open={props.sessions[item.message.sessionId]?.state === "waiting_user" && latestQuestion[item.message.sessionId] === item.key}
                                busy={busy}
                                onAnswer={(value) => props.onAnswerSession(item.message.sessionId, value)}
                              />
                            )}
                            {item.kind === "report" && (
                              <ReportEmbed
                                message={item.message}
                                managerId={item.author.id}
                                granted={props.grants[item.author.id] ?? []}
                                onGrant={props.onGrant}
                                onOpenSource={props.onOpenSource}
                                onOpenResearch={props.onOpenResearch}
                              />
                            )}
                          </>
                        ) : (
                          <DecisionMessage
                            item={item}
                            roster={props.roster}
                            openDrafts={props.openDrafts}
                            busy={busy}
                            freeAnswers={props.freeAnswers}
                            onFreeAnswer={props.onFreeAnswer}
                            onAnswer={props.onAnswer}
                          />
                        )}
                      </div>
                    </article>
                  </Fragment>
                );
              })}
              {readOnly && items.length === 0 && <p className="db-swarm-empty-line">Nothing has happened yet.</p>}
            </>
          )}
          {busyHere && <Typing author={props.busyAuthor} since={props.busySince} />}
        </div>
      </div>

      {props.notice && (view.kind === "manager" || props.noticeEverywhere) && (
        <div className="db-swarm-notice" role="status">
          <SignalGlyph size={16} />
          <span>{props.notice}</span>
        </div>
      )}
      {error && (
        <div className="db-swarm-error" role="alert">
          <SignalGlyph size={17} />
          <span>{error}</span>
          <button type="button" onClick={props.onDismissError}>Dismiss</button>
        </div>
      )}

      <form className={`db-swarm-composer${readOnly ? " is-readonly" : ""}${busy ? " is-busy" : ""}`} onSubmit={submit}>
        <label htmlFor="swarm-message" className="db-swarm-sr">Message</label>
        <textarea
          id="swarm-message"
          ref={composerRef}
          rows={1}
          value={readOnly ? "" : text}
          maxLength={MESSAGE_MAX}
          disabled={readOnly}
          onChange={(event) => props.onText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
        />
        {!readOnly && text.length > MESSAGE_MAX - 400 && <span className="db-swarm-count">{MESSAGE_MAX - text.length}</span>}
        <button type="submit" className="db-swarm-send" disabled={readOnly || busy || !text.trim()} aria-label="Send">
          <DartGlyph size={19} />
        </button>
      </form>
      <p className="db-swarm-composer-hint">
        {readOnly
          ? "Activity is written by the swarm."
          : view.kind === "manager"
            ? "This becomes the manager's brief. It only reads; drafts are never sent."
            : "Aura routes this to the manager that owns it, and that manager starts on it."}
        <span> Enter to send, Shift+Enter for a new line.</span>
      </p>
    </section>
  );
}
