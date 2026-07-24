import { authFetch } from "./api";
import { advertiseManifest } from "./desktopCapabilities";
import { voiceCapReachedCode } from "./voiceErrorCopy";

export interface VoiceTokenResponse {
  token: string;
  url: string;
  room: string;
}

export type VoiceSessionMode = "standard" | "guide";

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

export async function fetchVoiceToken(
  mode: VoiceSessionMode = "standard",
  bridged = false,
): Promise<VoiceTokenResponse> {
  // The client advertises which desktop-control verbs this build supports so
  // the agent can scope its single `run_desktop_capability` tool to them (and
  // omit it entirely for clients - like mobile - that advertise nothing).
  // Sent as a query param, not a POST body, so the current live GET endpoint
  // keeps working unchanged and the backend can start reading it whenever it
  // ships (forced release order, same class as the agentData.ts contract).
  const manifestParam = encodeURIComponent(JSON.stringify(advertiseManifest()));
  const modeParam = mode === "guide" ? "&mode=guide" : "";
  // Bridge mode: the Realtime leg is already talking, so the token stamps
  // `bridged=1` and the worker HOLDs for a handover instead of greeting.
  const bridgedParam = bridged ? "&bridged=1" : "";
  const response = await authFetch(
    `/voice/token?surface=desktop&manifest=${manifestParam}${modeParam}${bridgedParam}`,
  );
  if (response.status === 402) {
    const capError = await parseCapDenial(response);
    if (capError) throw capError;
  }
  if (!response.ok) {
    throw new Error(`Voice token request failed (${response.status})`);
  }
  return (await response.json()) as VoiceTokenResponse;
}
