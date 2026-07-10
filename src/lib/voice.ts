import { authFetch } from "./api";
import { voiceCapReachedCode } from "./voiceErrorCopy";

export interface VoiceTokenResponse {
  token: string;
  url: string;
  room: string;
}

// The backend denies /voice/token with 402 + voiceCapReachedCode when a
// free-tier user is over the daily voice cap (SUBSCRIPTION_PLAN.md section 6,
// contract in SUBSCRIPTION_IMPLEMENTATION_PROMPT.md Phase 1). 402
// specifically: 401/403 mean re-auth here (authFetch throws
// AuthRequiredError), and infra layers can emit bare 429s of their own.
export class VoiceCapError extends Error {
  secondsUntilReset: number | null;

  constructor(secondsUntilReset: number | null) {
    super("Voice token denied: daily free-tier cap reached");
    this.name = "VoiceCapError";
    this.secondsUntilReset = secondsUntilReset;
  }
}

/** Reads a 402 body defensively; a cap denial needs the machine code, anything
 * else (unparseable body, different code) stays a generic token failure. */
async function parseCapDenial(response: Response): Promise<VoiceCapError | null> {
  try {
    const body = (await response.json()) as { detail?: { code?: unknown; seconds_until_reset?: unknown } };
    if (body?.detail?.code !== voiceCapReachedCode) return null;
    const seconds = body.detail.seconds_until_reset;
    return new VoiceCapError(typeof seconds === "number" ? seconds : null);
  } catch {
    return null;
  }
}

export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
  const response = await authFetch("/voice/token?surface=desktop");
  if (response.status === 402) {
    const capError = await parseCapDenial(response);
    if (capError) throw capError;
  }
  if (!response.ok) {
    throw new Error(`Voice token request failed (${response.status})`);
  }
  return (await response.json()) as VoiceTokenResponse;
}
