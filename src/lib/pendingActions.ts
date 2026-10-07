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

export type PendingActionTool = "post_to_x" | "post_to_linkedin" | "swarm_calendar_hold" | "github_create_issue";

export const PENDING_ACTION_TOOLS: ReadonlySet<string> = new Set<PendingActionTool>([
  "post_to_x",
  "post_to_linkedin",
  "swarm_calendar_hold",
  "github_create_issue",
]);

export type PendingActionConnector = "x" | "linkedin" | "google_calendar" | "github";
const CONNECTORS: ReadonlySet<string> = new Set<PendingActionConnector>(["x", "linkedin", "google_calendar", "github"]);

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
  /** Calendar holds only: the event title and its UTC start and end, as booked. */
  eventTitle: string;
  start: string;
  end: string;
  timezone: string;
  /** X only: what the post costs against the X budget, when the backend says. */
  estimatedCostUsd: number | null;
  /** GitHub issues only: the repository, the issue title and its labels. */
  repo: string;
  issueTitle: string;
  labels: string[];
}

export interface PendingAction {
  approvalId: string;
  tool: PendingActionTool;
  connector: PendingActionConnector;
  title: string;
  status: PendingActionStatus;
  preview: PendingActionPreview;
  createdAt: string;
  expiresAt: string;
  resultUrl: string | null;
  resultReason: string | null;
  /** "swarm" for a Swarm report draft's approval, which renders in its report only. */
  origin: string;
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
    || !CONNECTORS.has(connector)
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
    connector: connector as PendingActionConnector,
    title: str(data.title),
    status: status as PendingActionStatus,
    preview: {
      text: str(preview.text),
      chars: typeof preview.chars === "number" ? preview.chars : str(preview.text).length,
      charLimit: typeof preview.char_limit === "number" ? preview.char_limit : null,
      hasLink: preview.has_link === true,
      account: str(preview.account),
      eventTitle: tool === "swarm_calendar_hold" ? str(preview.title) : "",
      start: str(preview.start),
      end: str(preview.end),
      timezone: str(preview.timezone),
      estimatedCostUsd: typeof preview.estimated_cost_usd === "number" ? preview.estimated_cost_usd : null,
      repo: str(preview.repo),
      issueTitle: tool === "github_create_issue" ? str(preview.title) : "",
      labels: Array.isArray(preview.labels) ? preview.labels.filter((l): l is string => typeof l === "string") : [],
    },
    createdAt: str(data.created_at),
    expiresAt: str(data.expires_at),
    // Only an https link is ever handed to openUrl.
    resultUrl: url.startsWith("https://") ? url : null,
    resultReason: str(result.reason) || null,
    origin: str(data.origin) || "chat",
  };
}

export const CONNECTOR_NAMES: Record<PendingActionConnector, string> = {
  x: "X",
  linkedin: "LinkedIn",
  google_calendar: "Google Calendar",
  github: "GitHub",
};

/** What happened after Approve, from the action's own status and result reason. One copy
 * for the overlay card and Swarm's report drafts, so a cause reads the same in both. */
export function pendingActionOutcomeCopy(action: PendingAction): string {
  const name = CONNECTOR_NAMES[action.connector];
  const calendar = action.connector === "google_calendar";
  const issue = action.connector === "github";
  const nothing = calendar ? "Nothing was booked." : issue ? "Nothing was opened." : "Nothing was posted.";
  if (action.status === "done") {
    if (issue) return `Opened in ${action.preview.repo || name}.`;
    return calendar ? `Added to ${name}.` : `Posted to ${name}.`;
  }
  if (action.status === "expired") return "This expired. Ask again to prepare it.";
  if (action.status === "rejected") return `Discarded. ${nothing}`;
  if (action.status === "unknown" || action.status === "executing") {
    return `Aura couldn't confirm it went through. Check ${name} before trying again.`;
  }
  switch (action.resultReason) {
    case "reauthorization_required":
      return `${name} needs to be reconnected. Turn it back on in Connectors.`;
    case "budget_user":
      return `You've reached this month's posting limit for ${name}.`;
    case "budget_global":
      return `Posting to ${name} is paused for now. Try again later.`;
    case "rate_limited":
      return `${name} is limiting requests right now. Try again in a few minutes.`;
    case "permission_pending":
      return "GitHub has to allow Aura to open issues first. Accept the new permission for the Aura app on GitHub, then review it again.";
    case "repo_not_granted":
      return "The Aura app on GitHub cannot see that repository. Add it to the app's repositories, then review it again.";
    default:
      return `${name} didn't accept it. ${nothing}`;
  }
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

export async function fetchPendingAction(approvalId: string): Promise<PendingAction | null> {
  const response = await authFetchWithTimeout(`/actions/${encodeURIComponent(approvalId)}`, undefined, LIST_TIMEOUT_MS);
  return readItem(response);
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
