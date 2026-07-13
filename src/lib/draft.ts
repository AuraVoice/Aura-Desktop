import { authFetch } from "./api";

/** Buddy Drafts client contract, mirroring the worker's data-channel payloads
 * and POST /desktop/draft-outbound/refine. The card refines over REST on every
 * chip tap (during and after a call, one code path); new drafts only ever come
 * from the voice tool over the data channel. The backend persists the latest
 * version of every draft for the dashboard (7-day expiry), so the refine body
 * carries the worker-minted draft_id and a successful refine updates the
 * stored copy too. */

export type DraftChannel = "email_reply" | "cold_dm" | "snippet";
export type DraftLength = "short" | "medium" | "detailed";
export type RefineChip = "shorter" | "longer" | "more_formal" | "warmer" | "regenerate";
export type ArtifactKind =
  | "command"
  | "code"
  | "config"
  | "prompt"
  | "steps"
  | "checklist"
  | "note";
export type DraftContentFormat = "plain_text" | "code" | "markdown";

const REFINE_TIMEOUT_MS = 15_000;

const LENGTH_LADDER: readonly DraftLength[] = ["short", "medium", "detailed"];

/** One step along short <-> medium <-> detailed; null at either end (the card
 * disables the chip there). */
export function steppedLength(current: DraftLength, direction: 1 | -1): DraftLength | null {
  const index = LENGTH_LADDER.indexOf(current) + direction;
  return LENGTH_LADDER[index] ?? null;
}

/** What each chip asks the model to do. Shorter/longer lean on the target
 * length the request already carries; the wording chips carry the instruction.
 * Snippets only ever show regenerate, with its own wording (a command has no
 * "angle", it has alternative valid approaches). */
const CHIP_INSTRUCTIONS: Record<RefineChip, string> = {
  shorter: "tighten it up to fit the target length",
  longer: "expand it to fit the target length, without padding",
  more_formal: "make it more formal",
  warmer: "make it warmer and friendlier",
  regenerate: "rewrite it fresh with a different angle, same meaning and context",
};

const SNIPPET_REGENERATE_INSTRUCTION =
  "redo it, using a different valid approach if one exists; it must still do exactly the same thing";

function chipInstruction(chip: RefineChip, channel: DraftChannel): string {
  if (channel === "snippet" && chip === "regenerate") {
    return SNIPPET_REGENERATE_INSTRUCTION;
  }
  return CHIP_INSTRUCTIONS[chip];
}

export interface RefineDraftParams {
  channel: DraftChannel;
  /** The TARGET length (already stepped for shorter/longer). */
  length: DraftLength;
  priorDraft: string;
  chip: RefineChip;
  contextSummary: string;
  /** The worker-minted id from draft.created, so the backend updates the
   * stored dashboard copy alongside returning the refined text. */
  draftId: string;
}

export interface RefineDraftResult {
  text: string;
  reason: string;
}

/** Reworks the current draft. Model-level failures come back as
 * {text: "", reason: "timeout" | "model_error"} on a 200, matching the
 * backend's never-raise contract; only transport/auth problems throw. */
export async function refineDraft(params: RefineDraftParams): Promise<RefineDraftResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REFINE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await authFetch("/desktop/draft-outbound/refine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channel: params.channel,
        length: params.length,
        prior_draft: params.priorDraft,
        refine_instruction: chipInstruction(params.chip, params.channel),
        context_summary: params.contextSummary,
        instruction_kind: params.chip,
        draft_id: params.draftId,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`refine failed with HTTP ${response.status}`);
  }

  const data = (await response.json()) as { text?: string; reason?: string };
  return { text: data.text ?? "", reason: data.reason ?? "model_error" };
}
