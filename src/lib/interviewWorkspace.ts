import { invoke } from "@tauri-apps/api/core";
import { dashboardCacheKey, readCache } from "./dashboardCache";
import type {
  CompanyResearchResult,
  InterviewBrief,
  InterviewBriefClaim,
  InterviewBriefSource,
  InterviewPrepRoom,
  InterviewPreparationInput,
  InterviewProfileGraph,
  InterviewStarStory,
  PracticeMark,
} from "./interviewBrief";
import { isPlannedMinutes, isRoundKind } from "./interviewPolicy";
import type { PlannedMinutes, RoundKind } from "./interviewPolicy";
import { logError } from "./log";

/**
 * Preparations live in the encrypted `interview-preparations.sqlite3` store
 * (Rust `interview_prep_store`), one row per interview, and are read back and
 * validated ONE RECORD AT A TIME. They used to be one JSON key in the dashboard
 * cache with an all-or-nothing loader: a single record failing a shape check
 * made the whole workspace load as empty, the page then built a fresh one and
 * its autosave wrote that over every interview the user had prepared. That key
 * is now read once, as a legacy import, and never written again.
 */
const LEGACY_WORKSPACE_KEY = "interview-companion:workspace:v1";
const WORKSPACE_VERSION = 2;
let mutationQueue: Promise<unknown> = Promise.resolve();

export interface InterviewWorkspaceRecord {
  interviewId: string;
  createdAtMs: number;
  updatedAtMs: number;
  input: InterviewPreparationInput;
  research: CompanyResearchResult | null;
  draftBrief: InterviewBrief | null;
  // Optional, and they must stay optional: a record that fails validation is
  // dropped from the list (and counted in `unreadable`), so requiring a field
  // that older records lack would hide every interview prepared before it.
  //
  // `lastRoundKind` is the picker's remembered default, never the authority.
  // The round chosen at Start is what the session runs as.
  lastRoundKind?: RoundKind;
  plannedMinutes?: PlannedMinutes;
  // Same absent-or-valid rule, with one difference: an invalid value is STRIPPED
  // on load (withoutInvalidPrep) instead of failing the record, because a prep
  // room is regenerable and must never cost the user their interviews.
  prepRoom?: InterviewPrepRoom | null;
  practiceMarks?: Record<string, PracticeMark>;
}

export interface InterviewWorkspace {
  interviews: InterviewWorkspaceRecord[];
  currentInterviewId: string | null;
  activeInterviewId: string | null;
  activeBrief: InterviewBrief | null;
  /** Rows on disk that would not decrypt or validate. Left in place; surfaced
   * so the page can say so rather than pretend they never existed. */
  unreadable?: number;
}

interface PreparationRow {
  interviewId: string;
  updatedAtMs: number;
  body: unknown;
}

interface PreparationWorkspace {
  records: PreparationRow[];
  currentInterviewId: string | null;
  activeInterviewId: string | null;
  unreadable: number;
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

function prepLine(value: unknown): boolean {
  const item = record(value);
  return Boolean(item && typeof item.text === "string" && strings(item.sourceIds));
}

function prepAnswer(value: unknown): boolean {
  const item = record(value);
  if (!item) return false;
  const star = item.star === null ? null : record(item.star);
  return typeof item.answerId === "string"
    && typeof item.question === "string"
    && typeof item.whyTheyAsk === "string"
    && strings(item.whySourceIds)
    && typeof item.storyTitle === "string"
    && (item.star === null || Boolean(star && prepLine(star.situation) && prepLine(star.task) && prepLine(star.action) && prepLine(star.result)))
    && typeof item.spoken === "string"
    && typeof item.followUp === "string"
    && typeof item.followUpHint === "string"
    && (item.avoid === null || prepLine(item.avoid));
}

function prepFit(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item
    && typeof item.fitId === "string"
    && typeof item.requirement === "string"
    && typeof item.evidence === "string"
    && ["strong", "partial", "gap"].includes(String(item.strength))
    && typeof item.bridge === "string"
    && strings(item.sourceIds),
  );
}

function prepRoom(value: unknown): value is InterviewPrepRoom {
  const item = record(value);
  return Boolean(
    item
    && item.contractVersion === 1
    && typeof item.prepId === "string"
    && typeof item.briefId === "string"
    && typeof item.generatedAtMs === "number"
    && Array.isArray(item.companyStory) && item.companyStory.every(prepLine)
    && Array.isArray(item.mustKnows) && item.mustKnows.every(prepLine)
    && Array.isArray(item.answers) && item.answers.every(prepAnswer)
    && Array.isArray(item.fit) && item.fit.every(prepFit)
    && strings(item.neverSay),
  );
}

function practiceMarks(value: unknown): value is Record<string, PracticeMark> {
  const item = record(value);
  return Boolean(item && Object.values(item).every((mark) => mark === "confident" || mark === "work"));
}

function profileNode(value: unknown): boolean {
  const item = record(value);
  return Boolean(
    item
    && typeof item.nodeId === "string"
    && item.nodeId.length > 0
    && typeof item.kind === "string"
    && typeof item.label === "string"
    && typeof item.text === "string"
    && strings(item.sourceIds)
    && typeof item.rank === "number",
  );
}

function profileGraph(value: unknown): value is InterviewProfileGraph {
  const item = record(value);
  if (!item || !Array.isArray(item.nodes) || !Array.isArray(item.edges)) return false;
  if (!item.nodes.every(profileNode)) return false;
  const ids = new Set(item.nodes.map((node) => (node as { nodeId: string }).nodeId));
  return item.edges.every((raw) => {
    const edge = record(raw);
    return edge
      && typeof edge.fromId === "string" && ids.has(edge.fromId)
      && typeof edge.toId === "string" && ids.has(edge.toId)
      && typeof edge.relation === "string";
  });
}

/** Drops a prep room or practice marks that fail validation, a prep room built
 * for a different brief, or a malformed profile graph, before the record check
 * runs. All three are regenerable and must never cost the user the interview. */
function withoutInvalidPrepRecord(raw: unknown): unknown {
  const interview = record(raw);
  if (!interview) return raw;
  const next = { ...interview };
  const brief = record(next.draftBrief);
  if (
    next.prepRoom !== undefined
    && next.prepRoom !== null
    && (!prepRoom(next.prepRoom) || next.prepRoom.briefId !== brief?.briefId)
  ) {
    delete next.prepRoom;
  }
  if (next.practiceMarks !== undefined && !practiceMarks(next.practiceMarks)) delete next.practiceMarks;
  if (brief && brief.profile !== undefined && brief.profile !== null && !profileGraph(brief.profile)) {
    next.draftBrief = { ...brief, profile: null };
  }
  return next;
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

/** Per-record salvage: the records that validate, in the order given, with
 * duplicates by id dropped. Everything else is counted, never fatal. */
function salvageRecords(raw: unknown[]): { interviews: InterviewWorkspaceRecord[]; dropped: number } {
  const interviews: InterviewWorkspaceRecord[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const value of raw) {
    const candidate = withoutInvalidPrepRecord(value);
    if (!interviewRecord(candidate) || seen.has(candidate.interviewId)) {
      dropped += 1;
      continue;
    }
    seen.add(candidate.interviewId);
    interviews.push(candidate);
  }
  return { interviews, dropped };
}

/** Resolves the two meta ids against the records that survived, and derives
 * the active brief from the active record. The brief is never stored twice:
 * the record's reviewed `draftBrief` is the one source, so the store can not
 * disagree with itself the way the old separate `activeBrief` field could. */
function assemble(
  interviews: InterviewWorkspaceRecord[],
  currentInterviewId: string | null,
  activeInterviewId: string | null,
  unreadable: number,
): InterviewWorkspace {
  const ids = new Set(interviews.map((interview) => interview.interviewId));
  const active = activeInterviewId !== null && ids.has(activeInterviewId)
    ? interviews.find((interview) => interview.interviewId === activeInterviewId) ?? null
    : null;
  const activeBrief = active?.draftBrief?.reviewedAtMs != null ? active.draftBrief : null;
  return {
    interviews,
    currentInterviewId: currentInterviewId !== null && ids.has(currentInterviewId) ? currentInterviewId : null,
    activeInterviewId: activeBrief ? activeInterviewId : null,
    activeBrief,
    unreadable,
  };
}

/** The one-time read of the pre-store dashboard-cache key. Never deleted, so a
 * rollback to an older build still finds it; never written again. */
async function loadLegacyWorkspace(uid: string): Promise<InterviewWorkspace | null> {
  const cached = await readCache<unknown>(dashboardCacheKey(uid, LEGACY_WORKSPACE_KEY));
  const item = record(cached?.data);
  if (!item || item.version !== WORKSPACE_VERSION || !Array.isArray(item.interviews)) return null;
  const { interviews, dropped } = salvageRecords(item.interviews);
  if (interviews.length === 0) return null;
  return assemble(
    interviews,
    typeof item.currentInterviewId === "string" ? item.currentInterviewId : null,
    typeof item.activeInterviewId === "string" ? item.activeInterviewId : null,
    dropped,
  );
}

// Change detection for the autosave: InterviewPage saves the whole workspace
// 300 ms after any change, so without this every keystroke in the job
// description would re-seal and rewrite every prepared interview.
const savedHashes = new Map<string, string>();
const savedMeta = new Map<string, string>();

function hashRecord(value: unknown): string {
  const json = JSON.stringify(value) ?? "";
  let h = 0x811c9dc5;
  for (let i = 0; i < json.length; i++) {
    h ^= json.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function hashKey(uid: string, interviewId: string): string {
  return `${uid} ${interviewId}`;
}

function rememberSaved(uid: string, value: InterviewWorkspace): void {
  for (const interview of value.interviews) {
    savedHashes.set(hashKey(uid, interview.interviewId), hashRecord(interview));
  }
  savedMeta.set(uid, `${value.currentInterviewId ?? ""} ${value.activeInterviewId ?? ""}`);
}

export async function loadInterviewWorkspace(uid: string): Promise<InterviewWorkspace | null> {
  const stored = await invoke<PreparationWorkspace>("interview_prep_load", { uid });
  const { interviews, dropped } = salvageRecords(stored.records.map((row) => row.body));
  const unreadable = stored.unreadable + dropped;
  if (interviews.length === 0 && unreadable === 0) {
    const legacy = await loadLegacyWorkspace(uid).catch((error) => {
      logError("interviewWorkspace: legacy import", error);
      return null;
    });
    if (!legacy) return null;
    // Import as a normal save so the records land in the store under their
    // own ids and every later autosave is an ordinary change-detected write.
    await saveInterviewWorkspace(uid, legacy);
    return legacy;
  }
  const workspace = assemble(interviews, stored.currentInterviewId, stored.activeInterviewId, unreadable);
  rememberSaved(uid, workspace);
  return workspace;
}

/** Writes only what changed since the last load or save for this account:
 * changed records are upserted, records that disappeared are deleted, and the
 * meta row is rewritten when either id moved. Serialised so a slow write can
 * never land after a newer one. Resolves false when any write failed. */
export async function saveInterviewWorkspace(uid: string, value: InterviewWorkspace): Promise<boolean> {
  const operation = mutationQueue.then(async () => {
    let ok = true;
    const present = new Set<string>();
    for (const interview of value.interviews) {
      present.add(interview.interviewId);
      const key = hashKey(uid, interview.interviewId);
      const hash = hashRecord(interview);
      if (savedHashes.get(key) === hash) continue;
      try {
        await invoke("interview_prep_upsert", {
          uid,
          interviewId: interview.interviewId,
          updatedAtMs: interview.updatedAtMs,
          body: interview,
        });
        savedHashes.set(key, hash);
      } catch (error) {
        logError("interviewWorkspace: save record", error);
        ok = false;
      }
    }
    const prefix = hashKey(uid, "");
    for (const key of [...savedHashes.keys()]) {
      if (!key.startsWith(prefix)) continue;
      const interviewId = key.slice(prefix.length);
      if (present.has(interviewId)) continue;
      try {
        await invoke("interview_prep_delete", { uid, interviewId });
        savedHashes.delete(key);
      } catch (error) {
        logError("interviewWorkspace: delete record", error);
        ok = false;
      }
    }
    const meta = `${value.currentInterviewId ?? ""} ${value.activeInterviewId ?? ""}`;
    if (savedMeta.get(uid) !== meta) {
      try {
        await invoke("interview_prep_set_meta", {
          uid,
          currentInterviewId: value.currentInterviewId,
          activeInterviewId: value.activeInterviewId,
        });
        savedMeta.set(uid, meta);
      } catch (error) {
        logError("interviewWorkspace: save meta", error);
        ok = false;
      }
    }
    return ok;
  });
  mutationQueue = operation;
  return operation;
}

export async function clearInterviewWorkspace(uid: string): Promise<void> {
  const operation = mutationQueue.then(async () => {
    const stored = await invoke<PreparationWorkspace>("interview_prep_load", { uid });
    for (const row of stored.records) {
      await invoke("interview_prep_delete", { uid, interviewId: row.interviewId });
    }
    await invoke("interview_prep_set_meta", { uid, currentInterviewId: null, activeInterviewId: null });
    const prefix = hashKey(uid, "");
    for (const key of [...savedHashes.keys()]) {
      if (key.startsWith(prefix)) savedHashes.delete(key);
    }
    savedMeta.delete(uid);
  });
  mutationQueue = operation;
  await operation;
}

export async function flushInterviewWorkspaceWrites(): Promise<void> {
  await mutationQueue;
}
