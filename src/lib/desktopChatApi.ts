import { authFetch } from "./api";

/**
 * Typed client for the canonical desktop chat transcript.
 *
 * ── BACKEND CONTRACTS (juno-backend) ─────────────────────────────────────────
 *   GET /desktop/chat/sessions?limit&cursor
 *     -> { items: RawChatSession[], next_cursor: string|null }
 *   GET /desktop/chat/sessions/{conversation_id}?limit&before
 *     -> { session: RawChatSession, items: RawChatMessage[], older_cursor }
 *   GET /desktop/chat/pending?limit
 *     -> { items: RawPendingTurn[] }
 *
 * Messages come back NEWEST-page-first and ascending within the page, so one
 * call restores the tail of a conversation rather than its opening. `before`
 * walks backwards through older pages; `older_cursor` is null at the start of
 * history. `limit` must not exceed MAX_MESSAGE_PAGE_SIZE (100) or the backend
 * answers 400, which is why the page size lives here as a constant rather than
 * being passed in ad hoc.
 *
 * The UID is always derived from the verified Firebase token server-side; it is
 * never sent by this client, so one account cannot address another's data.
 *
 * A 404 from any of these means "this backend does not serve chat history yet"
 * (an older revision) or "no such conversation". Both are answered with null
 * rather than an exception, so a Desktop build that is newer than the deployed
 * backend degrades to local-cache-only instead of breaking chat.
 */

/** Mirrors desktop_chat_store.MAX_MESSAGE_PAGE_SIZE. Anything larger is a 400. */
export const MAX_MESSAGE_PAGE_SIZE = 100;
/** Mirrors desktop_chat_store.MAX_SESSION_PAGE_SIZE. */
export const MAX_SESSION_PAGE_SIZE = 50;

export interface DesktopChatSession {
  conversationId: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
  messageCount: number;
  pendingTurnCount: number;
  lastMessagePreview: string;
}

export interface DesktopChatMessage {
  messageId: string;
  clientMessageId: string;
  turnId: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  status: string;
  seq: number;
  createdAt: string | null;
  completedAt: string | null;
  hasAttachments: boolean;
  reminder: Record<string, unknown> | null;
}

export interface DesktopPendingTurn {
  clientMessageId: string;
  conversationId: string;
  status: string;
  createdAt: string | null;
}

interface RawChatSession {
  conversation_id: string;
  created_at: string | null;
  updated_at: string | null;
  last_activity_at: string | null;
  message_count: number;
  pending_turn_count: number;
  last_message_preview: string;
}

interface RawChatMessage {
  message_id: string;
  client_message_id: string;
  turn_id: string;
  conversation_id: string;
  role: string;
  text: string;
  status: string;
  seq: number;
  created_at: string | null;
  completed_at: string | null;
  has_attachments: boolean;
  reminder: Record<string, unknown> | null;
}

interface RawPendingTurn {
  client_message_id: string;
  session_id: string;
  status: string;
  created_at: string | null;
}

/** Returns null on 404 so an older backend revision is a soft degrade. Other
 * non-2xx statuses still throw, because they are real failures worth logging. */
async function authGetJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
  const response = await authFetch(path, signal ? { signal } : undefined);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET ${path} -> HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function toSession(raw: RawChatSession): DesktopChatSession {
  return {
    conversationId: raw.conversation_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    lastActivityAt: raw.last_activity_at,
    messageCount: raw.message_count,
    pendingTurnCount: raw.pending_turn_count,
    lastMessagePreview: raw.last_message_preview ?? "",
  };
}

function toMessage(raw: RawChatMessage): DesktopChatMessage {
  return {
    messageId: raw.message_id,
    clientMessageId: raw.client_message_id,
    turnId: raw.turn_id,
    conversationId: raw.conversation_id,
    role: raw.role === "assistant" ? "assistant" : "user",
    text: raw.text ?? "",
    status: raw.status ?? "",
    seq: raw.seq ?? 0,
    createdAt: raw.created_at,
    completedAt: raw.completed_at,
    hasAttachments: Boolean(raw.has_attachments),
    reminder: raw.reminder ?? null,
  };
}

export interface DesktopChatSessionPage {
  sessions: DesktopChatSession[];
  nextCursor: string | null;
}

export async function listChatSessions(
  limit = 20,
  cursor?: string,
  signal?: AbortSignal,
): Promise<DesktopChatSessionPage> {
  const capped = Math.min(limit, MAX_SESSION_PAGE_SIZE);
  const query = `limit=${capped}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
  const raw = await authGetJson<{
    items: RawChatSession[];
    next_cursor: string | null;
  }>(`/desktop/chat/sessions?${query}`, signal);
  return {
    sessions: (raw?.items ?? []).map(toSession),
    nextCursor: raw?.next_cursor ?? null,
  };
}

export interface DesktopChatTranscript {
  session: DesktopChatSession;
  messages: DesktopChatMessage[];
  /** Cursor for the page of OLDER messages, or null at the start of history. */
  olderCursor: string | null;
}

export async function getChatSession(
  conversationId: string,
  limit = MAX_MESSAGE_PAGE_SIZE,
  before?: string,
  signal?: AbortSignal,
): Promise<DesktopChatTranscript | null> {
  const capped = Math.min(limit, MAX_MESSAGE_PAGE_SIZE);
  const query = `limit=${capped}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  const raw = await authGetJson<{
    session: RawChatSession;
    items: RawChatMessage[];
    older_cursor: string | null;
  }>(`/desktop/chat/sessions/${encodeURIComponent(conversationId)}?${query}`, signal);
  if (!raw) return null;
  return {
    session: toSession(raw.session),
    messages: raw.items.map(toMessage),
    olderCursor: raw.older_cursor,
  };
}

export async function listPendingTurns(
  limit = 20,
  signal?: AbortSignal,
): Promise<DesktopPendingTurn[]> {
  const raw = await authGetJson<{ items: RawPendingTurn[] }>(
    `/desktop/chat/pending?limit=${limit}`,
    signal,
  );
  return (raw?.items ?? []).map((item) => ({
    clientMessageId: item.client_message_id,
    conversationId: item.session_id ?? "",
    status: item.status ?? "",
    createdAt: item.created_at,
  }));
}
