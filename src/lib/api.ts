import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { auth } from "./firebase";
import { logError } from "./log";

export const API_BASE_URL = "https://juno-backend-620715294422.us-central1.run.app";

/** Thrown when an authenticated call has no session, or the backend rejects
 * the ID token — callers must route back to the pairing screen, not retry. */
export class AuthRequiredError extends Error {}

/**
 * Per the auth contract: a missing/expired session at any authenticated call
 * routes back to the pairing screen rather than failing silently.
 */
export async function routeToDashboardForExpiredSession(): Promise<void> {
  await invoke("set_session_cached", { hasSession: false }).catch((err) =>
    logError("routeToDashboardForExpiredSession: set_session_cached", err),
  );
  await invoke("switch_mode", { mode: "dashboard" }).catch((err) =>
    logError("routeToDashboardForExpiredSession: switch_mode", err),
  );
}

/**
 * Fetches with a fresh Firebase ID token attached. Always calls getIdToken()
 * rather than caching a token, so it auto-refreshes per the auth contract.
 */
export async function authFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const user = auth.currentUser;
  if (!user) {
    throw new AuthRequiredError("No signed-in user");
  }

  const idToken = await user.getIdToken();
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      ...init?.headers,
      Authorization: `Bearer ${idToken}`,
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthRequiredError(`Request unauthorized (${response.status})`);
  }

  return response;
}

export type PairingErrorKind = "network" | "invalid_or_expired";

export class PairingError extends Error {
  kind: PairingErrorKind;

  constructor(kind: PairingErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Claims an 8-char pairing code shown on the phone. Never surfaces why a code
 * failed (expired vs. wrong vs. already claimed) — only that it did.
 */
export async function claimPairingCode(
  code: string,
  deviceName: string,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/devices/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, device_name: deviceName }),
    });
  } catch {
    throw new PairingError(
      "network",
      "Couldn't reach Aura. Check your connection and try again.",
    );
  }

  if (!response.ok) {
    throw new PairingError(
      "invalid_or_expired",
      "That code is expired or wrong. Try again.",
    );
  }

  const data = (await response.json()) as { custom_token: string };
  return data.custom_token;
}
