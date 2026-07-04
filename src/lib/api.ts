import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { hostname } from "@tauri-apps/plugin-os";
import { auth } from "./firebase";
import { logError } from "./log";
import { pairingCodeLength, pairingErrorCopy } from "./pairingCopy";
import { rawPairingCode } from "./pairingCodeFormat";

export const API_BASE_URL = "https://juno-backend-620715294422.us-central1.run.app";

const CLAIM_TIMEOUT_MS = 15_000;

/** Thrown when an authenticated call has no session, or the backend rejects
 * the ID token; callers must route back to the sign-in form, not retry. */
export class AuthRequiredError extends Error {}

/**
 * Per the auth contract: a missing/expired session at any authenticated call
 * routes back to the sign-in form rather than failing silently.
 */
export async function routeToDashboardForExpiredSession(): Promise<void> {
  await invoke("set_session_cached", { hasSession: false }).catch((err) =>
    logError("routeToDashboardForExpiredSession: set_session_cached", err),
  );
  await invoke("summon").catch((err) =>
    logError("routeToDashboardForExpiredSession: summon", err),
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

export type PairingErrorKind = "bad_length" | "network" | "invalid_or_expired" | "timeout" | "other";

export class PairingError extends Error {
  kind: PairingErrorKind;

  constructor(kind: PairingErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Claims an 8-char pairing code shown on the phone. The device name is sent
 * silently from the OS hostname (no user-editable field, matching the
 * source app) - never surfaces why a code failed (expired vs. wrong vs.
 * already claimed), only that it did.
 */
export async function claimPairingCode(code: string): Promise<string> {
  const raw = rawPairingCode(code);
  if (raw.length !== pairingCodeLength) {
    throw new PairingError("bad_length", pairingErrorCopy.badLength);
  }

  const deviceName = await hostname().catch((err) => {
    logError("claimPairingCode: hostname", err);
    return null;
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CLAIM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/devices/pair/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: raw, device_name: deviceName ?? "" }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new PairingError("timeout", pairingErrorCopy.timeout);
    }
    throw new PairingError("network", pairingErrorCopy.network);
  } finally {
    clearTimeout(timeoutId);
  }

  if (response.status === 400) {
    throw new PairingError("invalid_or_expired", pairingErrorCopy.invalidOrExpired);
  }
  if (!response.ok) {
    throw new PairingError("other", pairingErrorCopy.otherFailure);
  }

  const data = (await response.json()) as { custom_token?: string };
  if (!data.custom_token) {
    throw new PairingError("other", pairingErrorCopy.otherFailure);
  }
  return data.custom_token;
}
