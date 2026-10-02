import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { SwarmDecision, SwarmDoc, SwarmManager, SwarmRoster, SwarmRoundView, SwarmSessionView } from "../../../lib/swarmApi";
import { DOCUMENT_ACCEPT } from "../../../lib/documentText";
import { Paperclip } from "lucide-react";
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
  SheetGlyph,
  SignalGlyph,
  SparkGlyph,
  StudyGlyph,
  SwarmMark,
  TackGlyph,
  TeamGlyph,
  WatchGlyph,
} from "./SwarmGlyphs";
import { PlanEmbed, QuestionEmbed, ReportEmbed, RoundEmbed, RoundReplyEmbed, StepRow, WorkingEmbed } from "./SwarmWork";
import {
  CAPABILITY_LABEL,
  DECISION_LABEL,
  dayLabel,
  findManager,
  hueOf,
  managerChannel,
  roleLabel,
  timeLabel,
  type Author,
  type ChannelId,
  type StreamItem,
} from "./swarmThread";

/** Equal to juno-backend swarm/runtime_models.py's limits: a #group message's text (4000)
 * and a DM's brief (MAX_BRIEF_CHARS, 2000). A larger value here fails the send with
 * invalid_body. */
const GROUP_MESSAGE_MAX = 4000;
const BRIEF_MAX = 2000;
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

export const MAX_ATTACHMENTS = 5;

export interface ComposerDoc {
  key: string;
  name: string;
  status: "reading" | "ready" | "failed";
  docId: string;
  error: string;
}

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
  rounds: Record<string, SwarmRoundView>;
  onStopRound: (roundId: string) => void;
  onOpenChannel: (channel: ChannelId) => void;
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
  rosterOpen: boolean;
  onToggleRoster: () => void;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  /** The New manager button was pressed: the empty composer says what to write. */
  hireHint: boolean;
  /** Files picked for the next message, each read on this machine then put on the shelf. */
  attachments: ComposerDoc[];
  onAttach: (files: File[]) => void;
  onRemoveAttachment: (key: string) => void;
  /** Shelf files by id, for the pin state on a sent message's file chips. */
  docShelf: Record<string, SwarmDoc>;
  onPinDoc: (docId: string, managerId: string, pinned: boolean) => void;
  /** The signed-in user's first name, shown beside "You". */
  youName: string;
  /** Shown above the messages (the one-time sandbox import). */
  banner?: ReactNode;
}

function Confidence({ decision }: { decision: SwarmDecision }) {
  if (decision.via !== "classifier") {
    return <span className="db-swarm-via">{decision.via === "direct" ? "direct" : "your answer"}</span>;
  }
  const pct = Math.round(decision.confidence * 100);
  return (
    <span className="db-swarm-conf" title="How sure Aura was about who should own this">
      {pct}% sure
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
        <span className="db-swarm-role">{roleLabel(item.author, roster)}</span>
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
  const messageMax = view.kind === "manager" ? BRIEF_MAX : GROUP_MESSAGE_MAX;
  // Handlers are read at click time, so the list below need not rebuild when only the
  // composer's text (or a fresh inline arrow from the page) changed.
  const live = useRef(props);
  useLayoutEffect(() => {
    live.current = props;
  });

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

  const fileRef = useRef<HTMLInputElement | null>(null);
  const reading = props.attachments.some((a) => a.status === "reading");
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (!busy && !reading && text.trim() && !readOnly && text.length <= messageMax) props.onSubmit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const rows = useMemo(() => {
    // Only a session's newest question can be open; earlier ones were already answered.
    const latestQuestion: Record<string, string> = {};
    // A session whose report is in the thread needs no fetch to say it finished.
    const reported = new Set<string>();
    for (const item of items) {
      if (item.kind === "question") latestQuestion[item.message.sessionId] = item.key;
      if (item.kind === "report") reported.add(item.message.sessionId);
    }
    let lastDay = "";
    let lastAuthorKey = "";
    return items.map((item) => {
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
                onGrant={(managerId, connector) => live.current.onGrant(managerId, connector)}
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
                      <strong className="db-swarm-name is-you">{props.youName || "You"}</strong>
                      {props.youName && <span className="db-swarm-role">You</span>}
                      {item.at > 0 && <time>{timeLabel(item.at)}</time>}
                    </div>
                  )}
                  <p className="db-swarm-text">{item.text}</p>
                  {item.docs.length > 0 && (
                    <div className="db-swarm-files">
                      {item.docs.map((doc) => {
                        const shelf = props.docShelf[doc.id];
                        const managerId = view.kind === "manager" ? view.manager?.id ?? "" : "";
                        const pinned = Boolean(managerId && shelf?.pinnedTo.includes(managerId));
                        return (
                          <span key={doc.id} className={`db-swarm-file${shelf ? "" : " is-gone"}`} title={shelf ? doc.name : `${doc.name} is no longer on the shelf`}>
                            <SheetGlyph size={15} />
                            <span className="db-swarm-file-name">{doc.name}</span>
                            {managerId && shelf && (
                              <button
                                type="button"
                                className={`db-swarm-file-pin${pinned ? " is-on" : ""}`}
                                aria-pressed={pinned}
                                title={pinned ? `Pinned: ${view.name} reads it on every run, routines included` : `Pin so ${view.name} can read it on every run, routines included`}
                                onClick={() => live.current.onPinDoc(doc.id, managerId, !pinned)}
                              >
                                <TackGlyph size={13} /> {pinned ? "Pinned" : "Pin"}
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : item.kind !== "decision" ? (
                <>
                  <div className="db-swarm-msg-head">
                    <strong className={`db-swarm-name is-${item.author.role === "manager" ? `hue-${item.author.hue}` : item.author.role}`}>{item.author.name}</strong>
                    <span className="db-swarm-role">{roleLabel(item.author, props.roster)}</span>
                    {item.at > 0 && <time>{timeLabel(item.at)}</time>}
                  </div>
                  {item.kind === "say" && <p className="db-swarm-text">{item.text}</p>}
                  {item.kind === "working" && (
                    <WorkingEmbed
                      name={item.author.name}
                      session={props.sessions[item.sessionId]}
                      reported={reported.has(item.sessionId)}
                      stopping={props.stopping.has(item.sessionId)}
                      onStop={() => live.current.onStop(item.sessionId)}
                    />
                  )}
                  {item.kind === "plan" && <PlanEmbed message={item.message} />}
                  {item.kind === "question" && (
                    <QuestionEmbed
                      message={item.message}
                      open={props.sessions[item.message.sessionId]?.state === "waiting_user" && latestQuestion[item.message.sessionId] === item.key}
                      busy={busy}
                      onAnswer={(value) => live.current.onAnswerSession(item.message.sessionId, value)}
                    />
                  )}
                  {item.kind === "report" && (
                    <ReportEmbed
                      message={item.message}
                      managerId={item.author.id}
                      granted={props.grants[item.author.id] ?? []}
                      draftActions={props.sessions[item.message.sessionId]?.draftActions ?? {}}
                      onGrant={(managerId, connector) => live.current.onGrant(managerId, connector)}
                      onOpenSource={(url) => live.current.onOpenSource(url)}
                      onOpenResearch={(runId) => live.current.onOpenResearch(runId)}
                    />
                  )}
                  {item.kind === "round" && (
                    <RoundEmbed
                      message={item.message}
                      round={props.rounds[item.roundId]}
                      sessions={props.sessions}
                      stopping={props.stopping.has(item.roundId)}
                      onStop={() => live.current.onStopRound(item.roundId)}
                      onOpen={(managerId) => live.current.onOpenChannel(managerChannel(managerId))}
                    />
                  )}
                  {item.kind === "roundReply" && (
                    <RoundReplyEmbed
                      message={item.message}
                      onOpen={(managerId) => live.current.onOpenChannel(managerChannel(managerId))}
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
                  onFreeAnswer={(draftId, value) => live.current.onFreeAnswer(draftId, value)}
                  onAnswer={(draftId, label, managerId) => live.current.onAnswer(draftId, label, managerId)}
                />
              )}
            </div>
          </article>
        </Fragment>
      );
    });
  }, [items, props.fresh, props.grants, props.roster, props.sessions, props.stopping, props.rounds, props.openDrafts, props.freeAnswers, props.youName, props.docShelf, view, busy]);

  const placeholder = readOnly
    ? "Read only"
    : view.kind === "manager"
      ? `Message ${view.name}`
      : props.hireHint
        ? "Describe an ongoing job for a new manager, e.g. track my job applications every week"
        : `Message #${view.name}`;
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
          <button
            type="button"
            className={`db-swarm-icon-btn is-labelled db-swarm-roster-toggle${props.rosterOpen ? " is-active" : ""}`}
            onClick={props.onToggleRoster}
            aria-pressed={props.rosterOpen}
            title="Each manager's job, team, connectors and routines"
          >
            <TeamGlyph size={18} /> Team
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
              {rows}
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

      {!readOnly && props.attachments.length > 0 && (
        <div className="db-swarm-attachments" aria-label="Files for this message">
          {props.attachments.map((a) => (
            <span key={a.key} className={`db-swarm-file is-${a.status}`} title={a.error || a.name}>
              <SheetGlyph size={15} />
              <span className="db-swarm-file-name">{a.name}</span>
              {a.status === "reading" && <span className="db-swarm-file-state">Reading</span>}
              {a.status === "failed" && <span className="db-swarm-file-state">{a.error}</span>}
              <button type="button" className="db-swarm-file-remove" aria-label={`Remove ${a.name}`} onClick={() => props.onRemoveAttachment(a.key)}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <form className={`db-swarm-composer${readOnly ? " is-readonly" : ""}${busy ? " is-busy" : ""}`} onSubmit={submit}>
        {!readOnly && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept={DOCUMENT_ACCEPT}
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length) props.onAttach(files);
              }}
            />
            <button
              type="button"
              className="db-swarm-attach"
              disabled={busy || props.attachments.length >= MAX_ATTACHMENTS}
              onClick={() => fileRef.current?.click()}
              aria-label="Attach a PDF, Word or text file"
              title="Attach a PDF, Word or text file. Aura reads it on this computer and sends only the text."
            >
              <Paperclip size={19} aria-hidden="true" />
            </button>
          </>
        )}
        <label htmlFor="swarm-message" className="db-swarm-sr">Message</label>
        <textarea
          id="swarm-message"
          ref={composerRef}
          rows={1}
          value={readOnly ? "" : text}
          maxLength={messageMax}
          disabled={readOnly}
          onChange={(event) => props.onText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
        />
        {!readOnly && text.length > messageMax - 400 && <span className="db-swarm-count">{messageMax - text.length}</span>}
        <button type="submit" className="db-swarm-send" disabled={readOnly || busy || reading || !text.trim() || text.length > messageMax} aria-label="Send">
          <DartGlyph size={19} />
        </button>
      </form>
      <p className="db-swarm-composer-hint">
        {readOnly
          ? "Activity is written by the swarm."
          : view.kind === "manager"
            ? props.attachments.length > 0
              ? "The manager reads these files with your brief. Only their text leaves this computer."
              : "This becomes the manager's brief. It only reads; drafts are never sent."
            : props.attachments.length > 0
              ? "Only the manager this goes to gets the files. Only their text leaves this computer."
              : "Aura routes this to the manager that owns it, and that manager starts on it."}
        <span> Enter to send, Shift+Enter for a new line.</span>
      </p>
    </section>
  );
}
