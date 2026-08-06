import { Store } from "@tauri-apps/plugin-store";
import { overlayStorePath } from "./copy";
import { logError } from "./log";

export const GENERAL_SETTINGS_KEY = "dashboard_general_settings";

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
  notifySuggestions: boolean;
  notifyAnnouncements: boolean;
  notifyMilestones: boolean;
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
  notifySuggestions: true,
  notifyAnnouncements: true,
  notifyMilestones: true,
};

function mergeSettings(saved: GeneralSettings | null | undefined): GeneralSettings {
  return { ...DEFAULT_GENERAL_SETTINGS, ...(saved ?? {}) };
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

export async function subscribeGeneralSettings(
  listener: (settings: GeneralSettings) => void,
): Promise<() => void> {
  const store = await Store.load(overlayStorePath);
  return store.onKeyChange<GeneralSettings>(GENERAL_SETTINGS_KEY, (saved) => {
    listener(mergeSettings(saved));
  });
}
