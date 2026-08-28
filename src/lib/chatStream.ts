import { authFetch } from "./api";
import { readSseFrames } from "./sseStream";
import type { ChatAttachment } from "./chatScreenCapture";

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  content: string;
}

export interface ChatDoneMetadata {
  tool_names?: unknown[];
  reminder?: Record<string, unknown>;
  awaiting_clarification?: boolean;
  [key: string]: unknown;
}

export type ChatStreamFrame =
  | { type: "text_delta"; delta: string }
  | { type: "tool_thinking"; message: string }
  | { type: "tool_status"; tool: string; message: string }
  | {
      type: "clarification_ui";
      clarification_id: string;
      question: string;
      options: string[];
      multi_select: boolean;
    }
  | { type: "tool_start"; id: string; tool: string; label: string; detail: string }
  | { type: "tool_end"; id: string; tool: string; ok: boolean }
  | { type: "thinking_start" }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "chat_limit_reached"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; metadata: ChatDoneMetadata }
  | { type: "terminator" }
  | { type: "degraded"; message: string };

/** Which frame types this build can parse.
 *
 * Sent to the backend, which emits the v2-only frames (tool_start / tool_end and
 * the thinking trio) ONLY when it sees this. That gate is what makes the rollout
 * safe in both directions: an older client never receives a frame it would turn
 * into a `degraded` error bubble, and a newer client talking to an older backend
 * simply never sees the new frames and falls back to `tool_status`.
 *
 * Bump this only together with the parser below. */
export const CHAT_CONTRACT_VERSION = 3;

/** A non-2xx response from /chat. Distinct from a transport failure so the
 * caller can say what actually went wrong instead of blaming the connection.
 * 401/403 never reach here - authFetch turns those into AuthRequiredError. */
export class ChatRequestError extends Error {
  status: number;

  constructor(status: number) {
    super(`Chat request failed (HTTP ${status})`);
    this.status = status;
  }
}

interface StreamChatRequest {
  message: string;
  history: ChatHistoryEntry[];
  sessionId: string;
  clientMessageId: string;
  /** Screen context for this turn. Never replayed into `history`: the backend
   * strips attachments from stored turns too (see chat_completion/turn_store). */
  attachments?: ChatAttachment[];
  signal?: AbortSignal;
  onOpen?: () => void;
  onFrame: (frame: ChatStreamFrame) => void;
}

function degraded(message: string): ChatStreamFrame {
  return { type: "degraded", message };
}

function parseFrame(rawFrame: string): ChatStreamFrame {
  const dataLines = rawFrame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  if (dataLines.length === 0) {
    return degraded("Aura received an unsupported stream update. The answer may be incomplete.");
  }

  const data = dataLines.join("\n");
  if (data === "[DONE]") return { type: "terminator" };

  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return degraded("Aura received a chat update it could not read. The answer may be incomplete.");
  }
  if (!payload || typeof payload !== "object") {
    return degraded("Aura received an unsupported chat update. The answer may be incomplete.");
  }

  const frame = payload as Record<string, unknown>;
  switch (frame.type) {
    case "text_delta":
      return typeof frame.delta === "string"
        ? { type: "text_delta", delta: frame.delta }
        : degraded("Aura received a malformed text update. The answer may be incomplete.");
    case "tool_thinking":
      return typeof frame.message === "string"
        ? { type: "tool_thinking", message: frame.message }
        : degraded("Aura received a malformed tool update. The answer may be incomplete.");
    case "tool_status":
      return typeof frame.tool === "string" && typeof frame.message === "string"
        ? { type: "tool_status", tool: frame.tool, message: frame.message }
        : degraded("Aura received a malformed tool status. The answer may be incomplete.");
    case "clarification_ui":
      return typeof frame.clarification_id === "string"
        && typeof frame.question === "string"
        && Array.isArray(frame.options)
        && frame.options.every((option) => typeof option === "string")
        && typeof frame.multi_select === "boolean"
        ? {
            type: "clarification_ui",
            clarification_id: frame.clarification_id,
            question: frame.question,
            options: frame.options as string[],
            multi_select: frame.multi_select,
          }
        : degraded("Aura received a malformed clarification. Please reply in the composer instead.");
    case "tool_start":
      return typeof frame.id === "string"
        && typeof frame.tool === "string"
        && typeof frame.label === "string"
        ? {
            type: "tool_start",
            id: frame.id,
            tool: frame.tool,
            label: frame.label,
            // Optional by design: most tools are never allowed to echo an
            // argument, so an absent detail is the normal case, not a defect.
            detail: typeof frame.detail === "string" ? frame.detail : "",
          }
        : degraded("Aura received a malformed tool update. The answer may be incomplete.");
    case "tool_end":
      return typeof frame.id === "string" && typeof frame.tool === "string"
        ? { type: "tool_end", id: frame.id, tool: frame.tool, ok: frame.ok !== false }
        : degraded("Aura received a malformed tool update. The answer may be incomplete.");
    case "thinking_start":
      return { type: "thinking_start" };
    case "thinking_delta":
      return typeof frame.delta === "string"
        ? { type: "thinking_delta", delta: frame.delta }
        : degraded("Aura received a malformed thinking update. The answer may be incomplete.");
    case "thinking_end":
      return { type: "thinking_end" };
    case "chat_limit_reached":
      return typeof frame.message === "string"
        ? { type: "chat_limit_reached", message: frame.message }
        : degraded("Aura received an unreadable chat limit update.");
    case "error":
      return typeof frame.message === "string"
        ? { type: "error", message: frame.message }
        : degraded("Aura reported an unreadable chat error.");
    case "done":
      return frame.metadata && typeof frame.metadata === "object" && !Array.isArray(frame.metadata)
        ? { type: "done", metadata: frame.metadata as ChatDoneMetadata }
        : degraded("Aura received a malformed completion update. The answer may be incomplete.");
    default:
      return degraded(
        `Aura received an unsupported chat update${typeof frame.type === "string" ? ` (${frame.type})` : ""}. The answer may be incomplete.`,
      );
  }
}

export async function streamChat({
  message,
  history,
  sessionId,
  clientMessageId,
  attachments,
  signal,
  onOpen,
  onFrame,
}: StreamChatRequest): Promise<void> {
  const response = await authFetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      history,
      session_id: sessionId,
      client_message_id: clientMessageId,
      surface: "desktop",
      contract_version: CHAT_CONTRACT_VERSION,
      // Omitted entirely when there is nothing to attach, so the text-only
      // request stays byte-identical to what shipped before screen context.
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    }),
    signal,
  });

  // Checked before onOpen: an error response still carries a body, so without
  // this the JSON error payload gets fed to the SSE parser as degraded frames
  // and the turn is optimistically marked sent on the way past.
  if (!response.ok) {
    throw new ChatRequestError(response.status);
  }
  if (!response.body) {
    throw new Error(`Chat response had no stream body (HTTP ${response.status})`);
  }
  onOpen?.();

  let sawTerminator = false;
  await readSseFrames(response.body, (rawFrame) => {
    if (!rawFrame.trim()) return;
    const frame = parseFrame(rawFrame);
    onFrame(frame);
    if (frame.type === "terminator") sawTerminator = true;
  });
  if (!sawTerminator) {
    throw new Error(`Chat stream ended before [DONE] (HTTP ${response.status})`);
  }
}
