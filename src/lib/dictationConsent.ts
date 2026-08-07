import { invoke } from "@tauri-apps/api/core";

/**
 * Online-dictation consent, as the webview sees it.
 *
 * The state itself lives in Rust (`dictation/consent.rs`) because Rust is what
 * enforces it: the chord's worker checks it before it opens the microphone, so
 * a consent value the frontend merely believed in would gate nothing. These
 * two calls are a view onto that, for the Settings page and the HUD prompt.
 */

export interface DictationConsentState {
  accepted: boolean;
}

export async function loadDictationConsent(): Promise<DictationConsentState> {
  return invoke<DictationConsentState>("dictation_consent_state");
}

/** Records or withdraws consent. Withdrawing takes effect on the next chord
 * press; there is nothing to tear down, because a hold owns its own socket and
 * releases it when it ends. */
export async function setDictationConsent(
  accepted: boolean,
): Promise<DictationConsentState> {
  return invoke<DictationConsentState>("dictation_set_consent", { accepted });
}
