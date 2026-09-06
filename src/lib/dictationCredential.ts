import { invoke } from "@tauri-apps/api/core";
import { authFetch, AuthRequiredError } from "./api";
import { logError } from "./log";
import { refreshDelayMs, RETRY_DELAY_MS } from "../overlay/useCredentialPump";

/**
 * The short-lived transcription credential for hold-to-talk dictation.
 *
 * Why this lives in the webview at all, when dictation itself is entirely in
 * Rust: `authFetch` attaches a fresh Firebase ID token, and Firebase auth only
 * exists on this side. Rust has no session and no way to mint one. So the
 * webview asks the backend, the backend asks the provider with a key that
 * never leaves the server, and the resulting minutes-long token is handed down
 * to Rust over IPC.
 *
 * The permanent provider key is never here, never in the bundle, and never in
 * the installer. What crosses this boundary is scoped to transcription and
 * expires on its own.
 *
 * Refreshing AHEAD of expiry is the point of the pump below. The token only
 * has to be valid at the moment the socket handshakes, and the handshake
 * happens the instant the user presses the chord. If minting were lazy, every
 * cold dictation would pay a backend round trip before the first word; keeping
 * a warm token means it pays none.
 */

/** What the backend returns from `POST /dictation/stt-token`. */
export interface DictationCredential {
  accessToken: string;
  /** Seconds, from the provider's own grant response. Never a client guess. */
  ttlSeconds: number;
}

/** Thrown when the backend has dictation transcription switched off, or is not
 * configured for it. Distinct from an auth failure: retrying will not help and
 * the user is not signed out. */
export class DictationUnavailableError extends Error {}

const TOKEN_PATH = "/dictation/stt-token";

/** Below this, a token is not worth handing to Rust: it would expire before or
 * during the first handshake it was minted for. Mirrors EXPIRY_MARGIN in
 * src-tauri/src/dictation/credential.rs. */
const MIN_USEFUL_TTL_SECONDS = 15;

/**
 * Refresh at 70% of the token's life. Early enough that a slow mint or one
 * failed attempt still lands before the current token dies, late enough that a
 * long session does not mint far more often than it needs to.
 */

/** Backoff after a failed mint. Short, because until this succeeds the chord
 * does not work, but not so short that a down backend gets hammered. */

/** Mints one credential. Throws `AuthRequiredError` when there is no session,
 * `DictationUnavailableError` when the backend cannot serve one. */
export async function mintDictationCredential(): Promise<DictationCredential> {
  const response = await authFetch(TOKEN_PATH, { method: "POST" });
  if (response.status === 503) {
    throw new DictationUnavailableError("Dictation transcription is unavailable");
  }
  if (!response.ok) {
    throw new Error(`Dictation token request failed (${response.status})`);
  }
  const body: unknown = await response.json();
  return parseDictationCredential(body);
}

/** Exported for its own sake: this is the one place the wire shape is trusted,
 * so it is where a malformed or short-lived response has to be caught. */
export function parseDictationCredential(body: unknown): DictationCredential {
  if (typeof body !== "object" || body === null) {
    throw new Error("Dictation token response was not an object");
  }
  const record = body as Record<string, unknown>;
  const accessToken = record.accessToken;
  const ttlSeconds = record.expiresInSeconds ?? record.ttlSeconds;
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    throw new Error("Dictation token response carried no access token");
  }
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds)) {
    throw new Error("Dictation token response carried no expiry");
  }
  if (ttlSeconds < MIN_USEFUL_TTL_SECONDS) {
    // A token this short would expire between the press and the handshake and
    // surface to the user as a confusing auth failure.
    throw new Error("Dictation token expires too soon to be usable");
  }
  return { accessToken, ttlSeconds };
}

/** How long to wait before the next mint, in milliseconds. */


export async function pushDictationCredential(
  credential: DictationCredential,
): Promise<void> {
  await invoke("dictation_set_credential", {
    accessToken: credential.accessToken,
    ttlSeconds: Math.floor(credential.ttlSeconds),
  });
}

export async function clearDictationCredential(): Promise<void> {
  await invoke("dictation_clear_credential").catch((err) =>
    logError("clearDictationCredential", err),
  );
}

/** What one pump cycle decided to do next, so the caller can schedule without
 * this module owning a timer. */
export interface MintOutcome {
  ok: boolean;
  /** Milliseconds until the next attempt, or null to stop (no session). */
  nextDelayMs: number | null;
}

/**
 * One cycle: mint, hand to Rust, and say when to come back.
 *
 * Never throws. A dictation credential failing is not worth breaking the
 * caller's render over, and every failure mode here has a defined next step
 * rather than a surfaced exception.
 */
export async function runCredentialCycle(): Promise<MintOutcome> {
  try {
    const credential = await mintDictationCredential();
    await pushDictationCredential(credential);
    return { ok: true, nextDelayMs: refreshDelayMs(credential.ttlSeconds) };
  } catch (err) {
    // No session. Stop entirely: signing back in restarts the pump, and
    // retrying on a timer would just produce a 401 every 30 seconds forever.
    if (err instanceof AuthRequiredError) {
      await clearDictationCredential();
      return { ok: false, nextDelayMs: null };
    }
    // Anything else (backend down, transcription switched off, a malformed
    // response) is potentially transient, so back off and try again. The old
    // credential is deliberately NOT cleared: if one is still valid, dictation
    // keeps working through a backend blip.
    logError("runCredentialCycle", err);
    return { ok: false, nextDelayMs: RETRY_DELAY_MS };
  }
}
