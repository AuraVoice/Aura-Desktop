/**
 * Interview round profile and the two knobs T1 actually consumes.
 *
 * Pure, no I/O, no React. Everything here is resolved on the desktop BEFORE an
 * answer request is built, which is what makes the round profile shippable
 * without a backend deploy: `InterviewBriefSlice` is `extra="forbid"` on the
 * server, so nothing in this file may ever reach the wire.
 *
 * Segment is derived from the clock alone. Deriving it by matching interviewer
 * speech ("tell me about yourself" -> INTRO) is banned - see
 * ../../Aura/CLAUDE.md and the 2026-08-16 incident in lessons-learnt.text. A
 * word list returns a boolean and cannot abstain, so it is most confident
 * exactly where it is least correct. The sanctioned home for an utterance-aware
 * segment is a `segment` field on the backend's existing GateDecision, which
 * inherits that classifier's confidence and fail-closed threshold.
 */

export type RoundKind =
  | "hr_screen"
  | "technical"
  | "system_design"
  | "behavioral"
  | "hiring_manager"
  | "final_exec";

export type PlannedMinutes = 15 | 30 | 45 | 60;

/**
 * How the live answer is shaped.
 *
 * Every round now resolves to a spoken script the candidate reads almost
 * verbatim, not keyword bullets. The distinction between rounds is register, not
 * layout: conversational for behavioural-adjacent rounds, STAR narration for
 * behavioural, concept-then-tradeoff for technical, and precise structured prose
 * for system design where exact wording carries the answer.
 */
export type AnswerShape =
  | "script_conversational"
  | "script_star"
  | "script_technical"
  | "script_structured";

export type Segment = "intro" | "core" | "wrap";

export interface InterviewProfile {
  roundKind: RoundKind;
  plannedMinutes: PlannedMinutes;
}

export interface SessionClock {
  elapsedMs: number;
  turnIndex: number;
}

export interface AnswerPolicy {
  segment: Segment;
  assemblyMs: number;
}

/**
 * Same-speaker merge debounce per round, in milliseconds.
 *
 * A system design interviewer monologues - "Design a rate limiter ...(1.1s)...
 * for a multi-tenant API with per-customer quotas" - and a short window closes
 * on the fragment, so the answer streams for the wrong question while they are
 * still talking. The cost is real and paid on every turn, not only the long
 * ones: 800ms is +650ms before every answer in that round. The default stays at
 * the shipped 150ms so the added latency is opt-in.
 */
const ASSEMBLY_MS: Record<RoundKind, number> = {
  hr_screen: 0,
  technical: 0,
  system_design: 800,
  behavioral: 300,
  hiring_manager: 300,
  final_exec: 400,
};

/**
 * Answer shape per round, resolved on the desktop and frozen at Start.
 *
 * This travels as a TOP-LEVEL request field, never inside InterviewBriefSlice:
 * that model is `extra="forbid"` on the server, so a field added there would 422
 * every request from a client that shipped ahead of the backend deploy.
 */
const ANSWER_SHAPE: Record<RoundKind, AnswerShape> = {
  hr_screen: "script_conversational",
  technical: "script_technical",
  system_design: "script_structured",
  behavioral: "script_star",
  hiring_manager: "script_conversational",
  final_exec: "script_conversational",
};

export const DEFAULT_ROUND_KIND: RoundKind = "technical";
export const DEFAULT_PLANNED_MINUTES: PlannedMinutes = 30;

export const ROUND_KIND_OPTIONS: Array<{
  value: RoundKind;
  label: string;
  hint: string;
}> = [
  { value: "hr_screen", label: "HR screen", hint: "Recruiter or phone screen" },
  { value: "technical", label: "Technical", hint: "Coding or stack depth" },
  { value: "system_design", label: "System design", hint: "Waits longer before answering" },
  { value: "behavioral", label: "Behavioral", hint: "STAR stories" },
  { value: "hiring_manager", label: "Hiring manager", hint: "Scope and ownership" },
  { value: "final_exec", label: "Final or exec", hint: "Strategy and fit" },
];

export const PLANNED_MINUTES_OPTIONS: Array<{
  value: PlannedMinutes;
  label: string;
}> = [
  { value: 15, label: "15 min" },
  { value: 30, label: "30 min" },
  { value: 45, label: "45 min" },
  { value: 60, label: "60 min" },
];

// One set of ratios feeds both the segment fallback and the pacing caption, so
// the caption can never disagree with the segment the same clock resolved.
const INTRO_RATIO = 0.12;
const WRAP_RATIO = 0.82;
const CLOSING_RATIO = 0.95;
const INTRO_FLOOR_MS = 90_000;
const INTRO_MAX_TURN_INDEX = 3;

export function isRoundKind(value: unknown): value is RoundKind {
  // hasOwnProperty, not `in`: `in` walks the prototype chain, so "toString" and
  // "constructor" would validate as round kinds and then resolve to an
  // undefined debounce.
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(ASSEMBLY_MS, value);
}

export function isPlannedMinutes(value: unknown): value is PlannedMinutes {
  return value === 15 || value === 30 || value === 45 || value === 60;
}

function plannedMs(plannedMinutes: PlannedMinutes): number {
  return plannedMinutes * 60_000;
}

export function assemblyMsFor(roundKind: RoundKind): number {
  // The fallback is not dead code: this value becomes a setTimeout delay, and
  // an undefined delay fires on the next tick, which would flush a half-spoken
  // turn straight into an answer request.
  return ASSEMBLY_MS[roundKind] ?? ASSEMBLY_MS[DEFAULT_ROUND_KIND];
}

export function answerShapeFor(roundKind: RoundKind): AnswerShape {
  return ANSWER_SHAPE[roundKind] ?? ANSWER_SHAPE[DEFAULT_ROUND_KIND];
}

export function resolveSegment(profile: InterviewProfile, clock: SessionClock): Segment {
  const planned = plannedMs(profile.plannedMinutes);
  const introUntil = Math.max(INTRO_FLOOR_MS, planned * INTRO_RATIO);
  if (clock.elapsedMs < introUntil && clock.turnIndex <= INTRO_MAX_TURN_INDEX) return "intro";
  if (clock.elapsedMs > planned * WRAP_RATIO) return "wrap";
  return "core";
}

export function resolvePolicy(profile: InterviewProfile, clock: SessionClock): AnswerPolicy {
  return {
    segment: resolveSegment(profile, clock),
    assemblyMs: assemblyMsFor(profile.roundKind),
  };
}

/**
 * Pacing caption for the overlay header, or null when the round is mid-flight
 * and there is nothing worth saying.
 *
 * The remaining minutes are computed, never hardcoded: 82% of a 15 minute
 * screen leaves about 2 minutes and 82% of a 60 minute panel leaves about 10.
 * A fixed "~3 min left" would be wrong at every duration but one.
 */
export function pacingCaption(
  elapsedMs: number,
  plannedMinutes: PlannedMinutes,
): string | null {
  const planned = plannedMs(plannedMinutes);
  const ratio = elapsedMs / planned;
  if (ratio > 1) return "Over time";
  if (ratio >= CLOSING_RATIO) return "Wrapping up";
  if (ratio >= WRAP_RATIO) {
    const minutesLeft = Math.max(1, Math.round((planned - elapsedMs) / 60_000));
    return `~${minutesLeft} min left. Ask your questions.`;
  }
  // No "Intro" caption. It said nothing the candidate did not already know and
  // occupied the header for the first minutes of every round.
  return null;
}
