export type InterviewVerificationState = "verified" | "unverified";

export type InterviewAnswerLength = "brief" | "balanced" | "detailed";

export type InterviewSourceKind =
  | "company"
  | "role"
  | "resume"
  | "job_description"
  | "verified_fact"
  | "star_story"
  | "metric"
  | "gap"
  | "do_not_claim"
  | "question_to_ask";

export interface InterviewBriefSource {
  sourceId: string;
  kind: InterviewSourceKind;
  label: string;
  text: string;
  verificationState: InterviewVerificationState;
}

export interface InterviewBriefClaim {
  claimId: string;
  text: string;
  sourceIds: string[];
  verificationState: InterviewVerificationState;
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
  contractVersion: 2;
  briefId: string;
  company: InterviewBriefClaim | null;
  role: InterviewBriefClaim | null;
  sources: InterviewBriefSource[];
  verifiedFacts: InterviewBriefClaim[];
  projects: InterviewBriefClaim[];
  starStories: InterviewStarStory[];
  metrics: InterviewBriefClaim[];
  jdRequirements: InterviewBriefClaim[];
  gaps: InterviewBriefClaim[];
  doNotClaim: InterviewBriefClaim[];
  answerLength: InterviewAnswerLength;
  questionsToAsk: InterviewBriefClaim[];
  reviewedAtMs: number | null;
}

export interface InterviewBriefSlice {
  contractVersion: 2;
  briefId: string;
  company: InterviewBriefClaim | null;
  role: InterviewBriefClaim | null;
  sources: Array<Omit<InterviewBriefSource, "text">>;
  verifiedFacts: InterviewBriefClaim[];
  projects: InterviewBriefClaim[];
  starStories: InterviewStarStory[];
  metrics: InterviewBriefClaim[];
  jdRequirements: InterviewBriefClaim[];
  gaps: InterviewBriefClaim[];
  doNotClaim: InterviewBriefClaim[];
  answerLength: InterviewAnswerLength;
  questionsToAsk: InterviewBriefClaim[];
}

export interface InterviewPreparationInput {
  company: string;
  role: string;
  resume: string;
  jobDescription: string;
  verifiedFacts: string;
  starStories: string;
  metrics: string;
  gaps: string;
  doNotClaim: string;
  answerLength: InterviewAnswerLength;
  questionsToAsk: string;
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

export function preparationSources(input: InterviewPreparationInput): InterviewBriefSource[] {
  const sources: InterviewBriefSource[] = [];
  let nextId = 1;
  const add = (
    kind: InterviewSourceKind,
    label: string,
    text: string,
    verificationState: InterviewVerificationState,
  ) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sources.push({
      sourceId: `source-${nextId++}`,
      kind,
      label,
      text: trimmed,
      verificationState,
    });
  };

  add("company", "Company", input.company, "verified");
  add("role", "Role", input.role, "verified");
  add("resume", "Resume", input.resume, "unverified");
  add("job_description", "Job description", input.jobDescription, "unverified");
  lines(input.verifiedFacts).forEach((text, index) =>
    add("verified_fact", `Verified fact ${index + 1}`, text, "verified"),
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
  lines(input.questionsToAsk).forEach((text, index) =>
    add("question_to_ask", `Question ${index + 1}`, text, "verified"),
  );
  return sources;
}

function claimText(story: InterviewStarStory): string {
  return [story.title, story.situation.text, story.task.text, story.action.text, story.result.text]
    .join(" ");
}

function tokens(value: string): Set<string> {
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

function ranked<T>(items: T[], textOf: (item: T) => string, query: Set<string>, limit: number): T[] {
  return items
    .map((item, index) => ({ item, index, score: relevance(textOf(item), query) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

function verified(items: InterviewBriefClaim[]): InterviewBriefClaim[] {
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
    contractVersion: 2,
    briefId: brief.briefId,
    company: brief.company?.verificationState === "verified" ? brief.company : null,
    role: brief.role?.verificationState === "verified" ? brief.role : null,
    sources: [],
    verifiedFacts: ranked(verified(brief.verifiedFacts), (item) => item.text, query, 6),
    projects: ranked(verified(brief.projects), (item) => item.text, query, 5),
    starStories: ranked(verifiedStories, claimText, query, 4),
    metrics: ranked(verified(brief.metrics), (item) => item.text, query, 6),
    jdRequirements: ranked(verified(brief.jdRequirements), (item) => item.text, query, 6),
    gaps: brief.gaps.slice(0, 8),
    doNotClaim: brief.doNotClaim.slice(0, 8),
    answerLength: brief.answerLength,
    questionsToAsk: verified(brief.questionsToAsk).slice(0, 6),
  };
  const claims = [
    ...(slice.company ? [slice.company] : []),
    ...(slice.role ? [slice.role] : []),
    ...slice.verifiedFacts,
    ...slice.projects,
    ...slice.starStories.flatMap(storyClaims),
    ...slice.metrics,
    ...slice.jdRequirements,
    ...slice.gaps,
    ...slice.doNotClaim,
    ...slice.questionsToAsk,
  ];
  const sourceIds = new Set(claims.flatMap((claim) => claim.sourceIds));
  slice.sources = brief.sources
    .filter((source) => sourceIds.has(source.sourceId))
    .map(({ text: _text, ...source }) => source);
  return slice;
}

export function allBriefClaims(brief: InterviewBrief): InterviewBriefClaim[] {
  return [
    ...(brief.company ? [brief.company] : []),
    ...(brief.role ? [brief.role] : []),
    ...brief.verifiedFacts,
    ...brief.projects,
    ...brief.starStories.flatMap(storyClaims),
    ...brief.metrics,
    ...brief.jdRequirements,
    ...brief.gaps,
    ...brief.doNotClaim,
    ...brief.questionsToAsk,
  ];
}

export function withClaimVerification(
  brief: InterviewBrief,
  claimId: string,
  verificationState: InterviewVerificationState,
): InterviewBrief {
  const update = (claim: InterviewBriefClaim): InterviewBriefClaim =>
    claim.claimId === claimId ? { ...claim, verificationState } : claim;
  const updateStory = (story: InterviewStarStory): InterviewStarStory => ({
    ...story,
    situation: update(story.situation),
    task: update(story.task),
    action: update(story.action),
    result: update(story.result),
  });
  return {
    ...brief,
    company: brief.company ? update(brief.company) : null,
    role: brief.role ? update(brief.role) : null,
    verifiedFacts: brief.verifiedFacts.map(update),
    projects: brief.projects.map(update),
    starStories: brief.starStories.map(updateStory),
    metrics: brief.metrics.map(update),
    jdRequirements: brief.jdRequirements.map(update),
    gaps: brief.gaps.map(update),
    doNotClaim: brief.doNotClaim.map(update),
    questionsToAsk: brief.questionsToAsk.map(update),
  };
}
