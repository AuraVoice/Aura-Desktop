import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";

/**
 * Typed client for voice commands ("Jev").
 *
 * The decision itself is a backend call: Rust posts the enumerated options to
 * `POST /dictation/command` on juno-backend, which holds the TypeSafe key. No
 * provider key exists on the client anywhere, and there is nothing for a user
 * to paste. What crosses this boundary is the opt-in flag and, from the
 * overlay's refresh pump, a fresh Firebase ID token for Rust to authenticate
 * that call with - the same React-mints-Rust-holds pattern as polish and the
 * transcription credential.
 */

/** Mirrors CommandSettingsView in src-tauri/src/dictation/command_brain.rs. */
export interface CommandSettings {
  enabled: boolean;
  /** Whether Rust has a usable credential yet. Readiness, not a secret. */
  ready: boolean;
}

export function loadCommandSettings(): Promise<CommandSettings> {
  return invoke<CommandSettings>("dictation_command_settings");
}

export function saveCommandSettings(enabled: boolean): Promise<CommandSettings> {
  return invoke<CommandSettings>("dictation_set_command_settings", { enabled });
}

/** Hands Rust a fresh Firebase ID token, RAM only on its side. */
export async function pushCommandCredential(
  idToken: string,
  ttlSeconds: number,
): Promise<void> {
  await invoke("dictation_set_command_credential", {
    idToken,
    ttlSeconds: Math.floor(ttlSeconds),
  });
}

export async function clearCommandCredential(): Promise<void> {
  try {
    await invoke("dictation_clear_command_credential");
  } catch (error) {
    logError("dictationCommands: clear credential", error);
  }
}
