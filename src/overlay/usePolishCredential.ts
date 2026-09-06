import { auth } from "../lib/firebase";
import { clearPolishCredential, pushPolishCredential } from "../lib/dictationPolish";
import { logError } from "../lib/log";
import {
  refreshDelayMs,
  useCredentialPump,
  RETRY_DELAY_MS,
  type PumpOutcome,
} from "./useCredentialPump";

/**
 * Keeps Rust supplied with a fresh Firebase ID token for the AI-formatting
 * backend call.
 *
 * Unlike the transcription credential there is no backend mint: the Firebase ID
 * token itself IS what the polish endpoint checks, the same one `authFetch`
 * attaches to every authenticated call.
 */

/** Firebase ID tokens are valid for one hour. */
const ID_TOKEN_TTL_SECONDS = 3600;

async function cycle(): Promise<PumpOutcome> {
  try {
    const user = auth.currentUser;
    // Signed out. Stop rather than retry: the pump's cleanup already cleared
    // the token, and a mint cannot succeed until the uid changes, which
    // restarts the pump anyway. The old version rescheduled forever here.
    if (!user) return { nextDelayMs: null };
    // Force a fresh mint so the pushed token carries its full hour.
    const idToken = await user.getIdToken(true);
    await pushPolishCredential(idToken, ID_TOKEN_TTL_SECONDS);
    return { nextDelayMs: refreshDelayMs(ID_TOKEN_TTL_SECONDS) };
  } catch (err) {
    logError("usePolishCredential", err);
    return { nextDelayMs: RETRY_DELAY_MS };
  }
}

export function usePolishCredential(ownerUid: string | null) {
  useCredentialPump(ownerUid, cycle, clearPolishCredential);
}
