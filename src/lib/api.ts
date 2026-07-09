import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { hostname } from "@tauri-apps/plugin-os";
import packageJson from "../../package.json";
import { auth } from "./firebase";
import { logError } from "./log";
import { pairingCodeLength, pairingErrorCopy } from "./pairingCopy";
import { rawPairingCode } from "./pairingCodeFormat";
import { webAuthCopy } from "./webAuthCopy";

export const API_BASE_URL = "https://juno-backend-620715294422.us-central1.run.app";

/** Sent on every backend request so the server can tell desktop traffic apart
 * from mobile and correlate behavior with a specific shipped build. Version
 * comes from package.json, the same source sentry.ts already uses for its
 * release tag, so all three (installer, Sentry, these headers) agree. */
const PLATFORM_HEADERS = {
  "X-Aura-Platform": "windows",
  "X-Aura-App-Version": packageJson.version,
} as const;

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
      ...PLATFORM_HEADERS,
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
      headers: { "Content-Type": "application/json", ...PLATFORM_HEADERS },
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

// ── Browser-based Google sign-up handshake ──────────────────────────────────
// Desktop-initiated device-authorization flow: startWebAuth() gets a session
// code, the caller opens auravoiceapp.com/auth?session=<code> in the system
// browser, then pollWebAuthStatusOnce() is called on a timer until the
// browser leg completes. Both endpoints are unauthenticated (no session
// exists yet), same posture as claimPairingCode above.

const WEB_AUTH_START_TIMEOUT_MS = 15_000;
const WEB_AUTH_STATUS_TIMEOUT_MS = 10_000;

export type WebAuthErrorKind = "network" | "timeout" | "other";

export class WebAuthError extends Error {
  kind: WebAuthErrorKind;

  constructor(kind: WebAuthErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export type WebAuthStartResult = {
  code: string;
  expiresInSeconds: number;
};

/** Requests a fresh web-auth session code to embed in the browser URL. */
export async function startWebAuth(): Promise<WebAuthStartResult> {
  const deviceName = await hostname().catch((err) => {
    logError("startWebAuth: hostname", err);
    return null;
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEB_AUTH_START_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/devices/web-auth/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...PLATFORM_HEADERS },
      body: JSON.stringify({ device_name: deviceName ?? "" }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new WebAuthError("timeout", webAuthCopy.timeout);
    }
    throw new WebAuthError("network", webAuthCopy.network);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new WebAuthError("other", webAuthCopy.otherFailure);
  }

  const data = (await response.json()) as { code?: string; expires_in_seconds?: number };
  if (!data.code || !data.expires_in_seconds) {
    throw new WebAuthError("other", webAuthCopy.otherFailure);
  }
  return { code: data.code, expiresInSeconds: data.expires_in_seconds };
}

export type WebAuthStatusResult =
  | { status: "pending" }
  | { status: "completed"; customToken: string }
  | { status: "expired" }
  | { status: "not_found" }
  | { status: "failed"; reason: string };

/**
 * A single status check. Terminal outcomes (completed/expired/not_found/
 * failed) are normal 200 responses, never thrown - only transport failures
 * (network/timeout) throw, so the poll loop can swallow and reschedule those
 * without ending the flow on one blip.
 */
export async function pollWebAuthStatusOnce(code: string): Promise<WebAuthStatusResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEB_AUTH_STATUS_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/devices/web-auth/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...PLATFORM_HEADERS },
      body: JSON.stringify({ code }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new WebAuthError("timeout", webAuthCopy.timeout);
    }
    throw new WebAuthError("network", webAuthCopy.network);
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new WebAuthError("other", webAuthCopy.otherFailure);
  }

  const data = (await response.json()) as {
    status?: string;
    custom_token?: string;
    reason?: string;
  };

  if (data.status === "completed" && data.custom_token) {
    return { status: "completed", customToken: data.custom_token };
  }
  if (data.status === "failed") {
    return { status: "failed", reason: data.reason ?? "other" };
  }
  if (data.status === "expired") {
    return { status: "expired" };
  }
  if (data.status === "not_found") {
    return { status: "not_found" };
  }
  return { status: "pending" };
}
