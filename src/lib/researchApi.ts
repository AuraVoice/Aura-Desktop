/** Authenticated Background Research API.
 *
 * Wire objects stay snake_case here and are mapped into client-owned camelCase
 * values before the dashboard sees them. Raw page bodies and source excerpts
 * never enter this client; only the persisted brief and bounded citation data do.
 */

import { authFetch, authGetJson } from "./api";

export type ResearchState =
  | "planning"
  | "awaiting_clarification"
  | "queued"
  | "searching"
  | "reading"
  | "verifying"
  | "synthesizing"
  | "ready"
  | "partial"
  | "failed"
  | "cancelled";

export interface ResearchEvidence {
  url: string;
  excerpt: string;
  sourceClass: string;
}

export interface ResearchClaim {
  claimId: string;
  text: string;
  confidence: string;
  evidence: ResearchEvidence[];
}

export interface ResearchActivitySource {
  sourceId: string;
  query: string;
  title: string;
  domain: string;
  url: string;
  finalUrl: string;
  state: string;
  readState: string;
  sourceClass: string;
  candidateCount: number;
  gapReason: string;
  injectionSuspected: boolean;
}

export interface ResearchActivity {
  runId: string;
  state: ResearchState;
  processingStage: string;
  stateRevision: number;
  sourceCount: number;
  claimCount: number;
  updatedAt: string;
  sources: ResearchActivitySource[];
}

export interface ResearchRun {
  runId: string;
  request: string;
  preset: "quick";
  state: ResearchState;
  processingStage: string;
  failureCode: string;
  pendingQuestion: {
    question_id?: string;
    text?: string;
    choices?: string[];
    default_assumptions?: string[];
  };
  currentPlanVersion: number;
  admittedPlanVersion: number;
  autoAdmitRequested: boolean;
  brief: {
    executive_summary?: string;
    sections?: Array<{ heading?: string; statements?: Array<{ text?: string; claim_ids?: string[] }> }>;
    disclaimers?: string[];
  };
  gaps: Array<{ reason?: string; detail?: string }>;
  sourceCount: number;
  claimCount: number;
  createdAt: string;
  updatedAt: string;
  plan: {
    objective: string;
    assumptions: string[];
    subQuestions: Array<{ sub_question_id?: string; text?: string; must_answer?: boolean }>;
  };
  claims: ResearchClaim[];
}

interface RawResearchRun {
  run_id?: unknown;
  request?: unknown;
  preset?: unknown;
  state?: unknown;
  processing_stage?: unknown;
  failure_code?: unknown;
  pending_question?: unknown;
  current_plan_version?: unknown;
  admitted_plan_version?: unknown;
  auto_admit_requested?: unknown;
  brief?: unknown;
  gaps?: unknown;
  source_count?: unknown;
  claim_count?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  plan?: unknown;
  claims?: unknown;
}

interface RawResearchActivity {
  run_id?: unknown;
  state?: unknown;
  processing_stage?: unknown;
  state_revision?: unknown;
  source_count?: unknown;
  claim_count?: unknown;
  updated_at?: unknown;
  sources?: unknown;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapRun(raw: RawResearchRun): ResearchRun {
  const plan = object(raw.plan);
  const claims = Array.isArray(raw.claims) ? raw.claims.map((item) => {
    const claim = object(item);
    return {
      claimId: String(claim.claim_id ?? ""),
      text: String(claim.text ?? ""),
      confidence: String(claim.confidence ?? ""),
      evidence: Array.isArray(claim.evidence) ? claim.evidence.map((entry) => {
        const evidence = object(entry);
        return {
          url: String(evidence.url ?? ""),
          excerpt: String(evidence.excerpt ?? ""),
          sourceClass: String(evidence.source_class ?? ""),
        };
      }) : [],
    };
  }) : [];
  return {
    runId: String(raw.run_id ?? ""),
    request: String(raw.request ?? ""),
    preset: "quick",
    state: String(raw.state ?? "failed") as ResearchState,
    processingStage: String(raw.processing_stage ?? ""),
    failureCode: String(raw.failure_code ?? ""),
    pendingQuestion: object(raw.pending_question),
    currentPlanVersion: Number(raw.current_plan_version ?? 0),
    admittedPlanVersion: Number(raw.admitted_plan_version ?? 0),
    autoAdmitRequested: raw.auto_admit_requested === true,
    brief: object(raw.brief) as ResearchRun["brief"],
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map(object) : [],
    sourceCount: Number(raw.source_count ?? 0),
    claimCount: Number(raw.claim_count ?? 0),
    createdAt: String(raw.created_at ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
    plan: {
      objective: String(plan.objective ?? ""),
      assumptions: stringArray(plan.assumptions),
      subQuestions: Array.isArray(plan.sub_questions) ? plan.sub_questions.map(object) : [],
    },
    claims,
  };
}

async function request(path: string, init?: RequestInit): Promise<ResearchRun> {
  const response = await authFetch(path, init);
  if (!response.ok) throw new Error(`Research request failed (${response.status})`);
  return mapRun(await response.json() as RawResearchRun);
}

export async function startResearch(text: string, signal?: AbortSignal): Promise<ResearchRun> {
  return request("/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ request: text, depth: "quick", client_run_id: crypto.randomUUID(), origin_surface: "dashboard" }),
    signal,
  });
}

export async function listResearchRuns(signal?: AbortSignal): Promise<ResearchRun[]> {
  const body = await authGetJson<{ items?: RawResearchRun[] }>("/research?limit=20", {
    signal,
    errorPrefix: "Research list failed",
  });
  return Array.isArray(body.items) ? body.items.map(mapRun) : [];
}

export function getResearchRun(runId: string, signal?: AbortSignal): Promise<ResearchRun> {
  return request(`/research/${encodeURIComponent(runId)}`, { signal });
}

export async function getResearchActivity(runId: string, signal?: AbortSignal): Promise<ResearchActivity> {
  const raw = await authGetJson<RawResearchActivity>(
    `/research/${encodeURIComponent(runId)}/activity`,
    { signal, errorPrefix: "Research activity failed" },
  );
  return {
    runId: String(raw.run_id ?? ""),
    state: String(raw.state ?? "failed") as ResearchState,
    processingStage: String(raw.processing_stage ?? ""),
    stateRevision: Number(raw.state_revision ?? 0),
    sourceCount: Number(raw.source_count ?? 0),
    claimCount: Number(raw.claim_count ?? 0),
    updatedAt: String(raw.updated_at ?? ""),
    sources: Array.isArray(raw.sources) ? raw.sources.map((item) => {
      const source = object(item);
      return {
        sourceId: String(source.source_id ?? ""),
        query: String(source.query ?? ""),
        title: String(source.title ?? ""),
        domain: String(source.domain ?? ""),
        url: String(source.url ?? ""),
        finalUrl: String(source.final_url ?? ""),
        state: String(source.state ?? "pending"),
        readState: String(source.read_state ?? ""),
        sourceClass: String(source.source_class ?? "unknown"),
        candidateCount: Number(source.candidate_count ?? 0),
        gapReason: String(source.gap_reason ?? ""),
        injectionSuspected: source.injection_suspected === true,
      };
    }) : [],
  };
}

export function cancelResearch(runId: string): Promise<ResearchRun> {
  return request(`/research/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
}

export function answerResearch(
  runId: string,
  questionId: string,
  answerText: string,
): Promise<ResearchRun> {
  return request(`/research/${encodeURIComponent(runId)}/answer`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      question_id: questionId,
      answer: { text: answerText, via: "dashboard" },
    }),
  });
}

export async function deleteResearch(runId: string): Promise<void> {
  const response = await authFetch(`/research/${encodeURIComponent(runId)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`Research deletion failed (${response.status})`);
}
