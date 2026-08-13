import { useCallback, useEffect, useRef, useState } from "react";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import {
  clearCachedChat,
  loadCachedConversation,
  replaceCachedConversation,
  type CachedChatMessage,
} from "../lib/chatCache";
import { setChatConversationId, setTextHandoffProvider } from "../lib/chatConversation";
import {
  getChatSession,
  listChatSessions,
  listPendingTurns,
  MAX_MESSAGE_PAGE_SIZE,
  type DesktopChatMessage,
  type DesktopChatSession,
} from "../lib/desktopChatApi";
import {
  ChatRequestError,
  streamChat,
  type ChatDoneMetadata,
  type ChatHistoryEntry,
  type ChatStreamFrame,
} from "../lib/chatStream";
import type { ChatAttachment } from "../lib/chatScreenCapture";
import { trackEvent } from "../lib/analytics";
import { logError } from "../lib/log";
import { captureException } from "../lib/sentry";
import { MAX_MESSAGE_LENGTH, type ChatLane, type ChatMessage } from "./ChatSlot";

interface UseChatSessionOptions {
  enabled: boolean;
  /** Whose transcript this is. Every local cache read and write carries it, so
   * one account's chat can never render in another's window. */
  uid: string | null;
  /** Screen context for the turn about to go out, resolved at send time so the
   * frame is as fresh as the message. Must never throw; a message goes out
   * without its picture rather than not at all. */
  resolveAttachments?: () => Promise<ChatAttachment[]>;
}

/** How many history entries the backend will actually consume (its
 * CHAT_HISTORY_WINDOW). Sending more than this is pure upload waste: the server
 * takes the tail and discards the rest, so a 100-entry send with an 8000-char
 * cap per message could put ~800 KB on the wire to feed a 30-entry window.
 *
 * Deliberately NOT tightened further yet. A smaller window here would cut real
 * recall until server-side compaction lands to cover what falls out; once it
 * does, this drops to the retained-raw-turn count and gains a character budget. */
const HISTORY_SEND_LIMIT = 30;

function historyFrom(messages: ChatMessage[], excludedTurnId?: string): ChatHistoryEntry[] {
  return messages
    .filter((message) => message.turnId !== excludedTurnId)
    .flatMap<ChatHistoryEntry>((message) => {
      if (
        message.role === "user"
        && message.lane !== "live"
        && (message.state === "sent" || message.state === "complete")
        && (!message.kind || message.kind === "text")
      ) {
        return [{ role: "user", content: message.text }];
      }
      if (
        message.role === "assistant"
        && message.lane !== "live"
        && message.state === "complete"
        && message.text
        && (!message.kind || message.kind === "text" || message.kind === "clarification")
      ) {
        return [{ role: "assistant", content: message.text }];
      }
      return [];
    })
    .slice(-HISTORY_SEND_LIMIT);
}

/** What the transcript says when a turn fails without an `error` frame. Only a
 * genuine transport failure gets blamed on the connection; a rejected request
 * names its own status so Retry is not offered as the answer to everything. */
function failureText(err: unknown): string {
  if (!(err instanceof ChatRequestError)) {
    return "The connection dropped before Aura finished. Retry this message to continue.";
  }
  if (err.status === 429) {
    return "Aura is handling too many requests right now. Retry this message in a moment.";
  }
  if (err.status >= 500) {
    return `Aura's server could not answer this message (HTTP ${err.status}). Retry to try again.`;
  }
  return `Aura could not accept this message (HTTP ${err.status}).`;
}

function chatFailureReason(err: unknown): string {
  if (err instanceof AuthRequiredError) return "auth_required";
  if (err instanceof ChatRequestError) return `http_${err.status}`;
  if (err instanceof Error && err.message.includes("terminal frame")) return "missing_terminal_frame";
  return "transport_failed";
}

// Two different limits that must not be confused. The cache one is local and
// never crosses the wire; the server one has to stay within the backend's
// MAX_MESSAGE_PAGE_SIZE or the request comes back 400 and hydration silently
// degrades to cache-only.
const CACHE_PAINT_LIMIT = 200;
const SERVER_PAGE_LIMIT = MAX_MESSAGE_PAGE_SIZE;
const SESSION_PAGE_LIMIT = 20;

// Delays between checks on a turn the backend is still finishing, in order.
//
// Two different server timelines have to be covered, not one. The delayed Cloud
// Task fires at CHAT_COMPLETION_DELAY_SECONDS (90), which the tight head of this
// schedule covers. But if that task's canonical write fails, repair falls to the
// backstop sweep, and that is gated at `now_minute % 5 == 3` with a 5-minute
// cutoff (handlers/scheduler.py), so a repaired answer can land 5 to 10 minutes
// out. The two long tails below sit at 5 and 10 minutes for exactly that case.
// Stopping at 3 minutes, as an earlier version did, left a repaired turn showing
// "Finishing in the background" until the user happened to refocus the window.
const PENDING_POLL_SCHEDULE_MS = [
  20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, 20_000, // to 3 min
  120_000, // 5 min: first sweep window
  300_000, // 10 min: worst case for the 5-minute gate plus the 5-minute cutoff
];

const PENDING_NOTE = "Finishing in the background.";
const UNDELIVERED_NOTE = "Message wasn't delivered. Try again.";
const OPEN_FAILED_NOTE = "Couldn't open this conversation. Retry.";
const HISTORY_FAILED_NOTE = "Couldn't load your conversations. Retry.";

/** Local bubble id for a turn. Derived, never stored, so a message that arrives
 * from the cache and the same message that arrives from Firestore collapse onto
 * one bubble instead of rendering twice. The server's own assistant document id
 * (`{cmid}__assistant`) is deliberately NOT reused here - it is the server's key,
 * this is the view's. */
/** Whether a hydration actually landed, and whether the backend still owes an
 * answer. `committed: false` means nothing on screen changed - a stale selection,
 * an abort, or a conversation the server could not serve. */
interface HydrationOutcome {
  committed: boolean;
  pending: boolean;
}

function localMessageId(clientMessageId: string, role: "user" | "assistant"): string {
  return role === "user" ? clientMessageId : `${clientMessageId}:assistant`;
}

/** What is worth keeping on disk: the transcript the user would expect to see
 * again. Live-lane turns are excluded (they have no server-side recovery, so a
 * cached copy would be a promise the backend cannot keep), and so are transient
 * lines - tool progress, degraded-frame notices, session dividers. */
function cacheRowsFor(
  messages: ChatMessage[],
  conversationId: string,
): CachedChatMessage[] {
  const now = Date.now();
  const rows: CachedChatMessage[] = [];
  messages.forEach((message, index) => {
    if (message.lane === "live" || !message.turnId) return;
    if (message.role !== "user" && message.role !== "assistant") return;
    const kind = message.kind ?? "text";
    if (kind !== "text" && kind !== "error" && kind !== "reminder" && kind !== "limit") return;
    if (!message.text) return;
    rows.push({
      message_id: message.id,
      client_message_id: message.turnId,
      conversation_id: conversationId,
      role: message.role,
      text: message.text,
      status: message.state,
      seq: index,
      created_at_ms: now + index,
      has_attachments: false,
    });
  });
  return rows;
}

function fromCacheRow(row: CachedChatMessage): ChatMessage {
  const role = row.role === "assistant" ? "assistant" : "user";
  return {
    id: row.message_id,
    turnId: row.client_message_id,
    role,
    text: row.text,
    // A row cached mid-stream would otherwise reopen as "streaming" with a caret
    // that never resolves; the reconcile pass below corrects the real state.
    state: row.status === "failed" ? "failed" : role === "user" ? "sent" : "complete",
    kind: "text",
  };
}

/** `turnFailed` comes from the turn's ASSISTANT record, not this message's own
 * status: a user document is always stored "sent", so left to itself the user
 * bubble of a failed turn renders complete and ChatSlot never offers Retry. The
 * caller resolves the pairing, which is the only place both halves are in view. */
function fromServerMessage(message: DesktopChatMessage, turnFailed: boolean): ChatMessage[] {
  const id = localMessageId(message.clientMessageId, message.role);
  const out: ChatMessage[] = [{
    id,
    turnId: message.clientMessageId,
    role: message.role,
    text: message.text,
    state: turnFailed && message.role === "user" ? "failed" : "complete",
    kind: message.status === "failed" && message.role === "assistant" ? "error" : "text",
  }];
  if (message.role === "assistant" && message.reminder) {
    out.push({
      id: `${message.clientMessageId}:reminder`,
      turnId: message.clientMessageId,
      role: "assistant",
      text: reminderText(message.reminder),
      state: "complete",
      kind: "reminder",
    });
  }
  return out;
}

/** A user bubble is failed exactly when its turn's assistant half is an error.
 *
 * Applied across the WHOLE transcript rather than per message, because the two
 * halves of a turn can arrive in different pages: prepending an older page can
 * introduce a user bubble whose failed answer was already on screen, and derived
 * per-row it would render complete with no Retry. */
function normalizeTurnFailures(messages: ChatMessage[]): ChatMessage[] {
  const failedTurnIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant" && message.kind === "error" && message.turnId) {
      failedTurnIds.add(message.turnId);
    }
  }
  if (failedTurnIds.size === 0) return messages;
  return messages.map((message) =>
    message.role === "user"
      && message.turnId
      && failedTurnIds.has(message.turnId)
      && message.state !== "failed"
      ? { ...message, state: "failed" as const }
      : message,
  );
}

function reminderText(reminder: Record<string, unknown>): string {
  const message = typeof reminder.message === "string" ? reminder.message : "Reminder updated";
  const triggerAt = typeof reminder.trigger_at === "string" ? reminder.trigger_at : "";
  return triggerAt ? `${message}\n${triggerAt}` : message;
}

export function useChatSession({ enabled, uid, resolveAttachments }: UseChatSessionOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sending, setSending] = useState(false);
  const [limitReached, setLimitReached] = useState(false);
  const lane: ChatLane = "cold";
  // Explicitly a plain string: a conversation id adopted from the server on
  // hydration is not necessarily one this client minted.
  const conversationIdRef = useRef<string>(crypto.randomUUID());
  const enabledRef = useRef(enabled);
  const activeRequestRef = useRef<{ clientMessageId: string; controller: AbortController } | null>(null);
  const messagesRef = useRef(messages);
  const resolveAttachmentsRef = useRef(resolveAttachments);
  const uidRef = useRef(uid);
  // The conversation refreshes must stay pinned to. A newly-created empty thread
  // is pinned before the server knows it so focus refresh cannot restore the old
  // conversation underneath it. Null only before startup adopts a target.
  const serverConversationRef = useRef<string | null>(null);
  // Bumped on every explicit conversation switch. A hydration that finishes after
  // a newer selection started sees a stale generation and commits nothing, so a
  // slow response for conversation A can never land on top of conversation B.
  const selectionRef = useRef(0);
  const selectionControllerRef = useRef<AbortController | null>(null);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<DesktopChatSession[]>([]);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  messagesRef.current = messages;
  resolveAttachmentsRef.current = resolveAttachments;
  uidRef.current = uid;

  const upsertMessage = useCallback((message: ChatMessage) => {
    setMessages((current) => {
      const index = current.findIndex((item) => item.id === message.id);
      if (index < 0) return [...current, message];
      return current.map((item, itemIndex) => itemIndex === index ? message : item);
    });
  }, []);

  useEffect(() => {
    enabledRef.current = enabled;
    if (enabled) {
      // Published for the voice start path, which sends it as
      // /voice/token?conversation_id= and hands the recent text turns over with
      // it. The same id lives for the whole signed-in chat session, so a voice
      // call started mid-conversation continues that conversation rather than
      // opening a new one; it resets only in the sign-out branch below.
      setChatConversationId(conversationIdRef.current);
      // Read once at voice start, so a streaming reply does not rebuild the
      // digest on every delta.
      setTextHandoffProvider(() => historyFrom(messagesRef.current));
      return () => setTextHandoffProvider(null);
    }
    activeRequestRef.current?.controller.abort();
    activeRequestRef.current = null;
    conversationIdRef.current = crypto.randomUUID();
    serverConversationRef.current = null;
    setChatConversationId(null);
    setTextHandoffProvider(null);
    setMessages([]);
    setSending(false);
    setLimitReached(false);
    setOlderCursor(null);
    setSessions([]);
    setSessionsCursor(null);
    setSessionsLoading(false);
    setSessionsError(null);
    selectionRef.current += 1;
    selectionControllerRef.current?.abort();
    selectionControllerRef.current = null;
    setConversationLoading(false);
    setConversationError(null);
    // Local transcript goes with the session. Rust prunes the file at its own
    // session boundary too, so a crash between here and the next sign-in cannot
    // leave one account's chat readable by the next.
    void clearCachedChat(null);
  }, [enabled]);

  /** Replaces the local transcript with the server's, and says whether the
   * backend is still finishing anything.
   *
   * The server is authoritative for every turn it knows about. Three cases are
   * distinguished on purpose, because collapsing them is how a chat UI ends up
   * lying: a turn with a stored answer renders once, a turn the backend is still
   * working on says so, and a turn the backend has never heard of is reported as
   * undelivered rather than left looking like it is about to reply. A turn that
   * is streaming right now is left alone - it is not lost, it is in flight. */
  const hydrateConversation = useCallback(async (
    conversationId: string,
    signal: AbortSignal,
    selection: number = selectionRef.current,
  ): Promise<HydrationOutcome> => {
    // One page is enough: the endpoint returns the NEWEST page in send order, so
    // the tail of a long conversation is what lands here. Older pages are the
    // history panel's job, via olderCursor.
    const transcript = await getChatSession(
      conversationId, SERVER_PAGE_LIMIT, undefined, signal,
    );
    if (!transcript || signal.aborted) return { committed: false, pending: false };
    const pendingTurns = await listPendingTurns(20, signal);
    if (signal.aborted) return { committed: false, pending: false };
    // Last chance to bail before anything visible changes: a newer selection may
    // have started while these two requests were in flight.
    if (selectionRef.current !== selection) return { committed: false, pending: false };

    const serverMessages = transcript.messages;
    const knownTurnIds = new Set(serverMessages.map((message) => message.clientMessageId));
    const answeredTurnIds = new Set(
      serverMessages
        .filter((message) => message.role === "assistant")
        .map((message) => message.clientMessageId),
    );
    // A turn whose stored answer is a failure. Both halves have to reflect it or
    // the user sees the explanation with no way to act on it.
    const failedTurnIds = new Set(
      serverMessages
        .filter((message) => message.role === "assistant" && message.status === "failed")
        .map((message) => message.clientMessageId),
    );
    const pendingTurnIds = new Set(
      pendingTurns
        .filter((turn) => turn.conversationId === conversationId)
        .map((turn) => turn.clientMessageId),
    );

    // Commit point. Every piece of "which conversation is this" moves together,
    // and only now: the id the composer sends, the id refreshes target, the id
    // voice handoff uses, the cursor, and the transcript itself. Moving any of
    // them earlier is what let a send land in the previous conversation while the
    // UI was already showing the new one.
    conversationIdRef.current = conversationId;
    serverConversationRef.current = conversationId;
    setChatConversationId(conversationId);
    setOlderCursor(transcript.olderCursor);

    setMessages((current) => {
      const inFlightTurnId = activeRequestRef.current?.clientMessageId;
      const rebuilt: ChatMessage[] = [];
      for (const message of serverMessages) {
        rebuilt.push(...fromServerMessage(message, failedTurnIds.has(message.clientMessageId)));
        if (message.role !== "user") continue;
        const turnId = message.clientMessageId;
        if (answeredTurnIds.has(turnId) || turnId === inFlightTurnId) continue;
        if (pendingTurnIds.has(turnId)) {
          rebuilt.push({
            id: `${turnId}:pending`,
            turnId,
            role: "assistant",
            text: PENDING_NOTE,
            state: "complete",
            kind: "status",
          });
          continue;
        }
        // Accepted, then abandoned without a stored answer and with no recovery
        // record left. Offer Retry rather than inventing a reply.
        rebuilt.push({
          id: `${turnId}:error`,
          turnId,
          role: "assistant",
          text: UNDELIVERED_NOTE,
          state: "complete",
          kind: "error",
        });
      }
      // Anything the server has never seen: a live-lane turn (never persisted),
      // the turn currently streaming, or a send that never reached the backend.
      const carried: ChatMessage[] = [];
      const undelivered = new Set<string>();
      for (const message of current) {
        if (message.turnId && knownTurnIds.has(message.turnId)) continue;
        // Belongs to no turn at all (the voice-session divider). Not the
        // server's to know about, so a refresh must not silently drop it.
        if (!message.turnId) {
          carried.push(message);
          continue;
        }
        if (message.lane === "live" || message.turnId === inFlightTurnId) {
          carried.push(message);
          continue;
        }
        if (message.role === "user" && message.kind === "text") {
          undelivered.add(message.id);
          carried.push({ ...message, state: "failed" });
          continue;
        }
        if (message.role === "user") carried.push(message);
      }
      for (const turnId of undelivered) {
        carried.push({
          id: `${turnId}:error`,
          turnId,
          role: "assistant",
          text: UNDELIVERED_NOTE,
          state: "complete",
          kind: "error",
        });
      }
      return normalizeTurnFailures([...rebuilt, ...carried]);
    });

    return { committed: true, pending: pendingTurnIds.size > 0 };
  }, []);

  /** Picks which conversation to refresh, then hydrates it.
   *
   * Targets whatever the user is actually looking at: once a conversation has
   * been adopted from the server (on launch, or by picking one in the history
   * panel) every later refresh stays on it. Without that, a focus event would
   * quietly yank someone reading an older conversation back to the newest one. */
  const reconcile = useCallback(async (signal: AbortSignal): Promise<HydrationOutcome> => {
    const idle: HydrationOutcome = { committed: false, pending: false };
    if (!uidRef.current) return idle;
    const selection = selectionRef.current;
    let target = serverConversationRef.current;
    if (!target) {
      const page = await listChatSessions(1, undefined, signal);
      target = page.sessions[0]?.conversationId ?? null;
      if (!target || signal.aborted) return idle;
    }
    return hydrateConversation(target, signal, selection);
  }, [hydrateConversation]);

  // Startup and refresh: paint the local cache first so the overlay is never
  // blank, then let the server correct it. Cache errors are already swallowed
  // one layer down, so the worst case here is an empty first paint.
  useEffect(() => {
    if (!enabled || !uid) return;
    const controller = new AbortController();
    const startupSelection = selectionRef.current;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const paintCache = async () => {
      const cached = await loadCachedConversation(uid, null, CACHE_PAINT_LIMIT);
      if (
        cancelled
        || selectionRef.current !== startupSelection
        || !cached
        || cached.messages.length === 0
      ) return;
      conversationIdRef.current = cached.conversation_id;
      setChatConversationId(cached.conversation_id);
      // Only ever a first paint: anything already on screen is fresher.
      setMessages((current) => current.length > 0 ? current : cached.messages.map(fromCacheRow));
    };

    const refresh = async () => {
      try {
        const outcome = await reconcile(controller.signal);
        if (cancelled) return;
        const nextDelay = PENDING_POLL_SCHEDULE_MS[attempts];
        if (outcome.pending && nextDelay !== undefined) {
          attempts += 1;
          timer = setTimeout(() => void refresh(), nextDelay);
        }
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        if (err instanceof AuthRequiredError) {
          await routeToDashboardForExpiredSession();
          return;
        }
        logError("useChatSession: hydrate", err);
      }
    };

    void (async () => {
      await paintCache();
      if (!cancelled) await refresh();
    })();

    // Coming back to the window is the cheapest honest trigger for a turn that
    // finished while the app was in the background and the poll budget ran out.
    const onFocus = () => {
      attempts = 0;
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, reconcile, uid]);

  // Mirror the settled transcript to disk. Skipped while a reply is streaming so
  // a long answer is not rewritten on every delta; the terminal state lands the
  // moment the stream finishes.
  useEffect(() => {
    if (!enabled || !uid || messages.length === 0) return;
    if (messages.some((message) => message.state === "streaming")) return;
    const conversationId = conversationIdRef.current;
    const rows = cacheRowsFor(messages, conversationId);
    if (rows.length === 0) return;
    void replaceCachedConversation(uid, conversationId, rows);
  }, [enabled, messages, uid]);

  const runTurn = useCallback(async (
    clientMessageId: string,
    text: string,
    history: ChatHistoryEntry[],
    // False for a retry: the frame that went with the original attempt is gone
    // (screen context is one-shot), and quietly attaching a picture of a
    // different moment would make Retry send a different message than the one
    // that failed.
    withScreenContext = false,
  ) => {
    if (!enabledRef.current || activeRequestRef.current) return;
    const controller = new AbortController();
    activeRequestRef.current = { clientMessageId, controller };
    setSending(true);

    const assistantId = `${clientMessageId}:assistant`;
    let terminalFrameSeen = false;
    let errorFrameSeen = false;

    setMessages((current) => [
      ...current.filter((message) => message.turnId !== clientMessageId || message.role === "user"),
      {
        id: assistantId,
        turnId: clientMessageId,
        role: "assistant",
        text: "",
        state: "streaming",
        kind: "text",
      },
    ]);

    const upsert = (message: ChatMessage) => {
      setMessages((current) => {
        const index = current.findIndex((item) => item.id === message.id);
        if (index < 0) return [...current, message];
        return current.map((item, itemIndex) => itemIndex === index ? message : item);
      });
    };

    // The tool progress line is transient: it says what Aura is doing right now,
    // so it has to go once the turn is over, or it sits below the finished
    // answer forever (it is appended after the assistant bubble).
    const toolStatusId = `${clientMessageId}:tool-status`;
    const thinkingId = `${clientMessageId}:thinking`;

    const finishAssistantText = () => {
      setMessages((current) => current.flatMap((message) => {
        if (message.id === toolStatusId) return [];
        // Activity rows OUTLIVE the turn, unlike the v1 status pill: "it searched
        // the web to answer this" stays true after the answer lands, and deleting
        // it would make the transcript claim less than actually happened. They are
        // only settled here, never removed.
        if (message.turnId === clientMessageId && message.kind === "activity") {
          return message.running ? [{ ...message, running: false }] : [message];
        }
        if (message.id === thinkingId) {
          return message.text ? [{ ...message, state: "complete" as const }] : [];
        }
        if (message.id !== assistantId) return [message];
        return message.text ? [{ ...message, state: "complete" as const }] : [];
      }));
    };

    const markUser = (state: "sent" | "failed") => {
      setMessages((current) => current.map((message) =>
        message.id === clientMessageId ? { ...message, state } : message,
      ));
    };

    const handleDone = (metadata: ChatDoneMetadata) => {
      terminalFrameSeen = true;
      finishAssistantText();
      markUser("sent");
      if (metadata.reminder) {
        upsert({
          id: `${clientMessageId}:reminder`,
          turnId: clientMessageId,
          role: "assistant",
          text: reminderText(metadata.reminder),
          state: "complete",
          kind: "reminder",
        });
      }
    };

    const handleFrame = (frame: ChatStreamFrame) => {
      switch (frame.type) {
        case "text_delta":
          setMessages((current) => current.map((message) =>
            message.id === assistantId ? { ...message, text: message.text + frame.delta } : message,
          ));
          break;
        case "tool_thinking":
        case "tool_status":
          upsert({
            id: toolStatusId,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.message,
            state: "complete",
            kind: "status",
          });
          break;
        // One row per tool, keyed by the tool's own id. The v1 path above
        // deliberately still collapses onto a single overwritten row, because a
        // v1 backend only ever sends one.
        case "tool_start":
          upsert({
            id: `${clientMessageId}:tool:${frame.id}`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.label,
            state: "complete",
            kind: "activity",
            tool: frame.tool,
            detail: frame.detail,
            running: true,
          });
          break;
        case "tool_end":
          setMessages((current) => current.map((message) =>
            message.id === `${clientMessageId}:tool:${frame.id}`
              ? { ...message, running: false, ok: frame.ok }
              : message,
          ));
          break;
        // Adaptive thinking means most turns have no thinking block at all, so
        // this row is created on demand rather than pre-seeded like the assistant
        // bubble. Its text is the SUMMARIZED reasoning the API returns.
        case "thinking_start":
          upsert({
            id: thinkingId,
            turnId: clientMessageId,
            role: "assistant",
            text: "",
            state: "streaming",
            kind: "thinking",
          });
          break;
        case "thinking_delta":
          setMessages((current) => current.map((message) =>
            message.id === thinkingId
              ? { ...message, text: message.text + frame.delta }
              : message,
          ));
          break;
        case "thinking_end":
          setMessages((current) => current.flatMap((message) => {
            if (message.id !== thinkingId) return [message];
            // A thinking block with no text is what display:"omitted" and a
            // zero-length summary both look like; an empty collapsible would be
            // a control that opens onto nothing.
            return message.text ? [{ ...message, state: "complete" as const }] : [];
          }));
          break;
        case "clarification_ui":
          upsert({
            id: `${clientMessageId}:clarification:${frame.clarification_id}`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.question,
            state: "complete",
            kind: "clarification",
            clarificationId: frame.clarification_id,
            options: frame.options,
            multiSelect: frame.multi_select,
          });
          break;
        case "chat_limit_reached":
          terminalFrameSeen = true;
          finishAssistantText();
          markUser("sent");
          setLimitReached(true);
          upsert({
            id: `${clientMessageId}:limit`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.message,
            state: "complete",
            kind: "limit",
          });
          break;
        case "error":
          terminalFrameSeen = true;
          errorFrameSeen = true;
          trackEvent("chat_turn_failed", { reason: "error_frame" });
          captureException(new Error("Desktop chat returned an error frame"), {
            feature: "desktop_text_chat",
            reason: "error_frame",
            clientMessageId,
          });
          finishAssistantText();
          markUser("failed");
          upsert({
            id: `${clientMessageId}:error`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.message,
            state: "complete",
            kind: "error",
          });
          break;
        case "done":
          handleDone(frame.metadata);
          break;
        case "degraded":
          upsert({
            id: `${clientMessageId}:degraded:${crypto.randomUUID()}`,
            turnId: clientMessageId,
            role: "assistant",
            text: frame.message,
            state: "complete",
            kind: "degraded",
          });
          break;
        case "terminator":
          break;
      }
    };

    const attachments = withScreenContext && resolveAttachmentsRef.current
      ? await resolveAttachmentsRef.current()
      : [];

    try {
      await streamChat({
        message: text,
        history,
        sessionId: conversationIdRef.current,
        clientMessageId,
        attachments,
        signal: controller.signal,
        onOpen: () => markUser("sent"),
        onFrame: handleFrame,
      });
      if (!terminalFrameSeen) {
        throw new Error("Chat stream reached [DONE] without a terminal frame");
      }
    } catch (err) {
      if (controller.signal.aborted && !enabledRef.current) return;
      const reason = chatFailureReason(err);
      trackEvent("chat_turn_failed", { reason });
      captureException(err instanceof Error ? err : new Error(reason), {
        feature: "desktop_text_chat",
        reason,
        clientMessageId,
      });
      if (!errorFrameSeen) {
        markUser("failed");
        finishAssistantText();
        upsert({
          id: `${clientMessageId}:error`,
          turnId: clientMessageId,
          role: "assistant",
          text: failureText(err),
          state: "complete",
          kind: "error",
        });
      }
      if (err instanceof AuthRequiredError) {
        await routeToDashboardForExpiredSession();
      } else {
        logError("useChatSession: stream", err);
      }
    } finally {
      if (activeRequestRef.current?.clientMessageId === clientMessageId) {
        activeRequestRef.current = null;
        setSending(false);
      }
    }
  }, []);

  const send = useCallback((text: string) => {
    const trimmed = text.trim();
    if (
      !enabledRef.current
      || activeRequestRef.current
      || sending
      || limitReached
      || !trimmed
      || trimmed.length > MAX_MESSAGE_LENGTH.cold
    ) return false;
    const clientMessageId = crypto.randomUUID();
    const history = historyFrom(messages);
    const bubble: ChatMessage = {
      id: clientMessageId,
      turnId: clientMessageId,
      role: "user",
      text: trimmed,
      state: "sending",
      kind: "text",
      lane: "cold",
    };
    setMessages((current) => [...current, bubble]);
    // Cached without awaiting, so a slow or broken disk can never delay the
    // request. The settled-transcript effect above rewrites this row once the
    // turn ends; this write only exists so a crash mid-turn still shows what
    // the user typed.
    const currentUid = uidRef.current;
    if (currentUid) {
      const conversationId = conversationIdRef.current;
      void replaceCachedConversation(
        currentUid,
        conversationId,
        cacheRowsFor([...messagesRef.current, bubble], conversationId),
      );
    }
    void runTurn(clientMessageId, trimmed, history, true);
    return true;
  }, [limitReached, messages, runTurn, sending]);

  const retry = useCallback((clientMessageId: string) => {
    const message = messages.find((item) => item.id === clientMessageId && item.role === "user");
    if (!message) return;
    if (!enabledRef.current || activeRequestRef.current || sending || limitReached) return;
    // The backend stores this turn's answer under its client_message_id and
    // replays that stored answer for a repeat of the same id. Re-sending the old
    // id would return the old failure forever instead of actually retrying.
    const retryMessageId = crypto.randomUUID();
    const history = historyFrom(messages, clientMessageId);
    setMessages((current) => current
      .filter((item) => item.turnId !== clientMessageId || item.role === "user")
      .map((item) => item.id === clientMessageId
        ? { ...item, id: retryMessageId, turnId: retryMessageId, state: "sending" }
        : item));
    void runTurn(retryMessageId, message.text, history);
  }, [limitReached, messages, runTurn, sending]);

  const submitClarification = useCallback((messageId: string, selectedOptions: string[]) => {
    if (activeRequestRef.current || sending || limitReached || selectedOptions.length === 0) return;
    const reply = selectedOptions.join(", ");
    if (reply.length > MAX_MESSAGE_LENGTH.cold) {
      upsertMessage({
        id: `${messageId}:length-error`,
        role: "assistant",
        text: `This clarification reply is longer than the ${MAX_MESSAGE_LENGTH.cold.toLocaleString()} character limit.`,
        state: "complete",
        kind: "error",
        lane: "cold",
      });
      return;
    }
    setMessages((current) => current.map((message) =>
      message.id === messageId ? { ...message, selectedOptions } : message,
    ));
    send(reply);
  }, [limitReached, send, sending, upsertMessage]);

  const noteVoiceSessionStarted = useCallback(() => {
    setMessages((current) => {
      if (current.length === 0 || current[current.length - 1]?.kind === "divider") return current;
      return [
        ...current,
        {
          id: crypto.randomUUID(),
          role: "system",
          text: "Voice session started. Aura does not carry the text above into this call yet.",
          state: "complete",
          kind: "divider",
        },
      ];
    });
  }, []);

  // ── Chat history panel ───────────────────────────────────────────────────
  // The panel is a view over the same canonical transcript the overlay already
  // hydrates from, so it needs no cache of its own: picking a conversation just
  // re-points hydration at it.

  const refreshSessions = useCallback(() => {
    const currentUid = uidRef.current;
    if (!currentUid) return;
    setSessionsLoading(true);
    setSessionsError(null);
    void (async () => {
      try {
        const page = await listChatSessions(SESSION_PAGE_LIMIT);
        if (uidRef.current !== currentUid) return;
        setSessions(page.sessions);
        setSessionsCursor(page.nextCursor);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          await routeToDashboardForExpiredSession();
          return;
        }
        logError("useChatSession: session list", err);
        // Without this the panel renders "No earlier conversations yet" for a
        // failed request, telling the user their history is gone when it is not.
        if (uidRef.current === currentUid) setSessionsError(HISTORY_FAILED_NOTE);
      } finally {
        if (uidRef.current === currentUid) setSessionsLoading(false);
      }
    })();
  }, []);

  const loadMoreSessions = useCallback(() => {
    const currentUid = uidRef.current;
    if (!currentUid || !sessionsCursor || sessionsLoading) return;
    setSessionsLoading(true);
    void (async () => {
      try {
        const page = await listChatSessions(SESSION_PAGE_LIMIT, sessionsCursor);
        if (uidRef.current !== currentUid) return;
        // Deduped on conversation id: a conversation whose last_activity_at moved
        // between pages would otherwise appear twice.
        setSessions((current) => {
          const seen = new Set(current.map((item) => item.conversationId));
          return [...current, ...page.sessions.filter((item) => !seen.has(item.conversationId))];
        });
        setSessionsCursor(page.nextCursor);
      } catch (err) {
        logError("useChatSession: session page", err);
        if (uidRef.current === currentUid) setSessionsError(HISTORY_FAILED_NOTE);
      } finally {
        if (uidRef.current === currentUid) setSessionsLoading(false);
      }
    })();
  }, [sessionsCursor, sessionsLoading]);

  /** Opens another conversation. Returns whether the switch was accepted.
   *
   * Nothing visible changes until the new transcript is in hand. The old
   * behaviour cleared the transcript and closed the panel up front while the id
   * the composer sends still pointed at the previous conversation, so a message
   * typed during the gap was delivered to the conversation the user had just
   * navigated away from. */
  const selectConversation = useCallback((conversationId: string): boolean => {
    if (!uidRef.current || !conversationId) return false;
    // Refuse mid-turn rather than switching underneath it: the in-flight stream
    // writes into whichever conversation is current when its frames arrive, and
    // its cache row is keyed the same way. ChatSlot also disables the entry
    // points, but a click can beat that state, so the refusal lives here too.
    if (activeRequestRef.current) return false;
    if (conversationId === serverConversationRef.current) return true;

    const selection = ++selectionRef.current;
    selectionControllerRef.current?.abort();
    const controller = new AbortController();
    selectionControllerRef.current = controller;
    setConversationLoading(true);
    setConversationError(null);

    void (async () => {
      try {
        const outcome = await hydrateConversation(conversationId, controller.signal, selection);
        if (selectionRef.current !== selection) return;
        // Never blanked the transcript, so a failure simply leaves the previous
        // conversation on screen with an explanation rather than an empty card.
        if (!outcome.committed) setConversationError(OPEN_FAILED_NOTE);
      } catch (err) {
        if (selectionRef.current !== selection) return;
        if (err instanceof AuthRequiredError) {
          await routeToDashboardForExpiredSession();
          return;
        }
        logError("useChatSession: open conversation", err);
        setConversationError(OPEN_FAILED_NOTE);
      } finally {
        if (selectionRef.current === selection) setConversationLoading(false);
      }
    })();
    return true;
  }, [hydrateConversation]);

  /** Prepends the previous page of a long conversation. Existing bubbles are kept
   * as-is: they may carry live pending or undelivered state the older page knows
   * nothing about. */
  const loadOlderMessages = useCallback(() => {
    const currentUid = uidRef.current;
    const conversationId = serverConversationRef.current;
    if (!currentUid || !conversationId || !olderCursor) return;
    void (async () => {
      try {
        const page = await getChatSession(conversationId, SERVER_PAGE_LIMIT, olderCursor);
        if (!page || uidRef.current !== currentUid) return;
        setOlderCursor(page.olderCursor);
        setMessages((current) => {
          const known = new Set(current.map((message) => message.id));
          const older = page.messages
            .flatMap((message) => fromServerMessage(message, message.status === "failed"))
            .filter((message) => !known.has(message.id));
          // Normalized over the MERGED transcript: a user message on this older
          // page can pair with a failed answer that was already on screen, and
          // deriving failure per row would leave it without Retry.
          return normalizeTurnFailures([...older, ...current]);
        });
      } catch (err) {
        logError("useChatSession: older messages", err);
      }
    })();
  }, [olderCursor]);

  const newConversation = useCallback((): boolean => {
    if (
      !enabledRef.current
      || activeRequestRef.current
    ) return false;

    selectionRef.current += 1;
    selectionControllerRef.current?.abort();
    selectionControllerRef.current = null;
    const conversationId = crypto.randomUUID();
    conversationIdRef.current = conversationId;
    serverConversationRef.current = conversationId;
    setChatConversationId(conversationId);
    setMessages([]);
    setSending(false);
    setLimitReached(false);
    setOlderCursor(null);
    setConversationLoading(false);
    setConversationError(null);
    return true;
  }, []);

  return {
    messages,
    sending,
    limitReached,
    lane,
    send,
    retry,
    submitClarification,
    noteVoiceSessionStarted,
    newConversation,
    hasOlderMessages: olderCursor !== null,
    loadOlderMessages,
    history: {
      sessions,
      loading: sessionsLoading,
      error: sessionsError,
      hasMore: sessionsCursor !== null,
      // Switching conversations mid-turn is refused, so the entry points say so
      // instead of silently doing nothing when clicked.
      locked: sending,
      opening: conversationLoading,
      openError: conversationError,
      refresh: refreshSessions,
      loadMore: loadMoreSessions,
      select: selectConversation,
    },
  };
}
