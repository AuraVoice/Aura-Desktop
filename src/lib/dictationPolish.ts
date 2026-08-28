import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";

/**
 * Typed client for the optional AI transcript cleanup ("polish").
 *
 * The formatting itself is a backend call: Rust posts the finished transcript
 * to `POST /dictation/polish` on juno-backend, which holds the LLM provider
 * key. No provider key exists on the client anywhere. What crosses this
 * boundary is the opt-in flag and, from the overlay's refresh pump, a fresh
 * Firebase ID token for Rust to authenticate that call with - the same
 * React-mints-Rust-holds pattern as the transcription credential.
 */

export interface PolishSettings {
  enabled: boolean;
}

export function loadPolishSettings(): Promise<PolishSettings> {
  return invoke<PolishSettings>("dictation_polish_settings");
}

export function savePolishSettings(settings: {
  enabled: boolean;
}): Promise<PolishSettings> {
  return invoke<PolishSettings>("dictation_set_polish_settings", settings);
}

/** Hands Rust a fresh Firebase ID token, RAM only on its side. */
export async function pushPolishCredential(
  idToken: string,
  ttlSeconds: number,
): Promise<void> {
  await invoke("dictation_set_polish_credential", {
    idToken,
    ttlSeconds: Math.floor(ttlSeconds),
  });
}

export async function clearPolishCredential(): Promise<void> {
  await invoke("dictation_clear_polish_credential").catch((err) =>
    logError("clearPolishCredential", err),
  );
}
