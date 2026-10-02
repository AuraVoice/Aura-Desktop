/** Aura Swarm API: the persisted swarm (juno-backend handlers/swarm.py).
 *
 * The roster, channels, messages, grants, routines and sessions live on the server.
 * The roster still comes back exactly as the backend shaped it (`rosterWire`) next to a
 * camelCase view for rendering, so nothing here can drift from the backend's schema.
 * Managers do real, read-only work in sessions; a session's progress is polled from
 * `GET /swarm/sessions/{id}?rev=` and its messages from the channel cursor.
 */

import { authFetchWithTimeout } from "./api";
import { parsePendingAction, type PendingAction } from "./pendingActions";

/** juno-backend swarm/sandbox.py _MESSAGE_DEADLINE_S (110 s) plus network slack. The
 * backend stops every model call at its own deadline and answers timed_out, so this
 * only fires when the network itself stalls. Raise both together. */
const MESSAGE_TIMEOUT_MS = 130_000;
/** Everything else is a Firestore read or a short transaction. */
const QUICK_TIMEOUT_MS = 20_000;

/** Mirrors juno-backend swarm/models.py Decision and Capability by hand. */
const DECISION_KINDS = ["route", "extend", "new_manager", "not_swarm", "ask", "stop", "reassign"] as const;

export type SwarmDecisionKind = (typeof DECISION_KINDS)[number];

export type SwarmCapability =
  | "none"
  | "buddy_chat"
  | "computer_task"
  | "research_run"
  | "interview_brief";

export interface SwarmSubagent {
  id: string;
  title: string;
  description: string;
  contextScope: string;
  tools: string[];
  isVerifier: boolean;
}

/** A schedule the shaper suggested. Nothing runs until the user enables it. */
export interface SwarmSuggestedRoutine {
  brief: string;
  weekdays: number[];
  hour: number;
  minute: number;
}

export interface SwarmManager {
  id: string;
  title: string;
  description: string;
  owns: string[];
  connectors: string[];
  missingCapabilities: string[];
  approvalBoundary: string;
  subagents: SwarmSubagent[];
  routines: string[];
  suggestedRoutines: SwarmSuggestedRoutine[];
  isCoordinator: boolean;
  status: "active" | "paused";
}

export interface SwarmSupervisor {
  title: string;
  routines: string[];
  status: "active" | "archived";
}

export interface SwarmDraftChoice {
  label: string;
  managerId: string;
}

export interface SwarmDraft {
  id: string;
  text: string;
  question: string;
  choices: SwarmDraftChoice[];
}

export interface SwarmRoster {
  version: number;
  managers: SwarmManager[];
  supervisor: SwarmSupervisor | null;
  frontDoorBacking: "shaper" | "manager" | "supervisor";
  drafts: SwarmDraft[];
  handoverFacts: string[];
}

export interface SwarmAlternative {
  managerId: string;
  why: string;
}

export interface SwarmDecision {
  text: string;
  decision: SwarmDecisionKind;
  targetManagerId: string;
  targetTitle: string;
  subagentTitle: string;
  capability: SwarmCapability;
  confidence: number;
  reason: string;
  alternatives: SwarmAlternative[];
  draftId: string;
  applied: boolean;
  note: string;
  via: "classifier" | "direct" | "answer";
}

export interface SwarmUsage {
  model: string;
  stage: "classifier" | "shaper" | "handover";
  inputTokens: number;
  outputTokens: number;
  costMicrousd: number | null;
}

export interface SwarmRouteResult {
  rosterWire: unknown;
  roster: SwarmRoster;
  decisions: SwarmDecision[];
  events: string[];
  usage: SwarmUsage[];
  /** Sessions a route decision started, or why it could not (refused). */
  sessions: { managerId: string; sessionId: string; refused: string }[];
  /** Set when the message fanned out to several managers at once (a #group round). */
  round: SwarmRoundView | null;
}

/** One manager's place in a #group round. `state` is running, ended or skipped; `endState`
 * is that session's own end (done, partial, failed, cancelled), `reason` why it was skipped. */
export interface SwarmRoundMember {
  managerId: string;
  title: string;
  sessionId: string;
  state: string;
  endState: string;
  stopReason: string;
  reason: string;
}

/** A #group message fanned out to several managers; the Supervisor answers once when every
 * member has ended. `state` runs starting, open, ready, merging, done. */
export interface SwarmRoundView {
  roundId: string;
  state: string;
  stateRevision: number;
  members: SwarmRoundMember[];
}

export interface SwarmMessageRequest {
  clientMessageId: string;
  text: string;
  draftId?: string;
  choiceLabel?: string;
  choiceManagerId?: string;
}

export type SwarmAuthorKind = "user" | "manager" | "aura" | "system";

/** One append-only channel message. `data` is kind-specific and read by the stream. */
export interface SwarmMessage {
  seq: number;
  channelId: string;
  authorKind: SwarmAuthorKind;
  authorId: string;
  kind: string;
  text: string;
  data: Record<string, unknown>;
  sessionId: string;
  at: number;
}

export interface SwarmChannelInfo {
  id: string;
  nextSeq: number;
  lastPreview: string;
}

export interface SwarmRoutine {
  id: string;
  managerId: string;
  brief: string;
  weekdays: number[];
  hour: number;
  minute: number;
  timezone: string;
  enabled: boolean;
  nextRunAt: string;
}

export interface SwarmLiveSession {
  sessionId: string;
  managerId: string;
  state: string;
  stateRevision: number;
}

export interface SwarmState {
  rosterWire: unknown;
  roster: SwarmRoster;
  rosterExists: boolean;
  channels: SwarmChannelInfo[];
  grants: Record<string, string[]>;
  grantable: string[];
  routines: SwarmRoutine[];
  liveSessions: SwarmLiveSession[];
  /** Why managers cannot work right now (models_unset, wallet_exhausted, ...), or "". */
  runtimeProblem: string;
}

export interface SwarmLane {
  id: string;
  kind: "control" | "task";
  state: string;
  n: number;
  goal: string;
  subagentTitle: string;
  note: string;
}

export interface SwarmSessionView {
  sessionId: string;
  managerId: string;
  origin: string;
  state: string;
  phase: string;
  stateRevision: number;
  createdAt: number;
  endedAt: number;
  stopReason: string;
  cancelRequested: boolean;
  question: string;
  lanes: SwarmLane[];
  decisionsUsed: number;
  maxDecisions: number;
  sources: number;
  /** The #group round this session answers for, or empty. */
  roundId: string;
  /** Report draft id (d1..) to the approval it became, when the user pressed Review. */
  draftActions: Record<string, string>;
}

export const TERMINAL_SESSION_STATES: ReadonlySet<string> = new Set(["done", "partial", "failed", "cancelled"]);

/** A refusal the backend explained. `reason` is its stable code (models_unset,
 * wallet_exhausted, manager_busy, timed_out, retries_exhausted, roster_conflict, and the
 * input codes); empty when the body was not the refusal shape. */
export class SwarmRequestError extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`Swarm request failed (${status})`);
    this.name = "SwarmRequestError";
  }
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

function list(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(obj) : [];
}

function ms(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function mapSubagent(raw: Json): SwarmSubagent {
  return {
    id: str(raw.id),
    title: str(raw.title),
    description: str(raw.description),
    contextScope: str(raw.context_scope),
    tools: strings(raw.tools),
    isVerifier: raw.is_verifier === true,
  };
}

function mapManager(raw: Json): SwarmManager {
  return {
    id: str(raw.id),
    title: str(raw.title),
    description: str(raw.description),
    owns: strings(raw.owns),
    connectors: strings(raw.connectors),
    missingCapabilities: strings(raw.missing_capabilities),
    approvalBoundary: str(raw.approval_boundary),
    subagents: list(raw.subagents).map(mapSubagent),
    routines: strings(raw.routines),
    suggestedRoutines: list(raw.suggested_routines).map((r) => ({
      brief: str(r.brief),
      weekdays: numbers(r.weekdays),
      hour: num(r.hour),
      minute: num(r.minute),
    })),
    isCoordinator: raw.is_coordinator === true,
    status: raw.status === "paused" ? "paused" : "active",
  };
}

export function mapRoster(wire: unknown): SwarmRoster {
  const raw = obj(wire);
  const sup = raw.supervisor === null || raw.supervisor === undefined ? null : obj(raw.supervisor);
  const backing = str(raw.front_door_backing);
  return {
    version: num(raw.version),
    managers: list(raw.managers).map(mapManager),
    supervisor: sup
      ? {
          title: str(sup.title) || "Supervisor",
          routines: strings(sup.routines),
          status: sup.status === "archived" ? "archived" : "active",
        }
      : null,
    frontDoorBacking: backing === "manager" || backing === "supervisor" ? backing : "shaper",
    drafts: list(raw.drafts).map((d) => ({
      id: str(d.id),
      text: str(d.text),
      question: str(d.question),
      choices: list(d.choices).map((c) => ({ label: str(c.label), managerId: str(c.manager_id) })),
    })),
    handoverFacts: strings(raw.handover_facts),
  };
}

const CAPABILITIES: readonly string[] = ["none", "buddy_chat", "computer_task", "research_run", "interview_brief"];

function isDecisionKind(value: string): value is SwarmDecisionKind {
  return (DECISION_KINDS as readonly string[]).includes(value);
}

export function mapDecision(raw: Json): SwarmDecision {
  const via = str(raw.via);
  const kind = str(raw.decision);
  // A kind a newer backend added renders as "not a swarm job" with the raw kind in its
  // note, rather than as a label of "undefined".
  const known = isDecisionKind(kind);
  const note = str(raw.note);
  return {
    text: str(raw.text),
    decision: known ? kind : "not_swarm",
    targetManagerId: str(raw.target_manager_id),
    targetTitle: str(raw.target_title),
    subagentTitle: str(raw.subagent_title),
    capability: CAPABILITIES.includes(str(raw.capability)) ? (str(raw.capability) as SwarmCapability) : "none",
    confidence: num(raw.confidence),
    reason: str(raw.reason),
    alternatives: list(raw.alternatives).map((a) => ({ managerId: str(a.manager_id), why: str(a.why) })),
    draftId: str(raw.draft_id),
    applied: raw.applied === true,
    note: known ? note : [`Unrecognised decision "${kind}" from the backend.`, note].filter(Boolean).join(" "),
    via: via === "direct" || via === "answer" ? via : "classifier",
  };
}

function mapUsage(raw: Json): SwarmUsage {
  const stage = str(raw.stage);
  return {
    model: str(raw.model),
    stage: stage === "shaper" || stage === "handover" ? stage : "classifier",
    inputTokens: num(raw.input_tokens),
    outputTokens: num(raw.output_tokens),
    costMicrousd: typeof raw.cost_microusd === "number" ? raw.cost_microusd : null,
  };
}

async function refusalReason(response: Response): Promise<string> {
  try {
    return str(obj(await response.json()).reason);
  } catch {
    return "";
  }
}

async function call(path: string, init: RequestInit = {}, timeoutMs = QUICK_TIMEOUT_MS): Promise<Json> {
  const headers = init.body ? { "Content-Type": "application/json" } : undefined;
  const response = await authFetchWithTimeout(path, { ...init, headers }, timeoutMs);
  if (!response.ok) throw new SwarmRequestError(response.status, await refusalReason(response));
  return obj(await response.json());
}

function mapMessage(raw: Json): SwarmMessage {
  const author = obj(raw.author);
  const kind = str(author.kind);
  return {
    seq: num(raw.seq),
    channelId: str(raw.channel_id),
    authorKind: kind === "user" || kind === "manager" || kind === "aura" ? kind : "system",
    authorId: str(author.id),
    kind: str(raw.kind) || "text",
    text: str(raw.text),
    data: obj(raw.data),
    sessionId: str(raw.session_id),
    at: ms(raw.created_at),
  };
}

function mapRoutine(raw: Json): SwarmRoutine {
  return {
    id: str(raw.id),
    managerId: str(raw.manager_id),
    brief: str(raw.brief),
    weekdays: numbers(raw.weekdays),
    hour: num(raw.hour),
    minute: num(raw.minute),
    timezone: str(raw.timezone),
    enabled: raw.enabled === true,
    nextRunAt: str(raw.next_run_at),
  };
}

function mapSession(raw: Json): SwarmSessionView {
  return {
    sessionId: str(raw.session_id),
    managerId: str(raw.manager_id),
    origin: str(raw.origin),
    state: str(raw.state),
    phase: str(raw.phase),
    stateRevision: num(raw.state_revision),
    createdAt: ms(raw.created_at),
    endedAt: ms(raw.ended_at),
    stopReason: str(raw.stop_reason),
    cancelRequested: raw.cancel_requested === true,
    question: str(raw.question),
    lanes: list(raw.lanes).map((l) => ({
      id: str(l.id),
      kind: l.kind === "task" ? "task" : "control",
      state: str(l.state),
      n: num(l.n),
      goal: str(l.goal),
      subagentTitle: str(l.subagent_title),
      note: str(l.note),
    })),
    decisionsUsed: num(raw.decisions_used),
    maxDecisions: num(raw.max_decisions) || 12,
    sources: num(raw.sources),
    roundId: str(raw.round_id),
    draftActions: Object.fromEntries(
      Object.entries(obj(raw.draft_actions)).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
  };
}

export function mapRoundMember(raw: Json): SwarmRoundMember {
  return {
    managerId: str(raw.manager_id),
    title: str(raw.title),
    sessionId: str(raw.session_id),
    state: str(raw.state),
    endState: str(raw.end_state),
    stopReason: str(raw.stop_reason),
    reason: str(raw.reason),
  };
}

function mapRound(raw: Json): SwarmRoundView {
  return {
    roundId: str(raw.round_id),
    state: str(raw.state),
    stateRevision: num(raw.state_revision),
    members: list(raw.members).map(mapRoundMember),
  };
}

export async function getSwarmState(signal?: AbortSignal): Promise<SwarmState> {
  const body = await call("/swarm/state", { signal });
  const grants: Record<string, string[]> = {};
  for (const [managerId, connectors] of Object.entries(obj(body.grants))) grants[managerId] = strings(connectors);
  return {
    rosterWire: body.roster ?? {},
    roster: mapRoster(body.roster),
    rosterExists: body.roster_exists === true,
    channels: list(body.channels).map((c) => ({ id: str(c.id), nextSeq: num(c.next_seq) || 1, lastPreview: str(c.last_preview) })),
    grants,
    grantable: strings(body.grantable),
    routines: list(body.routines).map(mapRoutine),
    liveSessions: list(body.live_sessions).map((s) => ({
      sessionId: str(s.session_id),
      managerId: str(s.manager_id),
      state: str(s.state),
      stateRevision: num(s.state_revision),
    })),
    runtimeProblem: str(body.runtime_problem),
  };
}

export async function listChannelMessages(
  channelId: string,
  afterSeq: number,
  signal?: AbortSignal,
): Promise<{ messages: SwarmMessage[]; hasMore: boolean }> {
  const body = await call(`/swarm/channels/${encodeURIComponent(channelId)}/messages?after_seq=${afterSeq}&limit=200`, { signal });
  return { messages: list(body.messages).map(mapMessage), hasMore: body.has_more === true };
}

/** #group routing, or the answer to a routing question. DMs go through runManager. */
export async function sendSwarmMessage(req: SwarmMessageRequest): Promise<SwarmRouteResult> {
  const body = await call(
    "/swarm/message",
    {
      method: "POST",
      body: JSON.stringify({
        client_message_id: req.clientMessageId,
        text: req.text,
        draft_id: req.draftId ?? "",
        choice_label: req.choiceLabel ?? "",
        choice_manager_id: req.choiceManagerId ?? "",
      }),
    },
    MESSAGE_TIMEOUT_MS,
  );
  return {
    rosterWire: body.roster ?? {},
    roster: mapRoster(body.roster),
    decisions: list(body.decisions).map(mapDecision),
    events: strings(body.events),
    usage: list(body.usage).map(mapUsage),
    sessions: list(body.sessions).map((s) => ({ managerId: str(s.manager_id), sessionId: str(s.session_id), refused: str(s.refused) })),
    round: body.round && typeof body.round === "object" ? mapRound(obj(body.round)) : null,
  };
}

export async function runManager(
  managerId: string,
  brief: string,
  clientSessionId: string,
  origin: "dm" | "run_now" = "dm",
): Promise<{ sessionId: string; replayed: boolean }> {
  const body = await call(`/swarm/managers/${encodeURIComponent(managerId)}/run`, {
    method: "POST",
    body: JSON.stringify({ brief, client_session_id: clientSessionId, origin }),
  });
  return { sessionId: str(body.session_id), replayed: body.replayed === true };
}

/** `null` means unchanged since `rev`. */
export async function getSession(sessionId: string, rev?: number, signal?: AbortSignal): Promise<SwarmSessionView | null> {
  const query = rev === undefined ? "" : `?rev=${rev}`;
  const body = await call(`/swarm/sessions/${encodeURIComponent(sessionId)}${query}`, { signal });
  return body.unchanged === true ? null : mapSession(body);
}

export async function cancelSession(sessionId: string): Promise<SwarmSessionView> {
  return mapSession(await call(`/swarm/sessions/${encodeURIComponent(sessionId)}/cancel`, { method: "POST" }));
}

/** `null` means unchanged since `rev`. */
export async function getRound(roundId: string, rev?: number, signal?: AbortSignal): Promise<SwarmRoundView | null> {
  const query = rev === undefined ? "" : `?rev=${rev}`;
  const body = await call(`/swarm/rounds/${encodeURIComponent(roundId)}${query}`, { signal });
  return body.unchanged === true ? null : mapRound(body);
}

/** Stop every manager still working on a round; each ends with what it had found. */
export async function cancelRound(roundId: string): Promise<SwarmRoundView> {
  return mapRound(await call(`/swarm/rounds/${encodeURIComponent(roundId)}/cancel`, { method: "POST" }));
}

/** Review on a report draft: the server reads the draft from the session, applies the
 * user's edit and returns the approval to show. Nothing happens until it is approved. */
export async function proposeDraft(
  sessionId: string,
  draftId: string,
  text: string,
): Promise<PendingAction> {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
  const body = await call(
    `/swarm/sessions/${encodeURIComponent(sessionId)}/drafts/${encodeURIComponent(draftId)}/propose`,
    { method: "POST", body: JSON.stringify({ text, timezone }) },
  );
  const item = parsePendingAction(body.item);
  if (!item) throw new SwarmRequestError(502, "invalid_response");
  return item;
}

export async function answerSession(sessionId: string, text: string): Promise<SwarmSessionView> {
  return mapSession(
    await call(`/swarm/sessions/${encodeURIComponent(sessionId)}/answer`, {
      method: "POST",
      body: JSON.stringify({ text }),
    }),
  );
}

export async function setGrants(managerId: string, connectors: string[]): Promise<string[]> {
  const body = await call(`/swarm/managers/${encodeURIComponent(managerId)}/grants`, {
    method: "PUT",
    body: JSON.stringify({ connectors }),
  });
  return strings(body.connectors);
}

export interface SwarmRoutineInput {
  managerId: string;
  brief: string;
  weekdays: number[];
  hour: number;
  minute: number;
  timezone: string;
  enabled: boolean;
}

export async function upsertRoutine(routineId: string, input: SwarmRoutineInput): Promise<SwarmRoutine> {
  return mapRoutine(
    await call(`/swarm/routines/${encodeURIComponent(routineId)}`, {
      method: "PUT",
      body: JSON.stringify({
        manager_id: input.managerId,
        brief: input.brief,
        weekdays: input.weekdays,
        hour: input.hour,
        minute: input.minute,
        timezone: input.timezone,
        enabled: input.enabled,
      }),
    }),
  );
}

export async function deleteRoutine(routineId: string): Promise<void> {
  await call(`/swarm/routines/${encodeURIComponent(routineId)}`, { method: "DELETE" });
}

export interface SwarmImportMessage {
  channelId: string;
  author: "user" | "aura";
  text: string;
  atMs: number;
}

export async function importSandbox(clientImportId: string, rosterWire: unknown, messages: SwarmImportMessage[]): Promise<void> {
  await call(
    "/swarm/import",
    {
      method: "POST",
      body: JSON.stringify({
        client_import_id: clientImportId,
        roster: rosterWire ?? {},
        messages: messages.slice(-400).map((m) => ({
          channel_id: m.channelId,
          author: m.author,
          text: m.text.slice(0, 2000),
          at_ms: m.atMs,
        })),
      }),
    },
    MESSAGE_TIMEOUT_MS,
  );
}

export async function resetSwarm(): Promise<void> {
  await call("/swarm", { method: "DELETE" }, MESSAGE_TIMEOUT_MS);
}
