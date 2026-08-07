import { useEffect, useRef } from "react";
import {
  clearDictationCredential,
  runCredentialCycle,
} from "../lib/dictationCredential";

/**
 * Keeps Rust supplied with a valid transcription credential for hold-to-talk
 * dictation.
 *
 * Mounted by OverlayRoot for the same reason `useDictationUpload` is: the
 * overlay is always running and the dashboard usually is not. A credential
 * that only refreshed while a settings page happened to be open would leave
 * the chord dead most of the time.
 *
 * The scheduling matters more than it looks. The provider only checks the
 * credential at the WebSocket handshake, and that handshake happens the
 * instant the user presses the chord. Minting lazily would put a backend round
 * trip in front of the first word of every cold dictation; refreshing at ~70%
 * of the token's life means the press always finds a warm one.
 *
 * Three things it must not do:
 *  - mint signed out: dictation requires an account now, and a 401 loop helps
 *    nobody. `runCredentialCycle` reports that by asking to stop.
 *  - clear a working credential on a transient backend failure: a valid token
 *    should keep dictation alive through a blip.
 *  - leave a credential behind on sign-out: the token outlives the session
 *    that was allowed to have it otherwise.
 */
export function useDictationCredential(ownerUid: string | null) {
  // Guards against a cycle scheduled by a previous uid landing after a sign-out
  // or a user switch.
  const generationRef = useRef(0);

  useEffect(() => {
    const generation = ++generationRef.current;

    if (!ownerUid) {
      void clearDictationCredential();
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const cycle = async () => {
      const outcome = await runCredentialCycle();
      // A cycle that started before a sign-out or a user switch must not
      // schedule work for, or on behalf of, the session that replaced it.
      if (cancelled || generationRef.current !== generation) {
        return;
      }
      if (outcome.nextDelayMs !== null) {
        timer = setTimeout(() => void cycle(), outcome.nextDelayMs);
      }
    };

    void cycle();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      void clearDictationCredential();
    };
  }, [ownerUid]);
}
