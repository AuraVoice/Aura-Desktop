import { Store } from "@tauri-apps/plugin-store";
import { overlayStorePath } from "./copy";
import { logError } from "./log";

export const GENERAL_SETTINGS_KEY = "dashboard_general_settings";
// Bumped to 2 when uploads actually became real. Version 1 was recorded
// against copy that said "Uploads are not active yet", so it is not consent
// to send anything; anyone still at 1 is treated as not opted in and must
// choose again. Matches CONSENT_VERSION in the backend's
// services/dictation/fields.py, which is the value the upload payload has to
// assert.
export const IMPROVEMENT_CONSENT_VERSION = 2;

export interface GeneralSettings {
  dailyCatchUp: boolean;
  dailyBriefing: boolean;
  calendarInBriefing: boolean;
  calendarOverlay: boolean;
  sensitiveNotificationPreviews: boolean;
  reduceMotion: boolean;
  alwaysShowBar: boolean;
  showInTaskbar: boolean;
  dictationSounds: boolean;
  muteOthersWhileDictating: boolean;
  textOutputMuted: boolean;
  chatScreenshots: boolean;
  voiceScreenContext: boolean;
  notifySuggestions: boolean;
  notifyAnnouncements: boolean;
  notifyMilestones: boolean;
  improveConversations: boolean;
  improveActions: boolean;
  improvementConsentVersion: number;
}

// Launch-at-login is deliberately absent: autostart.rs owns it in a different
// store (settings.json / autostart_disabled) and the tray checkbox reads the
// real registry state rather than the intent. A second copy here would drift
// the first time a registry write failed.
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  dailyCatchUp: true,
  dailyBriefing: true,
  calendarInBriefing: true,
  calendarOverlay: true,
  sensitiveNotificationPreviews: true,
  reduceMotion: false,
  alwaysShowBar: false,
  showInTaskbar: true,
  dictationSounds: true,
  muteOthersWhileDictating: false,
  textOutputMuted: false,
  // Off until asked for, same reasoning as voiceScreenContext below. This is
  // the whole gate on the composer's attach button, not a hint: with it off the
  // button is disabled and the "take a screenshot" phrase attaches nothing, so
  // the switch cannot claim more than it does.
  chatScreenshots: false,
  // Off for everyone until they turn it on. Sending a frame every spoken turn
  // is the kind of thing a user has to opt into knowingly, and mergeSettings
  // folds the new key into an existing store without a migration.
  voiceScreenContext: false,
  notifySuggestions: true,
  notifyAnnouncements: true,
  notifyMilestones: true,
  improveConversations: false,
  improveActions: false,
  improvementConsentVersion: 0,
};

function mergeSettings(saved: GeneralSettings | null | undefined): GeneralSettings {
  const merged = { ...DEFAULT_GENERAL_SETTINGS, ...(saved ?? {}) };
  // Consent below the current version is not consent. It was given against
  // copy describing something else, so the switches read OFF until the user
  // chooses again against the copy that now applies. Clearing here rather than
  // at each call site makes this the single choke point: every reader of these
  // flags, including the upload eligibility check, sees false without needing
  // to know a version exists. The stored value is left alone until the user
  // actually saves, so nothing is silently rewritten underneath them.
  if (merged.improvementConsentVersion < IMPROVEMENT_CONSENT_VERSION) {
    merged.improveConversations = false;
    merged.improveActions = false;
    merged.improvementConsentVersion = 0;
  }
  return merged;
}

/// Whether sharing is genuinely authorized right now. The only thing an
/// upload path may ask. Never read the two toggles directly for that decision:
/// they are meaningless without the version they were recorded against.
export function improvementSharingActive(settings: GeneralSettings): boolean {
  return (
    settings.improvementConsentVersion >= IMPROVEMENT_CONSENT_VERSION &&
    (settings.improveConversations || settings.improveActions)
  );
}

export async function loadGeneralSettings(): Promise<GeneralSettings> {
  try {
    const store = await Store.load(overlayStorePath);
    return mergeSettings(await store.get<GeneralSettings>(GENERAL_SETTINGS_KEY));
  } catch (err) {
    logError("generalSettings: load", err);
    return DEFAULT_GENERAL_SETTINGS;
  }
}

export async function saveGeneralSettings(settings: GeneralSettings): Promise<void> {
  const store = await Store.load(overlayStorePath);
  await store.set(GENERAL_SETTINGS_KEY, settings);
  await store.save();
}

/** Flip the per-turn screen-context setting. Used by the Settings page and by
 * the overlay's consent card (agent-requested enable); every subscriber,
 * including the Rust security mirror sync in OverlayRoot, follows the store
 * change. */
export async function setVoiceScreenContext(enabled: boolean): Promise<void> {
  const current = await loadGeneralSettings();
  await saveGeneralSettings({ ...current, voiceScreenContext: enabled });
}

export async function subscribeGeneralSettings(
  listener: (settings: GeneralSettings) => void,
): Promise<() => void> {
  const store = await Store.load(overlayStorePath);
  return store.onKeyChange<GeneralSettings>(GENERAL_SETTINGS_KEY, (saved) => {
    listener(mergeSettings(saved));
  });
}
