import { invoke } from "@tauri-apps/api/core";

/** Mirrors CommandSettingsView in src-tauri/src/dictation/command_brain.rs.
 * The API key itself never crosses this boundary back to the UI; only whether
 * one is stored. */
export interface CommandSettings {
  enabled: boolean;
  hasApiKey: boolean;
}

export function loadCommandSettings(): Promise<CommandSettings> {
  return invoke<CommandSettings>("dictation_command_settings");
}

export function saveCommandSettings(enabled: boolean): Promise<CommandSettings> {
  return invoke<CommandSettings>("dictation_set_command_settings", { enabled });
}

/** Stores the TypeSafe API key sealed on this device; an empty string removes
 * it. */
export function saveCommandApiKey(apiKey: string): Promise<CommandSettings> {
  return invoke<CommandSettings>("dictation_set_command_api_key", { apiKey });
}
