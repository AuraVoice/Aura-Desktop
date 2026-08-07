import { authFetch } from "./api";
import { logError } from "./log";
import type { ChatHistoryEntry } from "./chatStream";

// The client-owned conversation id and the text digest that travels with it,
// held at module scope rather than passed through `fetchVoiceToken`. The voice
// start path (useVoiceBar -> voice.ts) and the chat transcript (useChatSession)
// are sibling hooks with no shared ancestor state, and threading the id through
// would change a signature that useVoiceBar's existing tests pin exactly.
//
// Fail-closed: null until useChatSession publishes one, which only happens once
// a user is signed in. With no id, /voice/token is called exactly as it was
// before this feature existed.
let conversationId: string | null = null;
let digestProvider: (() => ChatHistoryEntry[]) | null = null;

export function setChatConversationId(id: string | null): void {
  conversationId = id;
}

export function chatConversationId(): string | null {
  return conversationId;
}

/** useChatSession registers a getter instead of pushing the transcript on every
 * change: streaming deltas rewrite `messages` continuously, and the digest is
 * only ever read once, at voice start. */
export function setTextHandoffProvider(provider: (() => ChatHistoryEntry[]) | null): void {
  digestProvider = provider;
}

// Bounds mirror the voice worker's compaction budget (context_compaction.py):
// SOFT_RETAINED_RAW_TURNS is 8, so seeding 4 exchanges leaves the live call room
// before the first compaction fires, and 1800 chars is 450 tokens at the chars/4
// estimator compaction itself uses, which is exactly MAX_SUMMARY_TOKENS. The
// handoff therefore never costs the session more than one compaction summary.
// The server clamps to the same numbers; these are the courtesy copy.
const MAX_HANDOFF_EXCHANGES = 4;
const MAX_HANDOFF_CHARS_PER_TURN = 600;
const MAX_HANDOFF_CHARS_TOTAL = 1_800;

/** Trims oldest-first and only ever on an exchange boundary, so the agent never
 * reads a reply whose question was dropped. */
export function boundHandoffTurns(turns: ChatHistoryEntry[]): ChatHistoryEntry[] {
  const capped = turns
    .slice(-MAX_HANDOFF_EXCHANGES * 2)
    .map((turn) => ({ role: turn.role, content: turn.content.slice(0, MAX_HANDOFF_CHARS_PER_TURN) }));
  let bounded = capped;
  while (
    bounded.length > 0
    && bounded.reduce((total, turn) => total + turn.content.length, 0) > MAX_HANDOFF_CHARS_TOTAL
  ) {
    bounded = bounded.slice(bounded[0].role === "user" ? 2 : 1);
  }
  return bounded;
}

// The handoff is awaited on the voice start path, so it needs its own deadline:
// `authFetch` has none, and a request that hangs rather than fails would sit on
// the call's cold start until the OS gave up. Voice latency is the whole reason
// the text lane exists, so a slow write is abandoned, not waited on. Matches the
// worker's own PRE_SESSION_FETCH_TIMEOUT_S, which is the budget on the other end
// of this same handoff.
const HANDOFF_TIMEOUT_MS = 1_500;

/** Hands the recent text exchanges to the backend so a voice session started
 * next can load them. Fail-open in every direction: no id, no transcript, a
 * rejected write, or one too slow to be worth waiting for all mean the call
 * still starts, just without text context. */
export async function postTextHandoff(): Promise<void> {
  const id = conversationId;
  if (!id || !digestProvider) return;
  const turns = boundHandoffTurns(digestProvider());
  if (turns.length === 0) return;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), HANDOFF_TIMEOUT_MS);
  try {
    const response = await authFetch("/chat/handoff", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversation_id: id, turns }),
      signal: controller.signal,
    });
    if (!response.ok) {
      logError("chatConversation: handoff rejected", new Error(`HTTP ${response.status}`));
    }
  } catch (err) {
    logError("chatConversation: handoff failed", err);
  } finally {
    clearTimeout(deadline);
  }
}
