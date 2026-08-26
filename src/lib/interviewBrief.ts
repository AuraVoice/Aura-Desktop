import type { PlannedMinutes, RoundKind } from "./interviewPolicy";

export type InterviewVerificationState = "verified" | "unverified";

export type InterviewAnswerLength = "brief" | "balanced" | "detailed";

export type InterviewClaimScope = "target" | "candidate" | "constraint" | "practice";

export type InterviewSourceKind =
  | "company"
  | "role"
  | "resume"
  | "job_description"
  | "candidate_fact"
  | "star_story"
  | "metric"
  | "gap"
  | "do_not_claim"
  | "company_research"
  | "likely_interviewer_question";

export type CompanyResearchCategory =
  | "background"
  | "products_and_business"
  | "funding_and_financials"
  | "company_size"
  | "leadership_and_team"
  | "recent_updates"
  | "vision_and_strategy"
  | "technology_and_ai"
  | "role_relevance";

export type CompanyResearchFactStatus = "confirmed" | "estimated" | "conflicting";

export interface CompanyResearchSource {
  sourceId: string;
  title: string;
  url: string;
}

export interface CompanyResearchFact {
  factId: string;
  category: CompanyResearchCategory;
  statement: string;
  status: CompanyResearchFactStatus;
  asOf: string;
  sourceIds: string[];
}

export interface LikelyInterviewerQuestion {
  questionId: string;
  question: string;
  whyLikely: string;
  sourceIds: string[];
}

export interface CompanyResearchResult {
  company: string;
  website: string;
  researchedAt: string;
  executiveSummary: string;
  sources: CompanyResearchSource[];
  facts: CompanyResearchFact[];
  likelyInterviewerQuestions: LikelyInterviewerQuestion[];
  unknowns: string[];
}

export interface InterviewBriefSource {
  sourceId: string;
  kind: InterviewSourceKind;
  label: string;
  text: string;
  verificationState: InterviewVerificationState;
  urls: string[];
  asOf: string;
}

export interface InterviewBriefClaim {
  claimId: string;
  text: string;
  sourceIds: string[];
  verificationState: InterviewVerificationState;
  scope: InterviewClaimScope;
}

export interface InterviewStarStory {
  storyId: string;
  title: string;
  situation: InterviewBriefClaim;
  task: InterviewBriefClaim;
  action: InterviewBriefClaim;
  result: InterviewBriefClaim;
}

export interface InterviewBrief {
  contractVersion: 3;
  briefId: string;
  company: InterviewBriefClaim | null;
  role: InterviewBriefClaim | null;
  sources: InterviewBriefSource[];
  targetFacts: InterviewBriefClaim[];
  candidateFacts: InterviewBriefClaim[];
  projects: InterviewBriefClaim[];
  starStories: InterviewStarStory[];
  metrics: InterviewBriefClaim[];
  jdRequirements: InterviewBriefClaim[];
  gaps: InterviewBriefClaim[];
  doNotClaim: InterviewBriefClaim[];
  answerLength: InterviewAnswerLength;
  likelyInterviewerQuestions: InterviewBriefClaim[];
  reviewedAtMs: number | null;
  // Session profile carried on the brief envelope, NOT evidence.
  //
  // The overlay never sees InterviewWorkspaceRecord, and the Rust brief slot
  // stores the brief as an opaque serde_json::Value, so the envelope is the one
  // channel that already reaches the overlay without new plumbing. Both are
  // optional: a brief prepared before this shipped has neither.
  //
  // `lastRoundKind` is a remembered default for the preflight picker and is
  // NEVER the authority - the round chosen at Start is. If T2 lifts a round
  // into the slice it must read the session value, or a session running as
  // system_design gets briefed as whatever the record last remembered, with no
  // error and no log.
  //
  // Neither field may be added to InterviewBriefSlice: the backend model is
  // extra="forbid" and an unknown key is a 422 on every turn.
  lastRoundKind?: RoundKind;
  plannedMinutes?: PlannedMinutes;
}

export interface InterviewBriefSlice {
  contractVersion: 3;
  briefId: string;
  company: InterviewBriefClaim | null;
  role: InterviewBriefClaim | null;
  sources: Array<Omit<InterviewBriefSource, "text">>;
  targetFacts: InterviewBriefClaim[];
  candidateFacts: InterviewBriefClaim[];
  projects: InterviewBriefClaim[];
  starStories: InterviewStarStory[];
  metrics: InterviewBriefClaim[];
  jdRequirements: InterviewBriefClaim[];
  gaps: InterviewBriefClaim[];
  doNotClaim: InterviewBriefClaim[];
  answerLength: InterviewAnswerLength;
  likelyInterviewerQuestions: InterviewBriefClaim[];
}

export interface InterviewPreparationInput {
  company: string;
  companyUrl: string;
  role: string;
  resume: string;
  jobDescription: string;
  candidateFacts: string;
  starStories: string;
  metrics: string;
  gaps: string;
  doNotClaim: string;
  answerLength: InterviewAnswerLength;
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
}

function storyBlocks(value: string): string[] {
  return value
    .split(/(?:\r?\n){2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function preparationSources(
  input: InterviewPreparationInput,
  research: CompanyResearchResult,
): InterviewBriefSource[] {
  const sources: InterviewBriefSource[] = [];
  let nextId = 1;
  const add = (
    kind: InterviewSourceKind,
    label: string,
    text: string,
    verificationState: InterviewVerificationState,
    urls: string[] = [],
    asOf = "",
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sources.push({
      sourceId: `source-${nextId++}`,
      kind,
      label,
      text: trimmed,
      verificationState,
      urls,
      asOf,
    });
  };
  const researchSourceById = new Map(
    research.sources.map((source) => [source.sourceId, source]),
  );
  const urlsFor = (sourceIds: string[]) => sourceIds.flatMap((sourceId) => {
    const source = researchSourceById.get(sourceId);
    return source ? [source.url] : [];
  });

  add("company", "Target company", research.company || input.company, "verified");
  add("role", "Target role", input.role, "verified");
  add("resume", "Resume", input.resume, "unverified");
  add("job_description", "Job description", input.jobDescription, "unverified");
  research.facts.forEach((fact) => add(
    "company_research",
    fact.category.replace(/_/g, " "),
    fact.statement,
    "verified",
    urlsFor(fact.sourceIds),
    fact.asOf,
  ));
  research.likelyInterviewerQuestions.forEach((question) => add(
    "likely_interviewer_question",
    "Question the interviewer may ask",
    question.question,
    "verified",
    urlsFor(question.sourceIds),
  ));
  lines(input.candidateFacts).forEach((text, index) =>
    add("candidate_fact", `Candidate highlight ${index + 1}`, text, "unverified"),
  );
  storyBlocks(input.starStories).forEach((text, index) =>
    add("star_story", `STAR story ${index + 1}`, text, "unverified"),
  );
  lines(input.metrics).forEach((text, index) =>
    add("metric", `Metric ${index + 1}`, text, "unverified"),
  );
  lines(input.gaps).forEach((text, index) =>
    add("gap", `Gap ${index + 1}`, text, "verified"),
  );
  lines(input.doNotClaim).forEach((text, index) =>
    add("do_not_claim", `Do not claim ${index + 1}`, text, "verified"),
  );
  return sources;
}

function claimText(story: InterviewStarStory): string {
  return [story.title, story.situation.text, story.task.text, story.action.text, story.result.text]
    .join(" ");
}

export function tokens(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((token) => token.length > 2),
  );
}

function relevance(value: string, queryTokens: Set<string>): number {
  const valueTokens = tokens(value);
  let overlap = 0;
  valueTokens.forEach((token) => {
    if (queryTokens.has(token)) overlap += 1;
  });
  return overlap / Math.sqrt(Math.max(1, valueTokens.size));
}

export function ranked<T>(items: T[], textOf: (item: T) => string, query: Set<string>, limit: number): T[] {
  return items
    .map((item, index) => ({ item, index, score: relevance(textOf(item), query) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

export function verified(items: InterviewBriefClaim[]): InterviewBriefClaim[] {
  return items.filter((item) => item.verificationState === "verified");
}

function verifiedStory(story: InterviewStarStory): boolean {
  return [story.situation, story.task, story.action, story.result]
    .every((claim) => claim.verificationState === "verified");
}

function storyClaims(story: InterviewStarStory): InterviewBriefClaim[] {
  return [story.situation, story.task, story.action, story.result];
}

export function relevantInterviewBriefSlice(
  brief: InterviewBrief | null,
  question: string,
  recentText: string,
): InterviewBriefSlice | null {
  if (!brief || brief.reviewedAtMs === null) return null;
  const query = tokens(`${question} ${recentText}`);
  const verifiedStories = brief.starStories.filter(verifiedStory);
  const slice: InterviewBriefSlice = {
    contractVersion: 3,
    briefId: brief.briefId,
    company: brief.company,
    role: brief.role,
    sources: [],
    targetFacts: ranked(brief.targetFacts, (item) => item.text, query, 8),
    candidateFacts: ranked(verified(brief.candidateFacts), (item) => item.text, query, 6),
    projects: ranked(verified(brief.projects), (item) => item.text, query, 5),
    starStories: ranked(verifiedStories, claimText, query, 4),
    metrics: ranked(verified(brief.metrics), (item) => item.text, query, 6),
    jdRequirements: ranked(brief.jdRequirements, (item) => item.text, query, 6),
    gaps: brief.gaps.slice(0, 8),
    doNotClaim: brief.doNotClaim.slice(0, 8),
    answerLength: brief.answerLength,
    likelyInterviewerQuestions: [],
  };
  const claims = [
    ...(slice.company ? [slice.company] : []),
    ...(slice.role ? [slice.role] : []),
    ...slice.targetFacts,
    ...slice.candidateFacts,
    ...slice.projects,
    ...slice.starStories.flatMap(storyClaims),
    ...slice.metrics,
    ...slice.jdRequirements,
    ...slice.gaps,
    ...slice.doNotClaim,
  ];
  const sourceIds = new Set(claims.flatMap((claim) => claim.sourceIds));
  slice.sources = brief.sources
    .filter((source) => sourceIds.has(source.sourceId))
    .map(({ text: _text, ...source }) => source);
  return slice;
}

export function candidateBriefClaims(brief: InterviewBrief): InterviewBriefClaim[] {
  return [
    ...brief.candidateFacts,
    ...brief.projects,
    ...brief.starStories.flatMap(storyClaims),
    ...brief.metrics,
  ];
}

export function withCandidateVerification(
  brief: InterviewBrief,
  claimId: string,
  verificationState: InterviewVerificationState,
): InterviewBrief {
  const update = (claim: InterviewBriefClaim): InterviewBriefClaim =>
    claim.scope === "candidate" && claim.claimId === claimId
      ? { ...claim, verificationState }
      : claim;
  const updateStory = (story: InterviewStarStory): InterviewStarStory => ({
    ...story,
    situation: update(story.situation),
    task: update(story.task),
    action: update(story.action),
    result: update(story.result),
  });
  return {
    ...brief,
    candidateFacts: brief.candidateFacts.map(update),
    projects: brief.projects.map(update),
    starStories: brief.starStories.map(updateStory),
    metrics: brief.metrics.map(update),
  };
}
