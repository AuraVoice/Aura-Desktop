import { AuthRequiredError, authFetchWithTimeout } from "./api";

/**
 * Approval cards for connector writes (juno-backend services/pending_actions.py).
 *
 * A post to LinkedIn or X is only ever PROPOSED by a tool or a draft's Post
 * button. The backend stores the exact arguments and a
 * preview; nothing reaches the provider until the user clicks on the card,
 * which calls approve. The preview shown here always comes from the backend
 * over the user's own token, never from the voice agent's data message, so the
 * card and the executed action cannot disagree.
 */

export type PendingActionTool = "post_to_x" | "post_to_linkedin";

export const PENDING_ACTION_TOOLS: ReadonlySet<string> = new Set<PendingActionTool>([
  "post_to_x",
  "post_to_linkedin",
]);

export type PendingActionStatus =
  | "pending"
  | "executing"
  | "done"
  | "failed"
  | "unknown"
  | "rejected"
  | "expired";

export interface PendingActionPreview {
  text: string;
  chars: number;
  charLimit: number | null;
  hasLink: boolean;
  account: string;
}

export interface PendingAction {
  approvalId: string;
  tool: PendingActionTool;
  connector: "x" | "linkedin";
  title: string;
  status: PendingActionStatus;
  preview: PendingActionPreview;
  createdAt: string;
  expiresAt: string;
  resultUrl: string | null;
  resultReason: string | null;
}

const LIST_TIMEOUT_MS = 10_000;
// Approve waits on the provider call itself, which retries a 429 a few times.
const APPROVE_TIMEOUT_MS = 45_000;
const APPROVAL_ID_RE = /^[0-9a-f]{64}$/;
const STATUSES: ReadonlySet<string> = new Set([
  "pending", "executing", "done", "failed", "unknown", "rejected", "expired",
]);

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function parsePendingAction(raw: unknown): PendingAction | null {
  if (typeof raw !== "object" || raw === null) return null;
  const data = raw as Record<string, unknown>;
  const approvalId = str(data.approval_id);
  const tool = str(data.tool);
  const connector = str(data.connector);
  const status = str(data.status);
  if (
    !APPROVAL_ID_RE.test(approvalId)
    || !PENDING_ACTION_TOOLS.has(tool)
    || (connector !== "x" && connector !== "linkedin")
    || !STATUSES.has(status)
  ) {
    return null;
  }
  const preview = typeof data.preview === "object" && data.preview !== null
    ? data.preview as Record<string, unknown>
    : {};
  const result = typeof data.result === "object" && data.result !== null
    ? data.result as Record<string, unknown>
    : {};
  const url = str(result.url);
  return {
    approvalId,
    tool: tool as PendingActionTool,
    connector,
    title: str(data.title),
    status: status as PendingActionStatus,
    preview: {
      text: str(preview.text),
      chars: typeof preview.chars === "number" ? preview.chars : str(preview.text).length,
      charLimit: typeof preview.char_limit === "number" ? preview.char_limit : null,
      hasLink: preview.has_link === true,
      account: str(preview.account),
    },
    createdAt: str(data.created_at),
    expiresAt: str(data.expires_at),
    // Only an https link is ever handed to openUrl.
    resultUrl: url.startsWith("https://") ? url : null,
    resultReason: str(result.reason) || null,
  };
}

async function readItem(response: Response): Promise<PendingAction | null> {
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`actions request failed (${response.status})`);
  const body = (await response.json()) as { item?: unknown };
  return parsePendingAction(body.item);
}

export async function fetchPendingActions(): Promise<PendingAction[]> {
  const response = await authFetchWithTimeout("/actions/pending", undefined, LIST_TIMEOUT_MS);
  if (response.status === 404) return []; // backend predates approval cards
  if (!response.ok) throw new Error(`GET /actions/pending -> HTTP ${response.status}`);
  const body = (await response.json()) as { items?: unknown };
  return Array.isArray(body.items)
    ? body.items.map(parsePendingAction).filter((item): item is PendingAction => item !== null)
    : [];
}

export async function approvePendingAction(approvalId: string): Promise<PendingAction | null> {
  const response = await authFetchWithTimeout(
    `/actions/${encodeURIComponent(approvalId)}/approve`,
    { method: "POST" },
    APPROVE_TIMEOUT_MS,
  );
  return readItem(response);
}

export async function rejectPendingAction(approvalId: string): Promise<PendingAction | null> {
  const response = await authFetchWithTimeout(
    `/actions/${encodeURIComponent(approvalId)}/reject`,
    { method: "POST" },
    LIST_TIMEOUT_MS,
  );
  return readItem(response);
}

export type ProposeResult =
  | { kind: "proposed"; item: PendingAction }
  | { kind: "notConnected" }
  | { kind: "invalid"; reason: string }
  | { kind: "failed" };

export async function proposeAction(
  tool: PendingActionTool,
  args: Record<string, string>,
  requestId: string,
): Promise<ProposeResult> {
  let response: Response;
  try {
    response = await authFetchWithTimeout(
      "/actions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool, args, request_id: requestId }),
      },
      LIST_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof AuthRequiredError) throw err;
    return { kind: "failed" };
  }
  const body = (await response.json().catch(() => null)) as
    | { item?: unknown; error?: string; reason?: string }
    | null;
  if (response.ok) {
    const item = parsePendingAction(body?.item);
    return item ? { kind: "proposed", item } : { kind: "failed" };
  }
  if (body?.error === "not_connected") return { kind: "notConnected" };
  if (body?.error === "invalid_args") return { kind: "invalid", reason: body.reason ?? "" };
  return { kind: "failed" };
}
