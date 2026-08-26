/**
 * Deterministic "tell me about yourself" pitch, assembled from already-verified
 * claims at Start.
 *
 * Two properties come from doing this locally rather than generating it. It
 * cannot hallucinate, because every line is a claim the user confirmed during
 * brief review and it keeps that claim's source IDs. And it is on screen before
 * anyone speaks, because there is no round trip.
 *
 * Note what this deliberately does NOT do: it does not wait to detect the
 * question. The pitch is valid for the whole session, so a classifier deciding
 * when to show it would be pure risk with no upside - a misfire renders a canned
 * pitch over a real question, and there is no retry in a live round.
 */

import { ranked, tokens, verified } from "./interviewBrief";
import type {
  InterviewBrief,
  InterviewBriefClaim,
  InterviewBriefSource,
} from "./interviewBrief";

export type SelfPitchLineKind = "role" | "candidate_fact" | "metric" | "target_fact";

export interface SelfPitchLine {
  lineId: string;
  kind: SelfPitchLineKind;
  label: string;
  text: string;
  claimId: string;
  sourceIds: string[];
}

export interface SelfPitch {
  lines: SelfPitchLine[];
  sourceIds: string[];
}

const LABELS: Record<SelfPitchLineKind, string> = {
  role: "Framing",
  candidate_fact: "Evidence",
  metric: "Result",
  target_fact: "Why them",
};

function line(kind: SelfPitchLineKind, claim: InterviewBriefClaim): SelfPitchLine {
  return {
    lineId: `${kind}:${claim.claimId}`,
    kind,
    label: LABELS[kind],
    text: claim.text,
    claimId: claim.claimId,
    sourceIds: claim.sourceIds,
  };
}

/**
 * The freshest target fact, by the `asOf` of its backing source.
 *
 * `asOf` lives on InterviewBriefSource, not on InterviewBriefClaim, so recency
 * has to be resolved through the source table rather than read off the claim.
 */
function freshestTargetFact(
  claims: InterviewBriefClaim[],
  sources: Map<string, InterviewBriefSource>,
): InterviewBriefClaim | null {
  let best: InterviewBriefClaim | null = null;
  let bestAsOf = "";
  claims.forEach((claim) => {
    const asOf = claim.sourceIds
      .map((sourceId) => sources.get(sourceId)?.asOf ?? "")
      .reduce((latest, value) => (value > latest ? value : latest), "");
    if (best === null || asOf > bestAsOf) {
      best = claim;
      bestAsOf = asOf;
    }
  });
  return best;
}

/**
 * Build the pitch, or null when the brief has nothing verified to say with.
 *
 * Returning null rather than a role-only pitch is deliberate: a card that says
 * only the job title is an empty shell wearing the costume of preparation.
 */
export function buildSelfPitch(brief: InterviewBrief | null): SelfPitch | null {
  if (!brief) return null;

  // Rank candidate evidence by overlap with the job requirements, the same
  // relevance the live answer path uses to pick a slice.
  const query = tokens(
    [brief.role?.text ?? "", ...brief.jdRequirements.map((claim) => claim.text)].join(" "),
  );
  const facts = ranked(verified(brief.candidateFacts), (claim) => claim.text, query, 2);
  const metrics = ranked(verified(brief.metrics), (claim) => claim.text, query, 1);
  if (facts.length === 0 && metrics.length === 0) return null;

  const sources = new Map(brief.sources.map((source) => [source.sourceId, source]));
  const lines: SelfPitchLine[] = [];
  if (brief.role) lines.push(line("role", brief.role));
  facts.forEach((claim) => lines.push(line("candidate_fact", claim)));
  metrics.forEach((claim) => lines.push(line("metric", claim)));
  const targetFact = freshestTargetFact(brief.targetFacts, sources);
  if (targetFact) lines.push(line("target_fact", targetFact));

  return {
    lines,
    sourceIds: [...new Set(lines.flatMap((item) => item.sourceIds))],
  };
}
