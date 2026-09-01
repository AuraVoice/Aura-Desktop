import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { hostname } from "@tauri-apps/plugin-os";
import packageJson from "../../package.json";
import { auth } from "./firebase";
import { getOrCreateDesktopInstallId } from "./desktopInstallId";
import { logError } from "./log";
import { platformTag } from "./platform";
import { pairingCodeLength, pairingErrorCopy } from "./pairingCopy";
import { rawPairingCode } from "./pairingCodeFormat";
import { webAuthCopy } from "./webAuthCopy";

export const API_BASE_URL = "https://juno-backend-620715294422.us-central1.run.app";

/** Sent on every backend request so the server can tell desktop traffic apart
 * from mobile and correlate behavior with a specific shipped build. Version
 * comes from package.json, the same source sentry.ts already uses for its
 * release tag, so all three (installer, Sentry, these headers) agree. */
const PLATFORM_HEADERS = {
  "X-Aura-Platform": platformTag,
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

/** Thrown by the *WithTimeout helpers when the deadline aborts the request,
 * so callers can tell a timeout from any other transport failure without
 * matching on AbortError DOMExceptions. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

async function withDeadline(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<Response>,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new TimeoutError(`request timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/** Plain fetch with a hard deadline; TimeoutError on the deadline, every
 * other failure rethrown untouched. For the pre-auth endpoints. */
export function fetchWithTimeout(
  input: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  return withDeadline(timeoutMs, (signal) => fetch(input, { ...init, signal }));
}

/** authFetch with a hard deadline; same TimeoutError contract. */
export function authFetchWithTimeout(
  path: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  return withDeadline(timeoutMs, (signal) => authFetch(path, { ...init, signal }));
}

interface AuthGetJsonOptions {
  signal?: AbortSignal;
  /** Overrides the default `GET {path} -> HTTP {status}` error message shape. */
  errorPrefix?: string;
}

export async function authGetJson<T>(
  path: string,
  options?: AuthGetJsonOptions,
): Promise<T>;
export async function authGetJson<T>(
  path: string,
  options: AuthGetJsonOptions & { softStatuses: number[] },
): Promise<T | null>;
/** GET a JSON body over authFetch. Any non-2xx throws, EXCEPT a status the
 * caller lists in softStatuses, which resolves to null instead - the opt-in
 * makes a soft degrade (e.g. 404 from an older backend revision) visible at
 * the call site rather than hiding in a same-named local helper. */
export async function authGetJson<T>(
  path: string,
  options?: AuthGetJsonOptions & { softStatuses?: number[] },
): Promise<T | null> {
  const response = await authFetch(
    path,
    options?.signal ? { signal: options.signal } : undefined,
  );
  if (options?.softStatuses?.includes(response.status)) return null;
  if (!response.ok) {
    throw new Error(
      options?.errorPrefix
        ? `${options.errorPrefix} (${response.status})`
        : `GET ${path} -> HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
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

  const [deviceName, installId] = await Promise.all([
    hostname().catch((err) => {
      logError("claimPairingCode: hostname", err);
      return null;
    }),
    getOrCreateDesktopInstallId(),
  ]);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${API_BASE_URL}/devices/pair/claim`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...PLATFORM_HEADERS },
        body: JSON.stringify({ code: raw, device_name: deviceName ?? "", install_id: installId }),
      },
      CLAIM_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      throw new PairingError("timeout", pairingErrorCopy.timeout);
    }
    throw new PairingError("network", pairingErrorCopy.network);
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
  const [deviceName, installId] = await Promise.all([
    hostname().catch((err) => {
      logError("startWebAuth: hostname", err);
      return null;
    }),
    getOrCreateDesktopInstallId(),
  ]);

  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${API_BASE_URL}/devices/web-auth/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...PLATFORM_HEADERS },
        body: JSON.stringify({ device_name: deviceName ?? "", install_id: installId }),
      },
      WEB_AUTH_START_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      throw new WebAuthError("timeout", webAuthCopy.timeout);
    }
    throw new WebAuthError("network", webAuthCopy.network);
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
  let response: Response;
  try {
    response = await fetchWithTimeout(
      `${API_BASE_URL}/devices/web-auth/status`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", ...PLATFORM_HEADERS },
        body: JSON.stringify({ code }),
      },
      WEB_AUTH_STATUS_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof TimeoutError) {
      throw new WebAuthError("timeout", webAuthCopy.timeout);
    }
    throw new WebAuthError("network", webAuthCopy.network);
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
