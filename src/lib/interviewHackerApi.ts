import { authFetch } from "./api";
import { readSseFrames } from "./sseStream";
import type { AnswerShape } from "./interviewPolicy";
import { RESUME_MAX_CHARS } from "./resumeText";
import type {
  InterviewAnswerLength,
  InterviewBrief,
  InterviewBriefClaim,
  InterviewBriefSlice,
  InterviewBriefSource,
  InterviewClaimScope,
  InterviewSourceKind,
  InterviewStarStory,
  InterviewVerificationState,
  CompanyResearchCategory,
  CompanyResearchFactStatus,
  CompanyResearchResult,
} from "./interviewBrief";

export interface InterviewTranscriptTurn {
  sessionId: string;
  epoch: number;
  turnId: string;
  source: "candidate" | "remote";
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
  remoteSpeakerId?: string | null;
  speakerOverlap?: boolean;
  finalWordAtMs?: number | null;
}

export type InterviewAnswerAction =
  | "automatic"
  | "suggest"
  | "shorter"
  | "another_example"
  | "more_technical"
  | "screen_sight";

export interface InterviewScreenSightFrame {
  mimeType: "image/jpeg";
  data: string;
  widthPx: number;
  heightPx: number;
  capturedAtMs: number;
}

export interface InterviewReflection {
  summary: string;
  strengths: string[];
  improvements: string[];
  followUpActions: string[];
}

export type InterviewAnswerFrame =
  | {
      type: "decision";
      accepted: boolean;
      gateMs: number | null;
      target: string | null;
      intent: string | null;
    }
  | { type: "answer_delta"; delta: string }
  | { type: "screen_note"; note: string }
  | { type: "answer_done"; generated: boolean; answerMs: number | null }
  | { type: "error"; code: string; message: string }
  | { type: "terminator" };

export interface InterviewCredential {
  accessToken: string;
  openaiAccessToken: string;
  expiresInSeconds: number;
}

/** Thrown when the backend has interview transcription switched off, or is
 * not configured for it. Distinct from an auth failure: retrying will not
 * help and the user is not signed out. Mirrors DictationUnavailableError. */
export class InterviewUnavailableError extends Error {}

/** Below this, a token is not worth using: it would expire before or during
 * the first handshake it was minted for, surfacing as a confusing auth
 * failure mid-connect. Same guard as dictationCredential.ts. */
const MIN_USEFUL_TTL_SECONDS = 15;

export async function mintInterviewCredential(): Promise<InterviewCredential> {
  const response = await authFetch("/interview-companion/stt-token", { method: "POST" });
  if (response.status === 503) {
    throw new InterviewUnavailableError("Interview transcription is unavailable");
  }
  if (!response.ok) {
    throw new Error(`Interview transcription is unavailable (${response.status}).`);
  }
  const body: unknown = await response.json();
  if (!body || typeof body !== "object") {
    throw new Error("Interview transcription returned an invalid credential.");
  }
  const record = body as Record<string, unknown>;
  const accessToken = record.deepgramAccessToken ?? record.accessToken ?? "";
  const openaiAccessToken = record.openaiAccessToken ?? "";
  const expiresInSeconds = record.expiresInSeconds;
  if (
    typeof accessToken !== "string"
    || typeof openaiAccessToken !== "string"
    || (accessToken.trim() === "" && openaiAccessToken.trim() === "")
    || typeof expiresInSeconds !== "number"
    || !Number.isFinite(expiresInSeconds)
    || expiresInSeconds <= 0
  ) {
    throw new Error("Interview transcription returned an invalid credential.");
  }
  if (expiresInSeconds < MIN_USEFUL_TTL_SECONDS) {
    throw new Error("Interview transcription credential expires too soon to be usable.");
  }
  return { accessToken, openaiAccessToken, expiresInSeconds };
}

function wireTurn(turn: InterviewTranscriptTurn) {
  return {
    session_id: turn.sessionId,
    epoch: turn.epoch,
    turn_id: turn.turnId,
    source: turn.source,
    start_ms: turn.startMs,
    end_ms: turn.endMs,
    text: turn.text,
    is_final: turn.isFinal,
    remote_speaker_id: turn.remoteSpeakerId ?? null,
    speaker_overlap: turn.speakerOverlap ?? false,
    final_word_at_ms: turn.finalWordAtMs ?? null,
  };
}

function parseFrame(
  raw: string,
  expected: InterviewTranscriptTurn,
): InterviewAnswerFrame | null {
  const data = raw
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
  if (!data) return null;
  if (data === "[DONE]") return { type: "terminator" };
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    throw new Error("Interview answer stream returned unreadable data.");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Interview answer stream returned invalid data.");
  }
  const frame = payload as Record<string, unknown>;
  if (
    frame.session_id !== expected.sessionId
    || frame.epoch !== expected.epoch
    || frame.turn_id !== expected.turnId
  ) {
    return null;
  }
  switch (frame.type) {
    case "decision":
      return typeof frame.accepted === "boolean"
        ? {
            type: "decision",
            accepted: frame.accepted,
            gateMs: typeof frame.gate_ms === "number" ? frame.gate_ms : null,
            target: typeof frame.target === "string" ? frame.target : null,
            intent: typeof frame.intent === "string" ? frame.intent : null,
          }
        : null;
    case "answer_delta":
      return typeof frame.delta === "string"
        ? { type: "answer_delta", delta: frame.delta }
        : null;
    case "screen_note":
      return typeof frame.note === "string" && frame.note.trim() !== ""
        ? { type: "screen_note", note: frame.note }
        : null;
    case "answer_done":
      if (typeof frame.generated !== "boolean") return null;
      return {
        type: "answer_done",
        generated: frame.generated,
        answerMs: typeof frame.answer_ms === "number" ? frame.answer_ms : null,
      };
    case "error":
      return typeof frame.message === "string"
        ? {
            type: "error",
            code: typeof frame.code === "string" ? frame.code : "stream_error",
            message: frame.message,
          }
        : null;
    default:
      return null;
  }
}

export async function streamInterviewAnswer({
  turn,
  recentTurns,
  brief,
  resume = "",
  answerShape,
  action = "automatic",
  currentAnswer = "",
  screenSight = null,
  screenNotes = [],
  signal,
  onFrame,
}: {
  turn: InterviewTranscriptTurn;
  recentTurns: InterviewTranscriptTurn[];
  brief: InterviewBriefSlice | null;
  /** Raw resume text, sent only when the brief has no candidate evidence to
   *  ground against. Truncated to the backend's own limit. */
  resume?: string;
  answerShape: AnswerShape;
  action?: InterviewAnswerAction;
  currentAnswer?: string;
  screenSight?: InterviewScreenSightFrame | null;
  /** Captions of screens shown earlier this round, so a later question about
   *  "that" still resolves. Bounded by the backend at three. */
  screenNotes?: string[];
  signal: AbortSignal;
  onFrame: (frame: InterviewAnswerFrame) => void;
}): Promise<void> {
  if (turn.source !== "remote" || !turn.isFinal) {
    throw new Error("Only completed remote turns can request an interview answer.");
  }
  const response = await authFetch("/interview-companion/answer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      turn: wireTurn(turn),
      recent_turns: recentTurns.slice(-8).map(wireTurn),
      brief: brief ? wireBriefSlice(brief) : null,
      resume: resume.slice(0, RESUME_MAX_CHARS),
      answer_shape: answerShape,
      action,
      current_answer: currentAnswer,
      screen_notes: screenNotes.slice(-3),
      screen_sight: screenSight ? {
        mime_type: screenSight.mimeType,
        data: screenSight.data,
        width_px: screenSight.widthPx,
        height_px: screenSight.heightPx,
        captured_at_ms: screenSight.capturedAtMs,
      } : null,
    }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Interview answer request failed (${response.status}).`);
  }
  if (!response.body) {
    throw new Error("Interview answer response had no stream.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        const frame = parseFrame(buffer.slice(0, separator), turn);
        buffer = buffer.slice(separator + 2);
        if (frame) {
          onFrame(frame);
          if (frame.type === "terminator") terminated = true;
        }
        separator = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) {
    const frame = parseFrame(buffer, turn);
    if (frame) {
      onFrame(frame);
      if (frame.type === "terminator") terminated = true;
    }
  }
  if (!terminated) {
    throw new Error("Interview answer stream ended early.");
  }
}

const VERIFICATION_STATES = new Set<InterviewVerificationState>(["verified", "unverified"]);
const SOURCE_KINDS = new Set<InterviewSourceKind>([
  "company",
  "role",
  "resume",
  "job_description",
  "candidate_fact",
  "star_story",
  "metric",
  "gap",
  "do_not_claim",
  "company_research",
  "likely_interviewer_question",
]);
const CLAIM_SCOPES = new Set<InterviewClaimScope>(["target", "candidate", "constraint", "practice"]);
const ANSWER_LENGTHS = new Set<InterviewAnswerLength>(["brief", "balanced", "detailed"]);

function wireClaim(claim: InterviewBriefClaim) {
  return {
    claim_id: claim.claimId,
    text: claim.text,
    source_ids: claim.sourceIds,
    verification_state: claim.verificationState,
    scope: claim.scope,
  };
}

function wireStory(story: InterviewStarStory) {
  return {
    story_id: story.storyId,
    title: story.title,
    situation: wireClaim(story.situation),
    task: wireClaim(story.task),
    action: wireClaim(story.action),
    result: wireClaim(story.result),
  };
}

function wireBriefSlice(brief: InterviewBriefSlice) {
  return {
    contract_version: 3,
    brief_id: brief.briefId,
    company: brief.company ? wireClaim(brief.company) : null,
    role: brief.role ? wireClaim(brief.role) : null,
    sources: brief.sources.map((source) => ({
      source_id: source.sourceId,
      kind: source.kind,
      label: source.label,
      verification_state: source.verificationState,
      urls: source.urls,
      as_of: source.asOf,
    })),
    target_facts: brief.targetFacts.map(wireClaim),
    candidate_facts: brief.candidateFacts.map(wireClaim),
    projects: brief.projects.map(wireClaim),
    star_stories: brief.starStories.map(wireStory),
    metrics: brief.metrics.map(wireClaim),
    jd_requirements: brief.jdRequirements.map(wireClaim),
    gaps: brief.gaps.map(wireClaim),
    do_not_claim: brief.doNotClaim.map(wireClaim),
    answer_length: brief.answerLength,
    likely_interviewer_questions: brief.likelyInterviewerQuestions.map(wireClaim),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function parseSource(value: unknown): InterviewBriefSource | null {
  const item = asRecord(value);
  if (!item) return null;
  if (
    typeof item.source_id !== "string"
    || typeof item.kind !== "string"
    || !SOURCE_KINDS.has(item.kind as InterviewSourceKind)
    || typeof item.label !== "string"
    || typeof item.text !== "string"
    || typeof item.verification_state !== "string"
    || !VERIFICATION_STATES.has(item.verification_state as InterviewVerificationState)
    || !Array.isArray(item.urls)
    || !item.urls.every((url) => typeof url === "string")
    || typeof item.as_of !== "string"
  ) return null;
  return {
    sourceId: item.source_id,
    kind: item.kind as InterviewSourceKind,
    label: item.label,
    text: item.text,
    verificationState: item.verification_state as InterviewVerificationState,
    urls: item.urls,
    asOf: item.as_of,
  };
}

function parseClaim(value: unknown, sourceIds: Set<string>): InterviewBriefClaim | null {
  const item = asRecord(value);
  if (!item || typeof item.claim_id !== "string" || typeof item.text !== "string") return null;
  if (
    typeof item.verification_state !== "string"
    || !VERIFICATION_STATES.has(item.verification_state as InterviewVerificationState)
    || typeof item.scope !== "string"
    || !CLAIM_SCOPES.has(item.scope as InterviewClaimScope)
    || !Array.isArray(item.source_ids)
  ) return null;
  const claimSources = item.source_ids.filter((sourceId): sourceId is string =>
    typeof sourceId === "string" && sourceIds.has(sourceId),
  );
  if (claimSources.length === 0 || claimSources.length !== item.source_ids.length) return null;
  return {
    claimId: item.claim_id,
    text: item.text,
    sourceIds: claimSources,
    verificationState: item.verification_state as InterviewVerificationState,
    scope: item.scope as InterviewClaimScope,
  };
}

function parseClaims(value: unknown, sourceIds: Set<string>): InterviewBriefClaim[] | null {
  if (!Array.isArray(value)) return null;
  const claims = value.map((item) => parseClaim(item, sourceIds));
  return claims.every((claim): claim is InterviewBriefClaim => claim !== null) ? claims : null;
}

function parseStory(value: unknown, sourceIds: Set<string>): InterviewStarStory | null {
  const item = asRecord(value);
  if (!item || typeof item.story_id !== "string" || typeof item.title !== "string") return null;
  const situation = parseClaim(item.situation, sourceIds);
  const task = parseClaim(item.task, sourceIds);
  const action = parseClaim(item.action, sourceIds);
  const result = parseClaim(item.result, sourceIds);
  return situation && task && action && result
    ? { storyId: item.story_id, title: item.title, situation, task, action, result }
    : null;
}

function parseInterviewBrief(value: unknown): InterviewBrief {
  const item = asRecord(value);
  if (!item || item.contract_version !== 3 || typeof item.brief_id !== "string") {
    throw new Error("Interview preparation returned an invalid brief.");
  }
  if (!Array.isArray(item.sources)) throw new Error("Interview preparation returned no sources.");
  const sources = item.sources.map(parseSource);
  if (!sources.every((source): source is InterviewBriefSource => source !== null)) {
    throw new Error("Interview preparation returned invalid sources.");
  }
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  if (sourceIds.size !== sources.length) throw new Error("Interview preparation repeated a source ID.");
  const company = item.company === null ? null : parseClaim(item.company, sourceIds);
  const role = item.role === null ? null : parseClaim(item.role, sourceIds);
  const targetFacts = parseClaims(item.target_facts, sourceIds);
  const candidateFacts = parseClaims(item.candidate_facts, sourceIds);
  const projects = parseClaims(item.projects, sourceIds);
  const metrics = parseClaims(item.metrics, sourceIds);
  const jdRequirements = parseClaims(item.jd_requirements, sourceIds);
  const gaps = parseClaims(item.gaps, sourceIds);
  const doNotClaim = parseClaims(item.do_not_claim, sourceIds);
  const likelyInterviewerQuestions = parseClaims(item.likely_interviewer_questions, sourceIds);
  const rawStories = Array.isArray(item.star_stories) ? item.star_stories : null;
  const starStories = rawStories?.map((story) => parseStory(story, sourceIds)) ?? null;
  if (
    (item.company !== null && !company)
    || (item.role !== null && !role)
    || !targetFacts
    || !candidateFacts
    || !projects
    || !metrics
    || !jdRequirements
    || !gaps
    || !doNotClaim
    || !likelyInterviewerQuestions
    || !starStories
    || !starStories.every((story): story is InterviewStarStory => story !== null)
    || typeof item.answer_length !== "string"
    || !ANSWER_LENGTHS.has(item.answer_length as InterviewAnswerLength)
  ) throw new Error("Interview preparation returned unsupported claims.");
  return {
    contractVersion: 3,
    briefId: item.brief_id,
    company,
    role,
    sources,
    targetFacts,
    candidateFacts,
    projects,
    starStories,
    metrics,
    jdRequirements,
    gaps,
    doNotClaim,
    answerLength: item.answer_length as InterviewAnswerLength,
    likelyInterviewerQuestions,
    reviewedAtMs: null,
  };
}

const RESEARCH_CATEGORIES = new Set<CompanyResearchCategory>([
  "background",
  "products_and_business",
  "funding_and_financials",
  "company_size",
  "leadership_and_team",
  "recent_updates",
  "vision_and_strategy",
  "technology_and_ai",
  "role_relevance",
]);
const RESEARCH_STATUSES = new Set<CompanyResearchFactStatus>([
  "confirmed",
  "estimated",
  "conflicting",
]);

function parseCompanyResearch(value: unknown): CompanyResearchResult {
  const item = asRecord(value);
  if (
    !item
    || typeof item.company !== "string"
    || typeof item.website !== "string"
    || typeof item.researched_at !== "string"
    || typeof item.executive_summary !== "string"
    || !Array.isArray(item.sources)
    || !Array.isArray(item.facts)
    || !Array.isArray(item.likely_interviewer_questions)
    || !Array.isArray(item.unknowns)
    || !item.unknowns.every((unknown) => typeof unknown === "string")
  ) throw new Error("Company research returned an invalid dossier.");
  const sources = item.sources.flatMap((value) => {
    const source = asRecord(value);
    return source
      && typeof source.source_id === "string"
      && typeof source.title === "string"
      && typeof source.url === "string"
      ? [{ sourceId: source.source_id, title: source.title, url: source.url }]
      : [];
  });
  if (sources.length !== item.sources.length) {
    throw new Error("Company research returned invalid sources.");
  }
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  const facts = item.facts.flatMap((value) => {
    const fact = asRecord(value);
    if (
      !fact
      || typeof fact.fact_id !== "string"
      || typeof fact.category !== "string"
      || !RESEARCH_CATEGORIES.has(fact.category as CompanyResearchCategory)
      || typeof fact.statement !== "string"
      || typeof fact.status !== "string"
      || !RESEARCH_STATUSES.has(fact.status as CompanyResearchFactStatus)
      || typeof fact.as_of !== "string"
      || !Array.isArray(fact.source_ids)
      || !fact.source_ids.every((sourceId) => typeof sourceId === "string" && sourceIds.has(sourceId))
    ) return [];
    return [{
      factId: fact.fact_id,
      category: fact.category as CompanyResearchCategory,
      statement: fact.statement,
      status: fact.status as CompanyResearchFactStatus,
      asOf: fact.as_of,
      sourceIds: fact.source_ids as string[],
    }];
  });
  const likelyInterviewerQuestions = item.likely_interviewer_questions.flatMap((value) => {
    const question = asRecord(value);
    if (
      !question
      || typeof question.question_id !== "string"
      || typeof question.question !== "string"
      || typeof question.why_likely !== "string"
      || !Array.isArray(question.source_ids)
      || !question.source_ids.every((sourceId) => typeof sourceId === "string" && sourceIds.has(sourceId))
    ) return [];
    return [{
      questionId: question.question_id,
      question: question.question,
      whyLikely: question.why_likely,
      sourceIds: question.source_ids as string[],
    }];
  });
  if (facts.length !== item.facts.length || likelyInterviewerQuestions.length !== item.likely_interviewer_questions.length) {
    throw new Error("Company research returned unsupported evidence.");
  }
  return {
    company: item.company,
    website: item.website,
    researchedAt: item.researched_at,
    executiveSummary: item.executive_summary,
    sources,
    facts,
    likelyInterviewerQuestions,
    unknowns: item.unknowns as string[],
  };
}

export async function researchInterviewCompany({
  company,
  companyUrl,
  role,
  jobDescription,
  signal,
}: {
  company: string;
  companyUrl: string;
  role: string;
  jobDescription: string;
  signal?: AbortSignal;
}): Promise<CompanyResearchResult> {
  const response = await authFetch("/interview-companion/company-research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      company: company.trim(),
      company_url: companyUrl.trim() || null,
      role: role.trim(),
      job_description: jobDescription.trim(),
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Company research failed (${response.status}).`);
  return parseCompanyResearch(await response.json());
}

/** One real hosted-search event from the backend research stream. Every field
 * originates in a provider event, so the UI can present these as fact rather
 * than as an estimate of what might be happening. */
export interface CompanyResearchProgress {
  stage: "started" | "search_started" | "search_done" | "reading" | "writing";
  callId: string;
  query: string;
  urls: string[];
}

function parseResearchProgress(value: unknown): CompanyResearchProgress | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const stage = item.stage;
  if (
    stage !== "started" &&
    stage !== "search_started" &&
    stage !== "search_done" &&
    stage !== "reading" &&
    stage !== "writing"
  ) {
    return null;
  }
  return {
    stage,
    callId: typeof item.call_id === "string" ? item.call_id : "",
    query: typeof item.query === "string" ? item.query : "",
    urls: stringList(item.urls) ?? [],
  };
}

/**
 * Reads an SSE body frame by frame. Split out for the research stream only;
 * streamInterviewAnswer keeps its own copy on purpose, because that path runs
 * during a live interview and is not worth disturbing for tidiness.
 */
async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onFrame: (event: string, data: string) => void,
): Promise<void> {
  await readSseFrames(body, (chunk) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of chunk.split("\n")) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) onFrame(event, dataLines.join("\n"));
  });
}

/**
 * Streams company research, reporting the model's real searches as they happen.
 *
 * Falls back to the plain JSON route when the streaming endpoint is missing, so
 * a desktop build that ships ahead of the backend deploy behaves exactly as it
 * did before rather than failing.
 */
export async function streamInterviewCompanyResearch({
  company,
  companyUrl,
  role,
  jobDescription,
  signal,
  onProgress,
}: {
  company: string;
  companyUrl: string;
  role: string;
  jobDescription: string;
  signal?: AbortSignal;
  onProgress: (progress: CompanyResearchProgress) => void;
}): Promise<CompanyResearchResult> {
  const body = JSON.stringify({
    company: company.trim(),
    company_url: companyUrl.trim() || null,
    role: role.trim(),
    job_description: jobDescription.trim(),
  });

  const response = await authFetch("/interview-companion/company-research/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });

  if (response.status === 404 || response.status === 405) {
    return researchInterviewCompany({ company, companyUrl, role, jobDescription, signal });
  }
  if (!response.ok) throw new Error(`Company research failed (${response.status}).`);
  if (!response.body) throw new Error("Company research response had no stream.");

  // Held in an object so TypeScript keeps the assignment made inside the frame
  // callback, which it would otherwise narrow away on a plain local.
  const collected: { result: CompanyResearchResult | null } = { result: null };
  let streamError = "";
  await readEventStream(response.body, (event, data) => {
    if (data === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "research_progress") {
      const progress = parseResearchProgress(payload);
      if (progress) onProgress(progress);
      return;
    }
    if (event === "research_done") {
      const wrapper = payload as { result?: unknown };
      collected.result = parseCompanyResearch(wrapper.result);
      return;
    }
    if (event === "error") {
      const wrapper = payload as { message?: unknown };
      streamError = typeof wrapper.message === "string" ? wrapper.message : "Company research failed.";
    }
  });

  if (streamError) throw new Error(streamError);
  if (!collected.result) throw new Error("Company research stream ended before a dossier arrived.");
  return collected.result;
}

export async function buildInterviewBrief(
  sources: InterviewBriefSource[],
  answerLength: InterviewAnswerLength,
  signal?: AbortSignal,
): Promise<InterviewBrief> {
  const response = await authFetch("/interview-companion/brief", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contract_version: 3,
      sources: sources.map((source) => ({
        source_id: source.sourceId,
        kind: source.kind,
        label: source.label,
        text: source.text,
        verification_state: source.verificationState,
        urls: source.urls,
        as_of: source.asOf,
      })),
      answer_length: answerLength,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Interview preparation failed (${response.status}).`);
  return parseInterviewBrief(await response.json());
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : null;
}

export async function createInterviewReflection({
  sessionId,
  startedAtMs,
  endedAtMs,
  turns,
  exchanges = [],
  brief,
  signal,
}: {
  sessionId: string;
  startedAtMs: number;
  endedAtMs: number;
  turns: InterviewTranscriptTurn[];
  /** What Aura suggested during the round. Context for the coach, so it can
   *  tell a point the candidate never had from one they did not use. */
  exchanges?: Array<{ question: string; answer: string }>;
  brief: InterviewBriefSlice | null;
  signal?: AbortSignal;
}): Promise<InterviewReflection> {
  const response = await authFetch("/interview-companion/reflection", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contract_version: 1,
      session_id: sessionId,
      started_at_ms: startedAtMs,
      ended_at_ms: endedAtMs,
      turns: turns.filter((turn) => turn.isFinal).slice(-120).map(wireTurn),
      exchanges: exchanges
        .filter((item) => item.question.trim() !== "" && item.answer.trim() !== "")
        .slice(-60)
        .map((item) => ({
          question: item.question.slice(0, 4_000),
          answer: item.answer.slice(0, 4_000),
        })),
      brief: brief ? wireBriefSlice(brief) : null,
    }),
    signal,
  });
  if (!response.ok) throw new Error(`Interview reflection failed (${response.status}).`);
  const item = asRecord(await response.json());
  const strengths = stringList(item?.strengths);
  const improvements = stringList(item?.improvements);
  const followUpActions = stringList(item?.follow_up_actions);
  if (!item || typeof item.summary !== "string" || !strengths || !improvements || !followUpActions) {
    throw new Error("Interview reflection returned an invalid response.");
  }
  return {
    summary: item.summary,
    strengths,
    improvements,
    followUpActions,
  };
}
