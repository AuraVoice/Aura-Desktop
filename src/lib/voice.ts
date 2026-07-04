import { authFetch } from "./api";

export interface VoiceTokenResponse {
  token: string;
  url: string;
  room: string;
}

export async function fetchVoiceToken(): Promise<VoiceTokenResponse> {
  const response = await authFetch("/voice/token?surface=desktop");
  if (!response.ok) {
    throw new Error(`Voice token request failed (${response.status})`);
  }
  return (await response.json()) as VoiceTokenResponse;
}
