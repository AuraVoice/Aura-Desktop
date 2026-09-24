import { Store } from "@tauri-apps/plugin-store";
import { overlayStorePath } from "./copy";
import { logError } from "./log";

export const GENERAL_SETTINGS_KEY = "dashboard_general_settings";
// Bumped to 2 when uploads actually became real. Version 1 was recorded
// against copy that said "Uploads are not active yet", so it is not consent
// to send anything. Bumped to 3 when the sample widened beyond audio and
// transcripts to the app dictated into, the kind of field, up to 200
// characters already in that field before the cursor, and the edits made
// afterwards (architectures/dictation-model-plan.md, Phase 0); consent given
// against the version 2 copy does not cover that, so anyone at 2 reads as not
// opted in until they choose again against the copy that now applies. Matches
// CONSENT_VERSION in the backend's services/dictation/fields.py, which is the
// value the upload payload has to assert.
export const IMPROVEMENT_CONSENT_VERSION = 3;

export type ThemeSetting = "system" | "light" | "dark";

export interface GeneralSettings {
  theme: ThemeSetting;
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
  interviewAutoStart: boolean;
  interviewKeepAudio: boolean;
  notifySuggestions: boolean;
  notifyAnnouncements: boolean;
  notifyMilestones: boolean;
  improveConversations: boolean;
  improveActions: boolean;
  improvementConsentVersion: number;
  /** Shows the Browser Agent page: the Phase A harness that measures the
   * background browser agent before any voice user reaches it. */
  browserAgentHarness: boolean;
}

// Launch-at-login is deliberately absent: autostart.rs owns it in a different
// store (settings.json / autostart_disabled) and the tray checkbox reads the
// real registry state rather than the intent. A second copy here would drift
// the first time a registry write failed.
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  // Follows the OS until the user picks. Read before first paint by
  // src/theme/ThemeSync.tsx and, for the dashboard's window background, by
  // dashboard.rs, so the key name is shared with Rust.
  theme: "system",
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
  // On by default, and it is not a capture consent: the companion still only
  // arms once the user has opened it and settled the preflight. All this
  // decides is whether the last gesture is a click or a countdown, and
  // reaching for the overlay mid-interview can blur the interview window.
  interviewAutoStart: true,
  // Retains the interview's own audio, sealed, under a retention cap, so the
  // candidate can hear what was actually asked. Separate from the transcript:
  // turning this off stops future capture and keeps existing clips.
  interviewKeepAudio: true,
  notifySuggestions: true,
  notifyAnnouncements: true,
  notifyMilestones: true,
  improveConversations: false,
  improveActions: false,
  improvementConsentVersion: 0,
  browserAgentHarness: false,
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

/// Whether the recorded consent is current. Necessary for any sharing, never
/// sufficient on its own: the two toggles are meaningless without the version
/// they were recorded against, and each toggle authorizes a different thing.
function consentIsCurrent(settings: GeneralSettings): boolean {
  return settings.improvementConsentVersion >= IMPROVEMENT_CONSENT_VERSION;
}

/// Whether dictation recordings and transcripts may be uploaded.
///
/// Gated on `improveConversations` ALONE, deliberately. An earlier version
/// OR-ed the two toggles, which meant turning on "Action samples" - a switch
/// whose copy is about screen context and corrections - silently authorized
/// sending speech audio. A consent switch may only authorize the thing its own
/// copy describes.
export function dictationSharingActive(settings: GeneralSettings): boolean {
  return consentIsCurrent(settings) && settings.improveConversations;
}

/// Whether screen context, corrections and outcomes may be uploaded. Separate
/// from the above for the same reason, and currently read by nothing: no
/// uploader for action samples exists yet.
export function actionSharingActive(settings: GeneralSettings): boolean {
  return consentIsCurrent(settings) && settings.improveActions;
}

/// Whether ANY sharing is on. Only for UI that describes the pair as a group,
/// such as the privacy line on the Dictation page. Never gate an upload on it.
export function anySharingActive(settings: GeneralSettings): boolean {
  return dictationSharingActive(settings) || actionSharingActive(settings);
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

/** Set only the Appearance choice, from surfaces that do not hold the whole
 * settings object (the top bar toggle). Reads the raw stored value rather than
 * loadGeneralSettings, whose failure fallback is the defaults: saving those
 * back would silently wipe every other preference. */
export async function setThemeSetting(theme: ThemeSetting): Promise<void> {
  const store = await Store.load(overlayStorePath);
  const saved = await store.get<GeneralSettings>(GENERAL_SETTINGS_KEY);
  await store.set(GENERAL_SETTINGS_KEY, { ...(saved ?? DEFAULT_GENERAL_SETTINGS), theme });
  await store.save();
}

export async function subscribeGeneralSettings(
  listener: (settings: GeneralSettings) => void,
): Promise<() => void> {
  const store = await Store.load(overlayStorePath);
  return store.onKeyChange<GeneralSettings>(GENERAL_SETTINGS_KEY, (saved) => {
    listener(mergeSettings(saved));
  });
}
