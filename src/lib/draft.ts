import { authFetch } from "./api";

/** Buddy Drafts client contract, mirroring the worker's data-channel payloads
 * and POST /desktop/draft-outbound/refine. The card refines over REST on every
 * chip tap (during and after a call, one code path); new drafts only ever come
 * from the voice tool over the data channel. */

export type DraftChannel = "email_reply" | "cold_dm";
export type DraftLength = "short" | "medium" | "detailed";
export type RefineChip = "shorter" | "longer" | "more_formal" | "warmer" | "regenerate";

const REFINE_TIMEOUT_MS = 15_000;

const LENGTH_LADDER: readonly DraftLength[] = ["short", "medium", "detailed"];

/** One step along short <-> medium <-> detailed; null at either end (the card
 * disables the chip there). */
export function steppedLength(current: DraftLength, direction: 1 | -1): DraftLength | null {
  const index = LENGTH_LADDER.indexOf(current) + direction;
  return LENGTH_LADDER[index] ?? null;
}

/** What each chip asks the model to do. Shorter/longer lean on the target
 * length the request already carries; the wording chips carry the instruction. */
const CHIP_INSTRUCTIONS: Record<RefineChip, string> = {
  shorter: "tighten it up to fit the target length",
  longer: "expand it to fit the target length, without padding",
  more_formal: "make it more formal",
  warmer: "make it warmer and friendlier",
  regenerate: "rewrite it fresh with a different angle, same meaning and context",
};

export interface RefineDraftParams {
  channel: DraftChannel;
  /** The TARGET length (already stepped for shorter/longer). */
  length: DraftLength;
  priorDraft: string;
  chip: RefineChip;
  contextSummary: string;
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
        refine_instruction: CHIP_INSTRUCTIONS[params.chip],
        context_summary: params.contextSummary,
        instruction_kind: params.chip,
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
