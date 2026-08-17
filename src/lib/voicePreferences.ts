import { authFetch } from "./api";

export interface VoicePreference {
  voiceId: string;
  storedVoiceId: string;
  fallbackReason: string;
  defaultVoiceId: string;
}

const REQUEST_TIMEOUT_MS = 10_000;

function parseVoicePreference(json: unknown): VoicePreference {
  if (typeof json !== "object" || json === null) {
    throw new Error("Voice preference response was malformed");
  }
  const value = json as Record<string, unknown>;
  if (typeof value.voice_id !== "string" || !value.voice_id) {
    throw new Error("Voice preference response did not include a voice");
  }
  return {
    voiceId: value.voice_id,
    storedVoiceId: typeof value.stored_voice_id === "string" ? value.stored_voice_id : "",
    fallbackReason: typeof value.fallback_reason === "string" ? value.fallback_reason : "",
    defaultVoiceId: typeof value.default_voice_id === "string" ? value.default_voice_id : "katie",
  };
}

async function requestVoicePreference(init?: RequestInit): Promise<VoicePreference> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await authFetch("/voice/preferences", { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Voice preference request failed (${response.status})`);
    }
    return parseVoicePreference(await response.json());
  } finally {
    clearTimeout(timeoutId);
  }
}

export function fetchVoicePreference(): Promise<VoicePreference> {
  return requestVoicePreference();
}

export function saveVoicePreference(voiceId: string): Promise<VoicePreference> {
  return requestVoicePreference({
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ voice_id: voiceId }),
  });
}
