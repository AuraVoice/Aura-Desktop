import { clearDictationCredential, runCredentialCycle } from "../lib/dictationCredential";
import { useCredentialPump } from "./useCredentialPump";

/**
 * Keeps Rust supplied with a valid transcription credential for hold-to-talk
 * dictation. All the scheduling, generation guarding and sign-out clearing
 * lives in `useCredentialPump`; this only says what one cycle is.
 */
export function useDictationCredential(ownerUid: string | null) {
  useCredentialPump(ownerUid, runCredentialCycle, clearDictationCredential);
}
