import { useEffect, useRef } from "react";
import { auth } from "../lib/firebase";
import {
  clearPolishCredential,
  pushPolishCredential,
} from "../lib/dictationPolish";
import { logError } from "../lib/log";

/**
 * Keeps Rust supplied with a fresh Firebase ID token for the AI-formatting
 * backend call, mirroring `useDictationCredential` for transcription: mounted
 * by OverlayRoot because the overlay is always running, refreshed ahead of
 * expiry so a keyup never pays a minting round trip, and cleared on sign-out
 * so the token cannot outlive its session.
 *
 * Unlike the transcription credential there is no backend mint here: the
 * Firebase ID token itself IS the credential the polish endpoint checks, the
 * same one `authFetch` attaches to every authenticated call.
 */

/** Firebase ID tokens are valid for one hour. */
const ID_TOKEN_TTL_SECONDS = 3600;
/** Refresh at 70% of that life, same reasoning as the transcription pump. */
const REFRESH_DELAY_MS = Math.floor(ID_TOKEN_TTL_SECONDS * 0.7 * 1000);
/** Backoff after a failed mint. */
const RETRY_DELAY_MS = 30_000;

export function usePolishCredential(ownerUid: string | null) {
  // Guards against a cycle scheduled by a previous uid landing after a
  // sign-out or a user switch.
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;

    if (!ownerUid) {
      void clearPolishCredential();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const cycle = async () => {
      let delay = REFRESH_DELAY_MS;
      try {
        const user = auth.currentUser;
        if (!user) return; // Signed out; the cleanup below already cleared.
        // Force a fresh mint so the pushed token carries its full hour.
        const idToken = await user.getIdToken(true);
        if (cancelled || generationRef.current !== generation) return;
        await pushPolishCredential(idToken, ID_TOKEN_TTL_SECONDS);
      } catch (err) {
        logError("usePolishCredential", err);
        delay = RETRY_DELAY_MS;
      }
      if (cancelled || generationRef.current !== generation) return;
      timer = setTimeout(() => void cycle(), delay);
    };

    void cycle();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      void clearPolishCredential();
    };
  }, [ownerUid]);
}
