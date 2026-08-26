import {
  dashboardCacheKey,
  deleteCache,
  readCache,
  writeCache,
} from "./dashboardCache";
import type {
  CompanyResearchResult,
  InterviewBrief,
  InterviewBriefClaim,
  InterviewBriefSource,
  InterviewPreparationInput,
  InterviewStarStory,
} from "./interviewBrief";
import { isPlannedMinutes, isRoundKind } from "./interviewPolicy";
import type { PlannedMinutes, RoundKind } from "./interviewPolicy";

const WORKSPACE_KEY = "interview-companion:workspace:v1";
const WORKSPACE_VERSION = 2;
let mutationQueue: Promise<unknown> = Promise.resolve();

export interface InterviewWorkspaceRecord {
  interviewId: string;
  createdAtMs: number;
  updatedAtMs: number;
  input: InterviewPreparationInput;
  research: CompanyResearchResult | null;
  draftBrief: InterviewBrief | null;
  // Optional, and they must stay optional. `workspace()` below is
  // all-or-nothing: one failed check makes loadInterviewWorkspace return null,
  // InterviewPage builds a fresh workspace, and the next save overwrites every
  // interview the user prepared. Requiring these, or bumping WORKSPACE_VERSION
  // for them, would silently wipe every existing user.
  //
  // `lastRoundKind` is the picker's remembered default, never the authority.
  // The round chosen at Start is what the session runs as.
  lastRoundKind?: RoundKind;
  plannedMinutes?: PlannedMinutes;
}

export interface InterviewWorkspace {
  interviews: InterviewWorkspaceRecord[];
  currentInterviewId: string | null;
  activeInterviewId: string | null;
  activeBrief: InterviewBrief | null;
}

interface StoredInterviewWorkspace extends InterviewWorkspace {
  version: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function preparationInput(value: unknown): value is InterviewPreparationInput {
  const item = record(value);
  return Boolean(
    item
    && typeof item.company === "string"
    && typeof item.companyUrl === "string"
    && typeof item.role === "string"
    && typeof item.resume === "string"
    && typeof item.jobDescription === "string"
    && typeof item.candidateFacts === "string"
    && typeof item.starStories === "string"
    && typeof item.metrics === "string"
    && typeof item.gaps === "string"
    && typeof item.doNotClaim === "string"
    && ["brief", "balanced", "detailed"].includes(String(item.answerLength)),
  );
}

function companyResearch(value: unknown): value is CompanyResearchResult {
  const item = record(value);
  if (
    !item
    || typeof item.company !== "string"
    || typeof item.website !== "string"
    || typeof item.researchedAt !== "string"
    || typeof item.executiveSummary !== "string"
    || !Array.isArray(item.sources)
    || !Array.isArray(item.facts)
    || !Array.isArray(item.likelyInterviewerQuestions)
    || !strings(item.unknowns)
  ) return false;
  return item.sources.every((value) => {
    const source = record(value);
    return source && typeof source.sourceId === "string" && typeof source.title === "string" && typeof source.url === "string";
  }) && item.facts.every((value) => {
    const fact = record(value);
    return fact
      && typeof fact.factId === "string"
      && typeof fact.category === "string"
      && typeof fact.statement === "string"
      && typeof fact.status === "string"
      && typeof fact.asOf === "string"
      && strings(fact.sourceIds);
  }) && item.likelyInterviewerQuestions.every((value) => {
    const question = record(value);
    return question
      && typeof question.questionId === "string"
      && typeof question.question === "string"
      && typeof question.whyLikely === "string"
      && strings(question.sourceIds);
  });
}

// Absent or valid. Absent is the normal case for anything prepared before the
// round profile shipped, and must never fail the record.
function sessionProfile(item: Record<string, unknown>): boolean {
  return (item.lastRoundKind === undefined || isRoundKind(item.lastRoundKind))
    && (item.plannedMinutes === undefined || isPlannedMinutes(item.plannedMinutes));
}

function briefSource(value: unknown): value is InterviewBriefSource {
  const item = record(value);
  return Boolean(
    item
    && typeof item.sourceId === "string"
    && typeof item.kind === "string"
    && typeof item.label === "string"
    && typeof item.text === "string"
    && typeof item.verificationState === "string"
    && strings(item.urls)
    && typeof item.asOf === "string",
  );
}

function briefClaim(value: unknown): value is InterviewBriefClaim {
  const item = record(value);
  return Boolean(
    item
    && typeof item.claimId === "string"
    && typeof item.text === "string"
    && strings(item.sourceIds)
    && typeof item.verificationState === "string"
    && typeof item.scope === "string",
  );
}

function claims(value: unknown): value is InterviewBriefClaim[] {
  return Array.isArray(value) && value.every(briefClaim);
}

function story(value: unknown): value is InterviewStarStory {
  const item = record(value);
  return Boolean(
    item
    && typeof item.storyId === "string"
    && typeof item.title === "string"
    && briefClaim(item.situation)
    && briefClaim(item.task)
    && briefClaim(item.action)
    && briefClaim(item.result),
  );
}

function interviewBrief(value: unknown): value is InterviewBrief {
  const item = record(value);
  if (
    !item
    || item.contractVersion !== 3
    || typeof item.briefId !== "string"
    || !Array.isArray(item.sources)
    || !item.sources.every(briefSource)
    || !(item.company === null || briefClaim(item.company))
    || !(item.role === null || briefClaim(item.role))
    || !claims(item.targetFacts)
    || !claims(item.candidateFacts)
    || !claims(item.projects)
    || !Array.isArray(item.starStories)
    || !item.starStories.every(story)
    || !claims(item.metrics)
    || !claims(item.jdRequirements)
    || !claims(item.gaps)
    || !claims(item.doNotClaim)
    || !claims(item.likelyInterviewerQuestions)
    || !["brief", "balanced", "detailed"].includes(String(item.answerLength))
    || !(item.reviewedAtMs === null || typeof item.reviewedAtMs === "number")
    || !sessionProfile(item)
  ) return false;
  const sourceIds = new Set(item.sources.map((source) => source.sourceId));
  const allClaims = [
    item.company,
    item.role,
    ...item.targetFacts,
    ...item.candidateFacts,
    ...item.projects,
    ...item.metrics,
    ...item.jdRequirements,
    ...item.gaps,
    ...item.doNotClaim,
    ...item.likelyInterviewerQuestions,
    ...item.starStories.flatMap((value) => [value.situation, value.task, value.action, value.result]),
  ].filter((value): value is InterviewBriefClaim => value !== null);
  return allClaims.every((claim) => claim.sourceIds.every((sourceId) => sourceIds.has(sourceId)));
}

function interviewRecord(value: unknown): value is InterviewWorkspaceRecord {
  const item = record(value);
  return Boolean(
    item
    && typeof item.interviewId === "string"
    && item.interviewId.length > 0
    && typeof item.createdAtMs === "number"
    && Number.isFinite(item.createdAtMs)
    && typeof item.updatedAtMs === "number"
    && Number.isFinite(item.updatedAtMs)
    && preparationInput(item.input)
    && (item.research === null || companyResearch(item.research))
    && (item.draftBrief === null || interviewBrief(item.draftBrief))
    && sessionProfile(item),
  );
}

function workspace(value: unknown): value is StoredInterviewWorkspace {
  const item = record(value);
  if (
    !item
    || item.version !== WORKSPACE_VERSION
    || !Array.isArray(item.interviews)
    || !item.interviews.every(interviewRecord)
    || !(item.currentInterviewId === null || typeof item.currentInterviewId === "string")
    || !(item.activeInterviewId === null || typeof item.activeInterviewId === "string")
    || !(item.activeBrief === null || interviewBrief(item.activeBrief))
  ) return false;
  const ids = item.interviews.map((interview) => interview.interviewId);
  const uniqueIds = new Set(ids);
  if (uniqueIds.size !== ids.length) return false;
  if (item.currentInterviewId !== null && !uniqueIds.has(item.currentInterviewId)) return false;
  if (item.activeInterviewId !== null && !uniqueIds.has(item.activeInterviewId)) return false;
  return (item.activeInterviewId === null) === (item.activeBrief === null)
    && (item.activeBrief === null || item.activeBrief.reviewedAtMs !== null);
}

function key(uid: string): string {
  return dashboardCacheKey(uid, WORKSPACE_KEY);
}

export async function loadInterviewWorkspace(uid: string): Promise<InterviewWorkspace | null> {
  const cached = await readCache<unknown>(key(uid));
  if (!cached || !workspace(cached.data)) return null;
  const { interviews, currentInterviewId, activeInterviewId, activeBrief } = cached.data;
  return { interviews, currentInterviewId, activeInterviewId, activeBrief };
}

export async function saveInterviewWorkspace(uid: string, value: InterviewWorkspace): Promise<boolean> {
  const stored: StoredInterviewWorkspace = { version: WORKSPACE_VERSION, ...value };
  const operation = mutationQueue.then(() => writeCache(key(uid), stored, Date.now()));
  mutationQueue = operation;
  return operation;
}

export async function clearInterviewWorkspace(uid: string): Promise<void> {
  const operation = mutationQueue.then(() => deleteCache(key(uid)));
  mutationQueue = operation;
  await operation;
}

export async function flushInterviewWorkspaceWrites(): Promise<void> {
  await mutationQueue;
}
