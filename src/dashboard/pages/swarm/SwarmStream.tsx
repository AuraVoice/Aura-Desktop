import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type FormEvent, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import type { SwarmDecision, SwarmDoc, SwarmManager, SwarmRoster, SwarmRoundView, SwarmSessionView } from "../../../lib/swarmApi";
import { DOCUMENT_ACCEPT } from "../../../lib/documentText";
import { useVirtualizer } from "@tanstack/react-virtual";
import { IMAGE_ACCEPT, MAX_ATTACHMENTS } from "../../../lib/chatAttachments";
import { SwarmAvatar } from "./SwarmAvatar";
import { SwarmOrb } from "./SwarmOrb";
import { BuddyAvatar } from "../../../components/BuddyAvatar";
import { useGeneralSettings } from "../../../state/useGeneralSettings";
import {
  AscentGlyph,
  BuildGlyph,
  BurstGlyph,
  CellGlyph,
  DartGlyph,
  DismissGlyph,
  DropGlyph,
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
import { CONNECTOR_LABEL, QuestionEmbed, ReportEmbed, RoundEmbed, RoundReplyEmbed, WorkingEmbed } from "./SwarmWork";
import { useMentionPicker } from "./SwarmMentionPicker";
import { SwarmMarkdown } from "./SwarmMarkdown";
import { ComposerGrants } from "./SwarmComposerGrants";
import {
  CAPABILITY_LABEL,
  CAPABILITY_PATH,
  DECISION_LABEL,
  dayLabel,
  displayName,
  findManager,
  hueOf,
  managerChannel,
  mentionCandidates,
  mentionsIn,
  roleLabel,
  timeLabel,
  type Author,
  type ChannelId,
  type StreamItem,
} from "./swarmThread";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Text with each "@Name" that names someone on the roster drawn as an indigo chip. Used
 * for sent messages and, through a mirror layer, the composer, so a mention looks the same
 * while it is typed and after it lands. `extra` adds names the server recognised at the
 * time (a manager since removed). A stray "@" in prose stays plain text. */
function withMentions(text: string, roster: SwarmRoster, extra: { id: string; name: string }[] = []): ReactNode {
  if (!text.includes("@")) return text;
  const labels = new Map<string, string>();
  for (const c of mentionCandidates(roster)) {
    labels.set(c.name.toLowerCase(), c.id);
    if (c.id !== "supervisor" && c.title !== "Manager") labels.set(c.title.toLowerCase(), c.id);
  }
  for (const m of extra) if (m.name && !labels.has(m.name.toLowerCase())) labels.set(m.name.toLowerCase(), m.id);
  const names = [...labels.keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (names.length === 0) return text;
  // mentionsIn decides who a send targets; a chip is drawn only for those, so "foo@Sam" or a
  // fifth name never looks addressed when it is not. `extra` is what the server recorded.
  const targeted = new Set([...mentionsIn(text, roster), ...extra.map((m) => m.id)]);
  const pattern = new RegExp(`(?<=^|\\s)@(${names.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (!targeted.has(labels.get(match[1].toLowerCase()) ?? "")) continue;
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(<span key={at} className="db-swarm-mention">{match[0]}</span>);
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

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
    blurb: "Find roles, tailor resumes, track applications.",
    text: "I'm looking for a full-time job: find roles every day, tailor my resume to each one, draft outreach and track every application.",
  },
  {
    Icon: BuildGlyph,
    title: "Ship my side project",
    blurb: "Weekly plan, GitHub issues, release notes.",
    text: "I'm building an app on my own: keep a weekly plan, watch my GitHub issues, draft release notes and remind me what is blocking launch.",
  },
  {
    Icon: StudyGlyph,
    title: "Ace this semester",
    blurb: "Deadlines, study plans, quizzes.",
    text: "I'm a student this semester: track every deadline from Google Classroom, build study plans before exams and quiz me on weak topics.",
  },
];

export interface ComposerDoc {
  key: string;
  name: string;
  status: "reading" | "ready" | "failed";
  docId: string;
  error: string;
  /** A picture, read once in the cloud rather than on this computer. */
  image?: boolean;
  /** An image's thumbnail while it sits in the composer; never kept after send. */
  previewUrl?: string;
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
  /** This channel has nothing to show yet because it is still being fetched. */
  loading: boolean;
  busy: boolean;
  busyHere: boolean;
  busyAuthor: Author;
  /** Managers with a live session right now; only these avatars move. */
  working: ReadonlySet<string>;
  busySince: number;
  /** The message just sent from this channel, until the server's copy arrives. */
  pending: { text: string; docs: { id: string; name: string }[] } | null;
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
  /** Connectors the account has connected that a manager may be granted. */
  grantable: string[];
  /** Per manager, the GitHub repositories it was pointed at (at most three). */
  repoScopes: Record<string, string[]>;
  /** A grant change is in flight; the composer's chips wait for it. */
  grantPending: boolean;
  onToggleGrant: (managerId: string, connector: string, on: boolean) => void;
  onRepoScope: (managerId: string, repos: string[]) => void;
  onOpenSource: (url: string) => void;
  /** A tapped answer to a report's question: sent to that manager as a DM. */
  onReply: (managerId: string, text: string) => void;
  /** A "not a swarm job" named a feature: go to its page. */
  onOpenPath: (path: string) => void;
  /** Resend a declined request as a hire, with the files it came with. */
  onHireInstead: (text: string, docIds: string[]) => void;
  text: string;
  onText: (value: string) => void;
  onSubmit: () => void;
  freeAnswers: Record<string, string>;
  onFreeAnswer: (draftId: string, value: string) => void;
  onAnswer: (draftId: string, label: string, managerId: string) => void;
  rosterOpen: boolean;
  onToggleRoster: () => void;
  /** Managers parked on a question, with how many each is waiting on. */
  waiting: { managerId: string; count: number }[];
  /** A poll or a channel pull failed and the page is retrying on its backoff. */
  reconnecting: boolean;
  composerRef: RefObject<HTMLTextAreaElement | null>;
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

function HiredEmbed({ manager }: { manager: SwarmManager }) {
  const hue = hueOf(manager.id);
  return (
    <div className={`db-swarm-embed is-hired is-hue-${hue}`}>
      <details className="db-swarm-hired-details">
        <summary><BurstGlyph size={16} /><span><strong>{displayName(manager)}</strong><span className="db-swarm-muted">{manager.name ? `${manager.title} · hired` : "Manager hired"}</span></span><span className="db-swarm-details-label">Details</span></summary>
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
      {manager.connectors.length > 0 && (
        <div className="db-swarm-embed-row">
          {manager.connectors.map((c) => <em key={c}>{CONNECTOR_LABEL[c] ?? c}</em>)}
        </div>
      )}
      {manager.routines.length > 0 && (
        <div className="db-swarm-embed-foot"><SparkGlyph size={14} /> {manager.routines.join(" · ")}</div>
      )}
      </details>
      {manager.missingCapabilities.length > 0 && (
        <div className="db-swarm-embed-row">
          {manager.missingCapabilities.map((c) => <em key={c} className="is-warn">needs {c}</em>)}
        </div>
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
          <DartGlyph size={15} />
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
  // Managers keep their own tile; Buddy's face stands in for the orb on
  // Aura's own turn, the same thinking pose the chat overlay shows.
  const { showCompanionAvatar } = useGeneralSettings();
  return (
    <div className="db-swarm-typing" aria-live="polite">
      {author.role === "manager" ? (
        <SwarmAvatar author={author} size="sm" state="working" />
      ) : showCompanionAvatar ? (
        <BuddyAvatar className="db-swarm-typing-buddy" move="thinking" size={32} />
      ) : (
        <SwarmOrb id="swarm" state="planning" tone={author.role === "supervisor" ? "sup" : "accent"} size={28} />
      )}
      <span><strong>{author.name}</strong> is typing</span>
      {seconds >= 4 && <span className="db-swarm-typing-time">{seconds}s</span>}
    </div>
  );
}

/** Three glass rows the real messages replace once the channel has loaded. */
function StreamSkeleton() {
  return (
    <div className="db-swarm-skel-list" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="db-swarm-skel">
          <span className="db-shimmer db-swarm-skel-av" />
          <span className="db-swarm-skel-lines">
            <span className="db-shimmer db-skel-line is-head" />
            <span className="db-shimmer db-skel-line is-body" />
          </span>
        </div>
      ))}
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
      <p>Tell Aura about something ongoing and it hires a manager to own it.</p>
      <div className="db-swarm-starters">
        {STARTERS.map(({ Icon, title, blurb, text }, i) => (
          <button key={title} type="button" className="db-swarm-starter" style={{ animationDelay: `${120 + i * 70}ms` }} onClick={() => onStarter(text)}>
            <Icon size={22} />
            <strong>{title}</strong>
            <span>{blurb}</span>
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
  onOpenPath,
  onHireInstead,
}: {
  item: Extract<StreamItem, { kind: "decision" }>;
} & Pick<Props, "roster" | "openDrafts" | "busy" | "freeAnswers" | "onFreeAnswer" | "onAnswer" | "onOpenPath" | "onHireInstead">) {
  const d = item.decision;
  const capability = CAPABILITY_LABEL[d.capability];
  const hired = d.decision === "new_manager" && d.applied ? findManager(roster, d.targetManagerId) : undefined;
  const asking = d.decision === "ask" && openDrafts.has(d.draftId);
  const declined = d.decision === "not_swarm";
  const feature = declined ? CAPABILITY_PATH[d.capability] : undefined;
  // The classifier's first alternative is the ongoing version of what was declined.
  const ongoing = declined && item.asked.text ? d.alternatives[0] : undefined;
  const unusedDocs = declined ? item.asked.docs : [];
  return (
    <>
      <div className="db-swarm-msg-head">
        <strong className={`db-swarm-name is-${item.author.role === "manager" ? `hue-${item.author.hue}` : item.author.role}`}>{item.author.name}</strong>
        {item.author.name !== roleLabel(item.author, roster) && <span className={`db-swarm-role is-${item.author.role}`}>{roleLabel(item.author, roster)}</span>}
        {/* A manager speaking for itself needs no badge, the way a Slack reply has none. Only
            an ask and a decline keep one, since those change what the user does next. */}
        {(d.decision === "ask" || d.decision === "not_swarm") && <span className={`db-swarm-tag is-${d.decision}`}>{DECISION_LABEL[d.decision]}</span>}
        {capability && <span className="db-swarm-cap">{capability}</span>}
        {item.at > 0 && <time>{timeLabel(item.at)}</time>}
      </div>
      {d.reason && <p className="db-swarm-text">{d.reason}</p>}
      {d.note && <p className="db-swarm-note">{d.note}</p>}
      {hired && <HiredEmbed manager={hired} />}
      {(feature || ongoing) && (
        <div className="db-swarm-choice-row">
          {feature && (
            <button type="button" className="db-swarm-choice" onClick={() => onOpenPath(feature.path)}>
              {feature.label}
            </button>
          )}
          {ongoing && (
            <button
              type="button"
              className="db-swarm-choice"
              disabled={busy}
              onClick={() =>
                onHireInstead(
                  `Hire a manager for this, as ongoing work: ${ongoing.why}\n\nMy original request: ${item.asked.text}`,
                  item.asked.docs.map((doc) => doc.id),
                )
              }
            >
              Hire that instead
            </button>
          )}
        </div>
      )}
      {unusedDocs.length > 0 && (
        <p className="db-swarm-muted db-swarm-alt">
          {unusedDocs.length === 1 ? "Your attached file was not used." : `Your ${unusedDocs.length} attached files were not used.`}
          {ongoing ? " Hire that instead sends them again." : ""}
        </p>
      )}
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
  const channelKey = view.kind === "manager" ? `m-${view.manager?.id}` : view.kind;
  const scrollPositions = useRef<Record<string, { top: number; following: boolean }>>({});
  const previousChannel = useRef("");
  const following = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const readOnly = view.kind === "activity";
  // Who answers what you send: the manager in its DM, the point of contact in #group.
  const messageMax = view.kind === "manager" ? BRIEF_MAX : GROUP_MESSAGE_MAX;
  // Handlers are read at click time, so the list below need not rebuild when only the
  // composer's text (or a fresh inline arrow from the page) changed.
  const live = useRef(props);
  useLayoutEffect(() => {
    live.current = props;
  });
  // One function for every link in the thread. An inline arrow per row was a new prop on
  // each rebuild, which defeated SwarmMarkdown's memo and re-parsed the whole channel.
  const openSource = useCallback((url: string) => live.current.onOpenSource(url), []);

  // Follow live content only at the bottom; each channel keeps its reading position.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (previousChannel.current !== channelKey) {
      const saved = scrollPositions.current[channelKey];
      following.current = saved?.following ?? true;
      el.scrollTop = following.current ? el.scrollHeight : saved?.top ?? 0;
      previousChannel.current = channelKey;
    } else if (following.current) {
      el.scrollTop = el.scrollHeight;
    }
    setShowJump(!following.current);
  }, [items.length, busyHere, channelKey]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const pane = el?.firstElementChild;
    if (!el || !pane) return;
    const observer = new ResizeObserver(() => {
      if (following.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(pane);
    observer.observe(el);
    return () => observer.disconnect();
  }, [channelKey]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    following.current = el.scrollHeight - el.clientHeight - el.scrollTop < 64;
    scrollPositions.current[channelKey] = { top: el.scrollTop, following: following.current };
    setShowJump(!following.current);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    following.current = true;
    el.scrollTop = el.scrollHeight;
    scrollPositions.current[channelKey] = { top: el.scrollTop, following: true };
    setShowJump(false);
  };

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
    if (!busy && !reading && text.trim() && !readOnly && text.length <= messageMax) {
      jumpToLatest();
      props.onSubmit();
    }
  };

  const canAttach = !readOnly && !busy && props.attachments.length < MAX_ATTACHMENTS;
  const hasImage = props.attachments.some((a) => a.image);

  // A copied screenshot or a file copied in Explorer arrives as clipboard files. Copying
  // from Word puts a picture of the text next to the text itself, so text wins when both.
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (!files.length || event.clipboardData.getData("text/plain").trim()) return;
    event.preventDefault();
    // Past the cap still goes through: the page says "Max 5" rather than ignoring the paste.
    if (!readOnly && !busy) props.onAttach(files);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>) => {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    // Past the cap still goes through: the page says "Max 5" rather than ignoring the paste.
    if (!readOnly && !busy) props.onAttach(files);
  };

  const mention = useMentionPicker(props.roster, text, props.onText, composerRef);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // While the @ list is open, Enter picks a name; it must never send the message.
    if (mention.onKeyDown(event)) return;
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
    // A report's question can be answered with a tap only while nothing came after it.
    const lastKey = items.length > 0 ? items[items.length - 1].key : "";
    let lastDay = "";
    let lastAuthorKey = "";
    let lastAt = 0;
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
              <span className="db-swarm-sys-text">{item.text}</span>
            </div>
          </Fragment>
        );
      }
      if (item.kind === "queued") {
        lastAuthorKey = "";
        return (
          <Fragment key={item.key}>
            {daySep && <div className="db-swarm-daysep"><span>{daySep}</span></div>}
            <div className={`db-swarm-sys is-queued${fresh ? " is-fresh" : ""}`}>
              <span className="db-swarm-sys-text">
                {view.kind === "manager"
                  ? <><b>{item.picked ? "Picked up" : "Waiting"}</b>{item.picked ? ": " : " for the current task to finish: "}{item.text}</>
                  : item.text}
              </span>
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
              <span className="db-swarm-sys-text">
                <b>Routed</b> from #{props.roster.supervisor?.status === "active" ? "group" : "front-door"}: {item.text}
              </span>
            </div>
          </Fragment>
        );
      }
      const author = item.kind === "user" ? YOU : item.author;
      const authorKey = `${author.role}:${author.id}`;
      const continued = item.kind !== "decision" && authorKey === lastAuthorKey && !daySep && item.at > 0 && lastAt > 0 && item.at - lastAt < 300_000;
      lastAuthorKey = authorKey;
      lastAt = item.at;
      return (
        <Fragment key={item.key}>
          {daySep && <div className="db-swarm-daysep"><span>{daySep}</span></div>}
          <article className={`db-swarm-msg${item.kind === "user" ? " is-you" : ""}${continued ? " is-continued" : ""}${fresh ? " is-fresh" : ""}`}>
            <div className="db-swarm-msg-gutter">
              {item.kind === "user"
                ? !continued && <SwarmAvatar author={author} size="sm" />
                : !continued ? <SwarmAvatar author={author} /> : item.at > 0 && <time className="db-swarm-continued-time">{timeLabel(item.at)}</time>}
            </div>
            <div className="db-swarm-msg-body">
              {item.kind === "user" ? (
                <>
                  <span className="db-swarm-sr">{props.youName || "You"}: </span>
                  <p className="db-swarm-text db-swarm-bubble">{withMentions(item.text, props.roster, item.mentions)}</p>
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
                  {item.at > 0 && <time className="db-swarm-you-time">{timeLabel(item.at)}</time>}
                </>
              ) : item.kind !== "decision" ? (
                <>
                  {!continued && <div className="db-swarm-msg-head">
                    <strong className={`db-swarm-name is-${item.author.role === "manager" ? `hue-${item.author.hue}` : item.author.role}`}>{item.author.name}</strong>
                    {item.author.name !== roleLabel(item.author, props.roster) && <span className={`db-swarm-role is-${item.author.role}`}>{roleLabel(item.author, props.roster)}</span>}
                    {item.at > 0 && <time>{timeLabel(item.at)}</time>}
                  </div>}
                  {item.kind === "say" && <SwarmMarkdown className="db-swarm-text" text={item.text} onOpenLink={openSource} />}
                  {item.kind === "working" && (
                    <WorkingEmbed
                      at={item.at}
                      managerId={item.author.id}
                      manager={findManager(props.roster, item.author.id)}
                      plan={item.plan}
                      steps={item.steps}
                      reportAt={item.reportAt}
                      granted={props.grants[item.author.id] ?? []}
                      onGrant={(managerId, connector) => live.current.onGrant(managerId, connector)}
                      session={props.sessions[item.sessionId]}
                      reported={reported.has(item.sessionId)}
                      stopping={props.stopping.has(item.sessionId)}
                      onStop={() => live.current.onStop(item.sessionId)}
                    />
                  )}
                  {item.kind === "question" && (
                    <QuestionEmbed
                      message={item.message}
                      open={props.sessions[item.message.sessionId]?.state === "waiting_user" && latestQuestion[item.message.sessionId] === item.key}
                    />
                  )}
                  {item.kind === "report" && (
                    <ReportEmbed
                      message={item.message}
                      managerId={item.author.id}
                      granted={props.grants[item.author.id] ?? []}
                      draftActions={props.sessions[item.message.sessionId]?.draftActions ?? {}}
                      onGrant={(managerId, connector) => live.current.onGrant(managerId, connector)}
                      onOpenSource={openSource}
                      answerable={item.key === lastKey}
                      onReply={(value) => live.current.onReply(item.author.id, value)}
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
                  onOpenPath={(path) => live.current.onOpenPath(path)}
                  onHireInstead={(text, docIds) => live.current.onHireInstead(text, docIds)}
                />
              )}
            </div>
          </article>
        </Fragment>
      );
    });
  }, [items, props.fresh, props.grants, props.roster, props.sessions, props.stopping, props.rounds, props.openDrafts, props.freeAnswers, props.youName, props.docShelf, view, busy, openSource]);

  const placeholder = readOnly
    ? "Read only"
    : view.kind === "manager"
      ? `Message ${view.name}`
      : `Message #${view.name}`;
  const showSkeleton = props.loading && items.length === 0 && !busyHere;
  const needsYou = props.waiting.reduce((sum, w) => sum + (w.count > 0 ? 1 : 0), 0);
  const showHero = view.kind === "group" && items.length === 0 && !busyHere && !showSkeleton;

  // Only the rows near the viewport are mounted, so a channel that has run for months
  // costs what one screen does: rows off screen never parse their markdown or keep their
  // timers. The intro rides as the first row so the list starts at the pane's top.
  // Heights start as estimates and measureElement corrects each after paint; sizes are
  // cached by message key, so switching channels and back keeps them.
  const listRef = useRef<HTMLDivElement | null>(null);
  const [listTop, setListTop] = useState(0);
  const hasIntro = view.kind === "activity" || (view.kind === "manager" && Boolean(view.author));
  const lead = hasIntro ? 1 : 0;
  const virtualizer = useVirtualizer({
    count: showSkeleton || showHero ? 0 : items.length + lead,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (index < lead ? 150 : 96),
    overscan: 8,
    getItemKey: (index) => (index < lead ? `intro-${channelKey}` : items[index - lead]?.key ?? index),
    // Where the list starts inside the scroller: the pane's top padding, plus any space
    // above it while a short thread is pushed to the bottom.
    scrollMargin: listTop,
  });
  const totalSize = virtualizer.getTotalSize();
  useLayoutEffect(() => {
    const list = listRef.current;
    const el = scrollRef.current;
    if (!list || !el) return;
    const top = list.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    setListTop((prev) => (Math.abs(prev - top) < 1 ? prev : top));
  }, [channelKey, totalSize, showSkeleton, showHero]);

  return (
    <section className="db-swarm-stream" aria-label={view.kind === "manager" ? `Direct messages with ${view.name}` : `#${view.name}`}>
      <header className="db-swarm-stream-head">
        {view.kind === "manager" && view.author ? (
          <SwarmAvatar
            author={view.author}
            size="sm"
            state={view.manager?.status === "paused" ? "paused" : props.working.has(view.author.id) ? "working" : "idle"}
          />
        ) : (
          <span className="db-swarm-head-hash">{view.kind === "activity" ? <PulseGlyph size={20} /> : <LatticeGlyph size={20} />}</span>
        )}
        <h2>{view.name}</h2>
        {view.topic && <span className="db-swarm-topic">{view.topic}</span>}
        <div className="db-swarm-head-actions">
          {props.reconnecting && <span className="db-swarm-reconnect" role="status">Reconnecting</span>}
          {(props.working.size > 0 || needsYou > 0) && (
            <button
              type="button"
              className={`db-swarm-status-pill${needsYou > 0 ? " is-warn" : ""}`}
              onClick={() => {
                const first = props.waiting.find((w) => w.count > 0)?.managerId ?? [...props.working][0];
                if (first) props.onOpenChannel(managerChannel(first));
              }}
              title={needsYou > 0 ? "Open the first manager waiting on you" : "Open a manager that is working"}
            >
              {props.working.size > 0 && (
                <span className="db-swarm-status-part">
                  <span className="db-swarm-run-dot" aria-hidden="true" />
                  {props.working.size} working
                </span>
              )}
              {needsYou > 0 && (
                <span className="db-swarm-status-part is-warn">
                  <SignalGlyph size={13} />
                  {needsYou} need{needsYou === 1 ? "s" : ""} you
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            className={`db-swarm-head-btn${props.rosterOpen ? " is-on" : ""}`}
            aria-pressed={props.rosterOpen}
            onClick={props.onToggleRoster}
            title="Your team: what each manager can read, its routines, watches and memory"
          >
            <TeamGlyph size={16} /> Team
          </button>
        </div>
      </header>

      {props.banner}
      <div className="db-swarm-history">
      <div className={`db-swarm-scroll${showHero ? " is-hero" : ""}`} ref={scrollRef} onScroll={onScroll}>
        <div key={channelKey} className="db-swarm-channel-pane">
          {showSkeleton ? (
            <StreamSkeleton />
          ) : showHero ? (
            <GroupHero onStarter={(starter) => { props.onText(starter); composerRef.current?.focus(); }} />
          ) : (
            <>
              <div ref={listRef} className="db-swarm-vlist" style={{ height: totalSize }}>
                {virtualizer.getVirtualItems().map((row) => (
                  <div
                    key={row.key}
                    ref={virtualizer.measureElement}
                    data-index={row.index}
                    className="db-swarm-vrow"
                    style={{ transform: `translateY(${row.start - virtualizer.options.scrollMargin}px)` }}
                  >
                    {row.index < lead ? <ChannelIntro view={view} /> : rows[row.index - lead]}
                  </div>
                ))}
              </div>
              {readOnly && items.length === 0 && <p className="db-swarm-empty-line">Nothing has happened yet.</p>}
            </>
          )}
          {props.pending && (
            <article className="db-swarm-msg is-you is-pending" aria-live="polite">
              <div className="db-swarm-msg-gutter"><SwarmAvatar author={YOU} size="sm" /></div>
              <div className="db-swarm-msg-body">
                <span className="db-swarm-sr">{props.youName || "You"}: </span>
                <p className="db-swarm-text db-swarm-bubble">{withMentions(props.pending.text, props.roster)}</p>
                {props.pending.docs.length > 0 && (
                  <div className="db-swarm-files">
                    {props.pending.docs.map((doc) => <span key={doc.id} className="db-swarm-file"><SheetGlyph size={15} /><span className="db-swarm-file-name">{doc.name}</span></span>)}
                  </div>
                )}
                <span className="db-swarm-you-time">Sending</span>
              </div>
            </article>
          )}
          {busyHere && <Typing author={props.busyAuthor} since={props.busySince} />}
        </div>
      </div>
      {showJump && <button type="button" className="db-swarm-jump" onClick={jumpToLatest} aria-label="Jump to latest" title="Jump to latest"><DropGlyph size={18} /></button>}
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

      <div className={`db-swarm-compose-box${readOnly ? " is-readonly" : ""}${busy ? " is-busy" : ""}`}>
      {!readOnly && mention.popover}
      {!readOnly && (
        <ComposerGrants
          view={view}
          roster={props.roster}
          grants={props.grants}
          grantable={props.grantable}
          repoScopes={props.repoScopes}
          pending={props.grantPending}
          onToggleGrant={props.onToggleGrant}
          onRepoScope={props.onRepoScope}
        />
      )}
      {!readOnly && props.attachments.length > 0 && (
        <div className="db-swarm-attachments" aria-label="Files for this message">
          {props.attachments.map((a) => (
            <span key={a.key} className={`db-swarm-file is-${a.status}`} title={a.error || a.name}>
              {a.previewUrl ? <img className="db-swarm-file-thumb" src={a.previewUrl} alt="" /> : <SheetGlyph size={15} />}
              <span className="db-swarm-file-name">{a.name}</span>
              {a.status === "reading" && <span className="db-swarm-file-state">Reading</span>}
              {a.status === "failed" && <span className="db-swarm-file-state">{a.error}</span>}
              <button type="button" className="db-swarm-file-remove" aria-label={`Remove ${a.name}`} onClick={() => props.onRemoveAttachment(a.key)}>
                <DismissGlyph size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <form
        className={`db-swarm-composer${readOnly ? " is-readonly" : ""}${busy ? " is-busy" : ""}`}
        onSubmit={submit}
        onDragOver={(event) => { if (!readOnly && event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDrop={onDrop}
      >
        {!readOnly && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept={`${DOCUMENT_ACCEPT},${IMAGE_ACCEPT}`}
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
              disabled={!canAttach}
              onClick={() => fileRef.current?.click()}
              aria-label="Attach a file or image"
              title="Attach a PDF, Word, text file or image, or paste a screenshot. Files are read on this computer; images are read once in the cloud and not kept."
            >
              <SheetGlyph size={19} />
            </button>
          </>
        )}
        <label htmlFor="swarm-message" className="db-swarm-sr">Message</label>
        <span className="db-swarm-composer-field">
          {/* A textarea cannot colour its own words, so a mirror with the same metrics sits
            * under it and draws the text with mention chips; the textarea's text is
            * transparent and only its caret shows. */}
          {!readOnly && (
            <div className="db-swarm-composer-mirror" ref={mirrorRef} aria-hidden="true">
              {withMentions(text, props.roster)}{"\n"}
            </div>
          )}
          <textarea
            id="swarm-message"
            ref={composerRef}
            rows={1}
            value={readOnly ? "" : text}
            maxLength={messageMax}
            disabled={readOnly}
            onChange={(event) => {
              props.onText(event.target.value);
              mention.refresh(event.target.value, event.target.selectionStart);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={(event) => mention.refresh(event.currentTarget.value, event.currentTarget.selectionStart)}
            onClick={(event) => mention.refresh(event.currentTarget.value, event.currentTarget.selectionStart)}
            onScroll={(event) => { if (mirrorRef.current) mirrorRef.current.scrollTop = event.currentTarget.scrollTop; }}
            onPaste={onPaste}
            placeholder={placeholder}
            aria-autocomplete="list"
            aria-expanded={mention.open}
            aria-controls={mention.open ? "swarm-mentions" : undefined}
            aria-activedescendant={mention.activeId}
          />
        </span>
        {!readOnly && text.length > messageMax - 400 && <span className="db-swarm-count">{messageMax - text.length}</span>}
        <button type="submit" className="db-swarm-send" disabled={readOnly || busy || reading || !text.trim() || text.length > messageMax} aria-label="Send">
          <DartGlyph size={18} />
        </button>
      </form>
      </div>
      {(readOnly || hasImage || props.attachments.length > 0) && (
        <p className="db-swarm-composer-hint">
          {readOnly
            ? "Activity is written by the swarm."
            : hasImage
              ? "Images are read once in the cloud and not kept. Only text reaches managers."
              : "Only the files' text leaves this computer."}
        </p>
      )}
    </section>
  );
}
