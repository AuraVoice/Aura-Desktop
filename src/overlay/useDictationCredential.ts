import { clearDictationCredential, runCredentialCycle } from "../lib/dictationCredential";
import { DICTATION_CREDENTIAL_NEEDED } from "../lib/ipcEvents";
import { useCredentialPump } from "./useCredentialPump";

/**
 * Keeps Rust supplied with a valid transcription credential for hold-to-talk
 * dictation. All the scheduling, generation guarding and sign-out clearing
 * lives in `useCredentialPump`; this only says what one cycle is, and that a
 * chord press which finds no credential may demand one immediately.
 */
export function useDictationCredential(ownerUid: string | null) {
  useCredentialPump(
    ownerUid,
    runCredentialCycle,
    clearDictationCredential,
    DICTATION_CREDENTIAL_NEEDED,
  );
}
