import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClipboardEvent, CSSProperties } from "react";
import { currentMonitor } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
  Bell,
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  Copy,
  Eye,
  EyeOff,
  Globe,
  History,
  Lightbulb,
  Mail,
  Plus,
  Radar,
  Send,
  UserRound,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { BarIconButton } from "./BarIconButton";
import { GlassSurface } from "./GlassSurface";
import { logError } from "../lib/log";
import type { ChatScreenState } from "./useChatScreenCapture";
import "./ChatSlot.css";

/** The states the transcript has to render across user and assistant turns.
 * The union is shared rather than split by role.
 *
 * `queued` and `sending` are deliberately NOT synonyms. `queued` means the
 * backend has accepted the turn and put it behind others, which only the live
 * lane can ever know (its accept ack carries a real queue_position). `sending`
 * means the request is in flight and nobody is waiting on anyone. The cold lane
 * used to reuse `queued` for that, which told the user their message was waiting
 * in a queue that does not exist. */
export type ChatMessageState = "sent" | "queued" | "sending" | "failed" | "streaming" | "complete";
export type ChatLane = "cold" | "live";

export interface ChatReminder {
  message: string;
  triggerAt: string | null;
  animate: boolean;
  displayMode: "standalone" | "supplemental";
  receiptStatus: "created" | "updated";
}

export interface ChatMessage {
  id: string;
  turnId?: string;
  role: "user" | "assistant" | "system";
  text: string;
  state: ChatMessageState;
  lane?: ChatLane;
  queuePosition?: number;
  kind?: "text" | "status" | "clarification" | "limit" | "error" | "degraded" | "divider" | "reminder"
    | "activity" | "thinking";
  clarificationId?: string;
  options?: string[];
  multiSelect?: boolean;
  selectedOptions?: string[];
  /** Set on `activity` rows: the tool's own id, its label, the one argument it
   * was allowed to show, and whether it has finished. `running` drives the
   * spinner, so a row that never gets its tool_end would spin forever - every
   * terminal path in useChatSession settles these. */
  tool?: string;
  detail?: string;
  running?: boolean;
  ok?: boolean;
  reminder?: ChatReminder;
}

/** Where each row sits WITHIN its own turn. Lower renders first.
 *
 * Arrival order cannot be used directly: the assistant bubble is created up
 * front as an empty placeholder, so every activity and thinking row that follows
 * would render underneath the answer they produced. Reading "Searching the web"
 * after the answer it fed is backwards, and it was the single worst thing about
 * the v1 status pill. */
const TURN_RANK: Record<string, number> = {
  user: 0,
  thinking: 1,
  activity: 2,
  assistant: 3,
};

function rankOf(message: ChatMessage): number {
  if (message.role === "user") return TURN_RANK.user;
  if (message.kind === "thinking") return TURN_RANK.thinking;
  if (message.kind === "activity") return TURN_RANK.activity;
  return TURN_RANK.assistant;
}

/** Reorders rows within each turn while leaving the turns themselves in
 * chronological order. Rows with no turnId (the voice divider) are their own
 * group, so they keep their place in the transcript rather than being pulled
 * into a neighbouring turn. */
export function displayOrder(messages: ChatMessage[]): ChatMessage[] {
  const groups: string[] = [];
  const byGroup = new Map<string, ChatMessage[]>();
  messages.forEach((message, index) => {
    // A turnId is always a UUID or matches ^[A-Za-z0-9_-]+$ (the backend's own id
    // charset), so a colon here can never collide with a real one.
    const key = message.turnId ?? `loose:${index}`;
    const existing = byGroup.get(key);
    if (existing) {
      existing.push(message);
      return;
    }
    groups.push(key);
    byGroup.set(key, [message]);
  });
  return groups.flatMap((key) => {
    const rows = byGroup.get(key) ?? [];
    if (rows.length < 2) return rows;
    // Index tiebreak keeps this a STABLE sort, so several activity rows stay in
    // the order the model actually called those tools.
    return rows
      .map((message, index) => ({ message, index, rank: rankOf(message) }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.message);
  });
}

/** Turns that are already showing progress somewhere other than the assistant
 * bubble. The bubble's own "Aura is thinking" placeholder is the fallback signal
 * for a turn with no reasoning and no tools, so it stands down while the
 * reasoning row or a running tool row is speaking for the same turn - otherwise
 * both render at once and the turn claims to be thinking twice.
 *
 * Reasoning and activity rows are keyed on `streaming`/`running`: once settled,
 * the placeholder may need to return while the answer is still empty. A status
 * row is transient and removed when the turn finishes, so its presence always
 * signals current progress. */
function turnsSignallingProgress(messages: ChatMessage[]): Set<string> {
  const turnIds = new Set<string>();
  for (const message of messages) {
    if (!message.turnId) continue;
    if (message.kind === "thinking" && message.state === "streaming") turnIds.add(message.turnId);
    if (message.kind === "activity" && message.running) turnIds.add(message.turnId);
    if (message.kind === "status") turnIds.add(message.turnId);
  }
  return turnIds;
}

/** Icon per tool for the activity rail. A tool with no entry falls back to the
 * generic one rather than rendering nothing, so an added tool degrades to a
 * plain row instead of a hole in the list. */
const TOOL_ICONS: Record<string, LucideIcon> = {
  create_calendar_event: CalendarDays,
  get_upcoming_events: CalendarDays,
  get_user_context: UserRound,
  list_emails: Mail,
  list_reminders: Bell,
  list_trackers: Radar,
  query_memory: Brain,
  read_email: Mail,
  reason_step: Lightbulb,
  set_reminder: Bell,
  web_surf: Globe,
};

/** One tool the model ran, shown while it runs and kept afterwards.
 *
 * Kept rather than cleared because "it searched the web to answer this" stays
 * true once the answer lands; the v1 status pill deleted itself at the end of
 * the turn, so the transcript ended up claiming less than actually happened. */
function ActivityRow({ message }: { message: ChatMessage }) {
  const Icon = TOOL_ICONS[message.tool ?? ""] ?? Wrench;
  const failed = message.running !== true && message.ok === false;
  return (
    <div className={`chat-activity${message.running ? " is-running" : ""}${failed ? " is-failed" : ""}`}>
      <Icon className="chat-activity-icon" size={12} aria-hidden="true" />
      <span className="chat-activity-label">{message.text}</span>
      {message.detail && <span className="chat-activity-detail">{message.detail}</span>}
      {message.running && <span className="chat-activity-spinner" aria-hidden="true" />}
      {failed && <span className="chat-activity-failed">failed</span>}
    </div>
  );
}

/** Claude's summarized reasoning for this turn, collapsible.
 *
 * Expanded while it streams so the wait is not dead time, then collapsed once
 * the answer starts, because the reasoning is supporting material and the answer
 * is the point. A manual toggle wins over that: once the user has expressed a
 * preference on this row, the automatic collapse must not override it. */
function ReasoningRow({ message }: { message: ChatMessage }) {
  const streaming = message.state === "streaming";
  const [open, setOpen] = useState(true);
  const touched = useRef(false);

  useEffect(() => {
    if (streaming || touched.current) return;
    setOpen(false);
  }, [streaming]);

  return (
    <div className={`chat-reasoning${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="chat-reasoning-toggle"
        aria-expanded={open}
        onClick={() => {
          touched.current = true;
          setOpen((current) => !current);
        }}
      >
        <ChevronRight className="chat-reasoning-chevron" size={12} aria-hidden="true" />
        {streaming ? "Thinking" : "Thought about this"}
      </button>
      {open && <div className="chat-reasoning-body">{message.text}</div>}
    </div>
  );
}

/** One row in the history panel. Structurally a subset of
 * desktopChatApi's DesktopChatSession, declared locally so this component stays
 * decoupled from the API client. */
export interface ChatSessionSummary {
  conversationId: string;
  lastActivityAt: string | null;
  lastMessagePreview: string;
  messageCount: number;
}

export interface ChatHistoryView {
  sessions: ChatSessionSummary[];
  loading: boolean;
  /** Set when the session list itself failed, so an error never renders as "no
   * conversations yet". */
  error: string | null;
  hasMore: boolean;
  /** A turn is in flight, so switching conversations is refused. */
  locked: boolean;
  /** A switch is in flight. The transcript still shows the OLD conversation
   * until it lands, which is why the composer is held closed meanwhile. */
  opening: boolean;
  openError: string | null;
  refresh: () => void;
  loadMore: () => void;
  /** Returns whether the switch was accepted. */
  select: (conversationId: string) => boolean;
}

interface ChatSlotProps {
  messages: ChatMessage[];
  onNewConversation: () => boolean;
  onClose: () => void;
  historyOpen: boolean;
  onHistoryOpenChange: (open: boolean) => void;
  history: ChatHistoryView;
  hasOlderMessages: boolean;
  onLoadOlder: () => void;
  onSend: (message: string) => boolean;
  onRetry: (messageId: string) => void;
  onClarification: (messageId: string, selectedOptions: string[]) => void;
  sending: boolean;
  limitReached: boolean;
  lane: ChatLane;
  /** Bumped every time the chat hotkey fires, including while the slot is
   * already open, so the composer takes the caret back. */
  focusNonce: number;
  screen: ChatScreenState;
  /** Reports the card's measured height so OverlayRoot can size the window to
   * the transcript instead of reserving a fixed block of empty glass. */
  onHeightChange?: (height: number) => void;
}

// How close to the bottom still counts as "following along". Anything further
// up means the user scrolled back on purpose and new content must not yank
// them away from what they were reading.
const AUTOSCROLL_STICK_PX = 24;
const HISTORY_SHEET_SCREEN_RATIO = 0.4;
const COMPOSER_MIN_HEIGHT = 36;
const COMPOSER_MAX_HEIGHT = COMPOSER_MIN_HEIGHT * 2;
const COMPOSER_GROW_THRESHOLD = 80;

function fallbackHistorySheetHeight(): number {
  const availableHeight = window.screen.availHeight || window.innerHeight || 720;
  return Math.round(availableHeight * HISTORY_SHEET_SCREEN_RATIO);
}

/** The composer caps typed and pasted input here, but useChatSession enforces
 * it again on the way out: a clarification reply is built from server-supplied
 * option text, which never passes through the textarea. */
export const MAX_MESSAGE_LENGTH: Record<ChatLane, number> = {
  cold: 8_000,
  live: 2_000,
};
const COUNTER_THRESHOLD: Record<ChatLane, number> = {
  cold: 7_200,
  live: 1_800,
};

/** Header (44) + the transcript's 260px floor + the body's own 8px padding +
 * composer (48): what an empty chat
 * renders at, used for the frame before the first measurement lands. The card's
 * height is otherwise never computed here - CSS sizes it to its content and the
 * measured result is what gets reported. Predicting it from row constants and
 * then stretching the card to the window is what put empty glass under the
 * composer for three rounds: two owners, no way to tell which one was wrong. */
export const INITIAL_CHAT_SLOT_HEIGHT = 360;

/** During a call the worker attaches screen frames to spoken turns only, so a
 * chip here would promise something the live lane cannot deliver. */
function screenChipVisible(lane: ChatLane, screen: ChatScreenState): boolean {
  return lane !== "live" && screen.armed && screen.previewUrl !== null;
}

/** Only model prose goes through the markdown renderer. Every other kind is one
 * of our own short strings (a status line, a divider label, an error), where
 * markdown would only add block spacing and could mangle stray punctuation. */
function rendersMarkdown(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  return message.kind === undefined || message.kind === "text";
}

function copySelectionAsPlainText(event: ClipboardEvent<HTMLDivElement>) {
  const text = window.getSelection()?.toString();
  if (!text) return;
  event.preventDefault();
  event.clipboardData.setData("text/plain", text);
}

function localCalendarDay(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function reminderTimeLabel(triggerAt: string | null): string | null {
  if (!triggerAt) return null;
  const trigger = new Date(triggerAt);
  if (Number.isNaN(trigger.getTime())) return null;

  const today = new Date();
  const dayDifference = Math.round(
    (localCalendarDay(trigger) - localCalendarDay(today)) / 86_400_000,
  );
  const day = dayDifference === 0
    ? "Today"
    : dayDifference === 1
      ? "Tomorrow"
      : trigger.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: trigger.getFullYear() === today.getFullYear() ? undefined : "numeric",
        });
  const time = trigger.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${day} · ${time}`;
}

function ReminderCard({ reminder }: { reminder: ChatReminder }) {
  const timeLabel = reminderTimeLabel(reminder.triggerAt);
  const [swinging, setSwinging] = useState(reminder.animate);
  return (
    <div className="chat-reminder-card">
      <Bell
        className={`chat-reminder-icon${swinging ? " is-swinging" : ""}`}
        size={28}
        strokeWidth={1.8}
        aria-hidden="true"
        onAnimationEnd={() => setSwinging(false)}
      />
      <div className="chat-reminder-content">
        <span className="chat-reminder-label">
          {reminder.receiptStatus === "updated" ? "Reminder updated" : "Reminder set"}
        </span>
        <span className="chat-reminder-message">{reminder.message}</span>
        {timeLabel && (
          <time className="chat-reminder-time" dateTime={reminder.triggerAt ?? undefined}>
            {timeLabel}
          </time>
        )}
      </div>
    </div>
  );
}

const COPIED_FLASH_MS = 1_500;

/** Copy affordance for one fenced block.
 *
 * A real `<button>`, not a div: `data-tauri-drag-region="deep"` on the overlay
 * surface makes everything draggable and Tauri only auto-excludes real
 * inputs/buttons/links, so a div would swallow the click as a window drag.
 *
 * Uses the Tauri clipboard plugin rather than `navigator.clipboard`, which the
 * dashboard's CopyButton can rely on only because that is a normal focused
 * window. The overlay deliberately does not take focus, and the web API wants a
 * focused document. */
function CodeCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const Icon = copied ? Check : Copy;

  return (
    <button
      type="button"
      className={`chat-code-copy${copied ? " is-copied" : ""}`}
      title={copied ? "Copied" : "Copy code"}
      aria-label={copied ? "Copied" : "Copy code"}
      onClick={() => {
        writeText(text)
          .then(() => {
            setCopied(true);
            if (timerRef.current) clearTimeout(timerRef.current);
            timerRef.current = setTimeout(() => {
              timerRef.current = null;
              setCopied(false);
            }, COPIED_FLASH_MS);
          })
          .catch((err) => logError("ChatSlot: copy code block", err));
      }}
    >
      <Icon size={12} aria-hidden="true" />
    </button>
  );
}

/** The block's source text, read off the hast node react-markdown hands the
 * component. Taken from the tree rather than from `children`, which by that
 * point is React elements whose text is not addressable. */
function hastText(node: unknown): string {
  if (typeof node !== "object" || node === null) return "";
  const candidate = node as { value?: unknown; children?: unknown };
  if (typeof candidate.value === "string") return candidate.value;
  if (!Array.isArray(candidate.children)) return "";
  return candidate.children.map(hastText).join("");
}

/** Module scope so the object identity is stable: a new object here would make
 * Markdown rebuild its renderer on every streamed delta. */
const MARKDOWN_COMPONENTS: Components = {
  pre({ node, children }) {
    const source = hastText(node);
    return (
      <div className="chat-code-block">
        <pre>{children}</pre>
        {source && <CodeCopyButton text={source} />}
      </div>
    );
  },
};

function ClarificationChoices({
  message,
  disabled,
  onSubmit,
}: {
  message: ChatMessage;
  disabled: boolean;
  onSubmit: (selectedOptions: string[]) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    new Set(message.selectedOptions ?? []),
  );
  const answered = message.selectedOptions !== undefined;

  function choose(option: string) {
    if (answered || disabled) return;
    if (!message.multiSelect) {
      setSelected(new Set([option]));
      onSubmit([option]);
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(option)) next.delete(option);
      else next.add(option);
      return next;
    });
  }

  return (
    <div className="chat-clarification-options">
      {message.options?.map((option) => (
        <button
          type="button"
          key={option}
          className={`chat-clarification-option${selected.has(option) ? " selected" : ""}`}
          disabled={answered || disabled}
          onClick={() => choose(option)}
        >
          {option}
        </button>
      ))}
      {message.multiSelect && !answered && !disabled && selected.size > 0 && (
        <button
          type="button"
          className="chat-clarification-done"
          onClick={() => onSubmit(Array.from(selected))}
        >
          Done
        </button>
      )}
    </div>
  );
}

/** "Today", "Yesterday", or a short date. Enough to tell conversations apart in
 * a list without a date library. */
function sessionLabel(isoTimestamp: string | null): string {
  if (!isoTimestamp) return "";
  const when = new Date(isoTimestamp);
  if (Number.isNaN(when.getTime())) return "";
  const today = new Date();
  const days = Math.floor(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
      - new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime())
    / 86_400_000,
  );
  if (days <= 0) return when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  return when.toLocaleDateString([], { month: "short", day: "numeric" });
}

export function ChatSlot({
  messages,
  onNewConversation,
  onClose,
  historyOpen,
  onHistoryOpenChange,
  history,
  hasOlderMessages,
  onLoadOlder,
  onSend,
  onRetry,
  onClarification,
  sending,
  limitReached,
  lane,
  focusNonce,
  screen,
  onHeightChange,
}: ChatSlotProps) {
  const [message, setMessage] = useState("");
  const [historySheetHeight, setHistorySheetHeight] = useState(fallbackHistorySheetHeight);
  const [historySheetBounds, setHistorySheetBounds] = useState({ left: 0, width: 380 });
  // Set the moment a row is clicked, cleared when the switch settles. The panel
  // stays up for the whole window so the user is never looking at the previous
  // conversation's transcript while believing they opened another one.
  const [awaitingSelection, setAwaitingSelection] = useState(false);
  const trimmedMessage = message.trim();
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottomRef = useRef(true);
  const maxMessageLength = MAX_MESSAGE_LENGTH[lane];
  // Near the cap the count moves inside the field, so the textarea has to give
  // up room on the right for it.
  const counterVisible = message.length > COUNTER_THRESHOLD[lane];

  // Disabling the textarea mid-turn blurs it, and the browser does not restore
  // focus when it re-enables. Refocusing on every enabled transition (mount
  // included) is what keeps the composer usable from the keyboard after the
  // first reply, and keeps the first Escape on the composer's own handler
  // instead of the overlay's window handler, which would close the panel.
  // Also closed while a conversation switch is resolving: until it commits, the
  // id a send would go to is still the previous conversation's.
  const composerDisabled = sending || limitReached || history.opening;
  useEffect(() => {
    if (composerDisabled || historyOpen) return;
    composerRef.current?.focus();
  }, [composerDisabled, focusNonce, historyOpen]);

  useEffect(() => {
    if (!historyOpen) return;
    composerRef.current?.blur();
    let cancelled = false;
    void currentMonitor()
      .then((monitor) => {
        if (cancelled || !monitor) return;
        setHistorySheetHeight(Math.round(
          (monitor.size.height / monitor.scaleFactor) * HISTORY_SHEET_SCREEN_RATIO,
        ));
      })
      .catch(() => {
        if (!cancelled) setHistorySheetHeight(fallbackHistorySheetHeight());
      });
    return () => {
      cancelled = true;
    };
  }, [historyOpen]);

  // Close the panel only once the switch has actually landed. On failure it stays
  // open with the reason, so Retry is one click away and the transcript behind it
  // is still the conversation the user was reading.
  useEffect(() => {
    if (!awaitingSelection || history.opening) return;
    setAwaitingSelection(false);
    if (!history.openError) onHistoryOpenChange(false);
  }, [awaitingSelection, history.opening, history.openError, onHistoryOpenChange]);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body || !stickToBottomRef.current) return;
    body.scrollTop = body.scrollHeight;
  }, [messages]);

  function handleBodyScroll() {
    const body = bodyRef.current;
    if (!body) return;
    const distanceFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= AUTOSCROLL_STICK_PX;
  }

  const chipVisible = screenChipVisible(lane, screen);
  const signallingTurns = turnsSignallingProgress(messages);

  // A readback of what the browser already drew, not a prediction of it: CSS
  // sizes the card to its content, and the window is told that exact number. A
  // stale frame can then only ever show as transparent space beside the card,
  // never as glass the card was stretched to fill.
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card || !onHeightChange) return;
    const report = () => {
      const cardHeight = Math.ceil(card.getBoundingClientRect().height);
      onHeightChange(historyOpen ? Math.max(cardHeight, historySheetHeight) : cardHeight);
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(card);
    return () => observer.disconnect();
  }, [historyOpen, historySheetHeight, onHeightChange]);

  useLayoutEffect(() => {
    if (!historyOpen) return;
    const card = cardRef.current;
    if (!card) return;
    const report = () => {
      const bounds = card.getBoundingClientRect();
      setHistorySheetBounds((current) =>
        current.left === bounds.left && current.width === bounds.width
          ? current
          : { left: bounds.left, width: bounds.width },
      );
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(card);
    window.addEventListener("resize", report);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", report);
    };
  }, [historyOpen]);

  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (!composer) return;
    composer.style.height = `${COMPOSER_MIN_HEIGHT}px`;
    if (message.length < COMPOSER_GROW_THRESHOLD) return;
    const borderHeight = composer.offsetHeight - composer.clientHeight;
    composer.style.height = `${Math.min(
      COMPOSER_MAX_HEIGHT,
      Math.max(COMPOSER_MIN_HEIGHT, composer.scrollHeight + borderHeight),
    )}px`;
  }, [message]);

  const screenToggleTitle = lane === "live"
    ? "Ask out loud and Aura already sees your screen"
    : screen.armed
      ? "Screen is attached to your next message"
      : "Attach your screen to the next message";

  function sendMessage() {
    if (!trimmedMessage || trimmedMessage.length > maxMessageLength || sending || limitReached) return;
    // Sending always returns the user to the live end of the transcript.
    stickToBottomRef.current = true;
    if (onSend(trimmedMessage)) setMessage("");
  }

  const historySheetStyle = {
    "--chat-history-sheet-height": `${historySheetHeight}px`,
    "--chat-history-sheet-left": `${historySheetBounds.left}px`,
    "--chat-history-sheet-width": `${historySheetBounds.width}px`,
  } as CSSProperties;

  return (
    <div
      className={`chat-slot chat-slot-frame${historyOpen ? " history-open" : ""}`}
      style={historySheetStyle}
    >
      <BarIconButton
        title={historyOpen ? "Close chat history" : history.locked ? "Finish this reply first" : "Chat history"}
        disabled={!historyOpen && history.locked}
        onClick={() => {
          if (historyOpen) {
            onHistoryOpenChange(false);
            return;
          }
          onHistoryOpenChange(true);
          history.refresh();
        }}
        className="chat-history-toggle"
        active={historyOpen}
      >
        <History aria-hidden="true" />
      </BarIconButton>

      <GlassSurface className="chat-slot-surface" draggable={false}>
        <div className={`chat-slot-inner${chipVisible ? " has-chip" : ""}`} ref={cardRef}>
        <header className="chat-slot-header">
          <BarIconButton
            title={lane === "live" ? "End the voice call to start a new chat" : "New chat"}
            disabled={lane === "live" || sending || history.opening}
            onClick={() => {
              if (!onNewConversation()) return;
              setMessage("");
              stickToBottomRef.current = true;
              onHistoryOpenChange(false);
              composerRef.current?.focus();
            }}
            className="chat-slot-new"
          >
            <Plus aria-hidden="true" />
          </BarIconButton>
          <BarIconButton title="Close chat" onClick={onClose} className="chat-slot-close">
            <X aria-hidden="true" />
          </BarIconButton>
        </header>

        <div className="chat-slot-body" aria-live="polite" ref={bodyRef} onScroll={handleBodyScroll}>
          <div className="chat-slot-transcript" onCopy={copySelectionAsPlainText}>
          {hasOlderMessages && (
            <button type="button" className="chat-history-more" onClick={onLoadOlder}>
              Load earlier messages
            </button>
          )}
          {displayOrder(messages).map((item) => item.kind === "activity" ? (
            <ActivityRow key={item.id} message={item} />
          ) : item.kind === "thinking" ? (
            <ReasoningRow key={item.id} message={item} />
          ) : (
            <div
              key={item.id}
              className={`chat-message chat-message-${item.role} chat-message-${item.state}`}
            >
              <div className={`chat-message-bubble chat-message-kind-${item.kind ?? "text"}${
                item.reminder?.displayMode === "supplemental"
                  ? " chat-reminder-supplemental"
                  : ""
              }`}>
                {item.kind === "reminder" && item.reminder ? (
                  item.reminder.displayMode === "supplemental" ? (
                    <>
                      <div className="chat-markdown">
                        <Markdown
                          remarkPlugins={[remarkGfm]}
                          components={MARKDOWN_COMPONENTS}
                          skipHtml
                          disallowedElements={["a", "img"]}
                          unwrapDisallowed
                        >
                          {item.text}
                        </Markdown>
                      </div>
                      <ReminderCard reminder={item.reminder} />
                    </>
                  ) : (
                    <ReminderCard reminder={item.reminder} />
                  )
                ) : rendersMarkdown(item) ? (
                  <div className="chat-markdown">
                    <Markdown
                      remarkPlugins={[remarkGfm]}
                      components={MARKDOWN_COMPONENTS}
                      skipHtml
                      disallowedElements={["a", "img"]}
                      unwrapDisallowed
                    >
                      {item.text}
                    </Markdown>
                  </div>
                ) : (
                  item.text
                )}
                {item.state === "streaming" && !item.text
                  && !(item.turnId && signallingTurns.has(item.turnId)) && (
                  <span className="chat-thinking" role="status">
                    <span className="chat-thinking-dots" aria-hidden="true">
                      <i /><i /><i />
                    </span>
                    Aura is thinking
                  </span>
                )}
                {item.state === "streaming" && !!item.text && !rendersMarkdown(item) && (
                  <span className="chat-message-caret" aria-hidden="true" />
                )}
                {item.kind === "clarification" && (
                  <ClarificationChoices
                    message={item}
                    disabled={sending}
                    onSubmit={(selectedOptions) => onClarification(item.id, selectedOptions)}
                  />
                )}
              </div>
              {item.state === "queued" && (
                <span className="chat-message-note">
                  {item.queuePosition ? `Queued, ${item.queuePosition} ahead` : "Queued"}
                </span>
              )}
              {item.role === "user" && item.lane === "live" && item.state === "sent" && (
                <span className="chat-message-note">Sending</span>
              )}
              {item.role === "user" && item.state === "failed" && (
                <div className="chat-message-failure">
                  <span className="chat-message-note">Failed</span>
                  <button
                    type="button"
                    className="chat-message-retry"
                    disabled={sending || (item.lane === "live" && lane !== "live")}
                    title={item.lane === "live" && lane !== "live" ? "Start a voice session to retry" : "Retry"}
                    onClick={() => onRetry(item.id)}
                  >
                    Retry
                  </button>
                </div>
              )}
            </div>
          ))}
          </div>
        </div>

        {chipVisible && (
          <div className="chat-screen-chip">
            <img className="chat-screen-thumb" src={screen.previewUrl ?? undefined} alt="" />
            <span className="chat-screen-label">Screen attached</span>
            <button
              type="button"
              className="chat-screen-remove"
              aria-label="Remove screen"
              title="Remove screen"
              onClick={screen.remove}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        )}

        <form
          className="chat-slot-composer"
          onSubmit={(event) => {
            event.preventDefault();
            sendMessage();
          }}
        >
          <div className={`chat-slot-input${counterVisible ? " counting" : ""}`}>
            <button
              type="button"
              className={`chat-screen-toggle${screen.armed && lane !== "live" ? " armed" : ""}`}
              aria-pressed={screen.armed && lane !== "live"}
              disabled={lane === "live"}
              title={screenToggleTitle}
              onClick={screen.toggle}
            >
              {screen.armed && lane !== "live"
                ? <Eye aria-hidden="true" />
                : <EyeOff aria-hidden="true" />}
            </button>
            <textarea
              rows={1}
              ref={composerRef}
              value={message}
              maxLength={maxMessageLength}
              aria-label="Chat message"
              placeholder={limitReached ? "Daily chat limit reached" : "Message Aura"}
              disabled={composerDisabled}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                // First Escape only drops focus and keeps the draft text. It must
                // not reach the overlay's window-level Escape handler, which
                // closes the slot and would take a half-typed message with it.
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  composerRef.current?.blur();
                  return;
                }
                if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
                event.preventDefault();
                sendMessage();
              }}
            />
            {counterVisible && (
              <span className="chat-slot-counter">
                {message.length.toLocaleString()} / {maxMessageLength.toLocaleString()}
              </span>
            )}
          </div>
          <button
            type="submit"
            className="chat-slot-send"
            aria-label="Send message"
            title="Send message"
            disabled={!trimmedMessage || trimmedMessage.length > maxMessageLength || sending || limitReached}
          >
            <Send aria-hidden="true" />
          </button>
        </form>
        </div>
      </GlassSurface>

      {historyOpen && (
        <GlassSurface className="chat-history-sheet" draggable={false}>
          <BarIconButton
            title="Close chat history"
            onClick={() => onHistoryOpenChange(false)}
            className="chat-history-sheet-close"
          >
            <X aria-hidden="true" />
          </BarIconButton>
          <section className="chat-history-sheet-inner" aria-label="Chat history">
            <div className="chat-history-scroll">
              <div className="chat-history-list">
                {history.error ? (
                  <div className="chat-history-failure">
                    <span className="chat-history-empty">{history.error}</span>
                    <button type="button" className="chat-history-more" onClick={history.refresh}>
                      Retry
                    </button>
                  </div>
                ) : (
                  history.sessions.length === 0 && !history.loading && (
                    <p className="chat-history-empty">No earlier conversations yet.</p>
                  )
                )}
                {history.openError && (
                  <div className="chat-history-failure">
                    <span className="chat-history-empty">{history.openError}</span>
                  </div>
                )}
                {history.sessions.map((session) => (
                  <button
                    key={session.conversationId}
                    type="button"
                    className="chat-history-row"
                    disabled={history.opening || history.locked}
                    onClick={() => {
                      if (!history.select(session.conversationId)) return;
                      setAwaitingSelection(true);
                      stickToBottomRef.current = true;
                    }}
                  >
                    <span className="chat-history-preview">
                      {session.lastMessagePreview || "Empty conversation"}
                    </span>
                    <span className="chat-history-meta">
                      {session.messageCount === 1 ? "1 message" : `${session.messageCount} messages`}
                      {sessionLabel(session.lastActivityAt) && ` · ${sessionLabel(session.lastActivityAt)}`}
                    </span>
                  </button>
                ))}
                {(history.loading || history.opening) && (
                  <p className="chat-history-empty">
                    {history.opening ? "Opening..." : "Loading..."}
                  </p>
                )}
                {history.hasMore && !history.loading && !history.error && (
                  <button type="button" className="chat-history-more" onClick={history.loadMore}>
                    Show older
                  </button>
                )}
              </div>
            </div>
          </section>
        </GlassSurface>
      )}
    </div>
  );
}
