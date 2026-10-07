import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { COMPANION_CORNERS, type CompanionCorner } from "../../dictation/companionCorner";
import {
  DEFAULT_GENERAL_SETTINGS,
  loadGeneralSettings,
  saveGeneralSettings,
  subscribeGeneralSettings,
  type GeneralSettings,
} from "../../lib/generalSettings";
import { logError } from "../../lib/log";
import { CompanionAvatarPicker } from "../components/CompanionAvatarPicker";
import { SegmentedChoice } from "../components/SegmentedChoice";
import { SettingsPageLayout, SettingsSection } from "../components/SettingsPageLayout";

/** Settings > Companion: Buddy's face, and the switch that hides it. */
export function CompanionPage() {
  const [settings, setSettings] = useState<GeneralSettings>(DEFAULT_GENERAL_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);
  // Rust owns the corner (it is window geometry, kept beside the notch edge),
  // so it is read and written through its own commands, not the settings store.
  const [corner, setCorner] = useState<CompanionCorner>("bottomLeft");

  useEffect(() => {
    let active = true;
    invoke<CompanionCorner>("dictation_companion_corner")
      .then((saved) => {
        if (active) setCorner(saved);
      })
      .catch((err) => logError("CompanionPage: read companion corner", err));
    return () => {
      active = false;
    };
  }, []);

  async function moveCorner(next: CompanionCorner) {
    const previous = corner;
    setCorner(next);
    setSaveError(false);
    try {
      await invoke("dictation_set_companion_corner", { corner: next });
    } catch (err) {
      logError("CompanionPage: set companion corner", err);
      setCorner(previous);
      setSaveError(true);
    }
  }

  useEffect(() => {
    let active = true;
    loadGeneralSettings()
      .then((saved) => {
        if (active) {
          setSettings(saved);
          setLoaded(true);
        }
      })
      .catch((err) => {
        logError("CompanionPage: load settings", err);
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, []);

  // The General page and the overlay write this store too; following it keeps
  // this page from saving a stale copy of their change back over it.
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    subscribeGeneralSettings((saved) => {
      if (active) setSettings(saved);
    })
      .then((fn) => {
        if (active) unlisten = fn;
        else fn();
      })
      .catch((err) => logError("CompanionPage: subscribe settings", err));
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  async function update<K extends keyof GeneralSettings>(key: K, value: GeneralSettings[K]) {
    const previous = settings;
    const next = { ...settings, [key]: value };
    setSettings(next);
    setSaveError(false);
    try {
      await saveGeneralSettings(next);
    } catch (err) {
      logError("CompanionPage: save settings", err);
      setSettings(previous);
      setSaveError(true);
    }
  }

  return (
    <SettingsPageLayout
      title="Companion"
      description="Buddy's face. He shows up in chat and in Swarm while Aura is thinking, and can wait in a corner of your screen."
    >
      {!loaded ? (
        <div className="db-panel db-settings-panel">
          <p className="db-setting-description">Loading settings...</p>
        </div>
      ) : (
        <>
          <SettingsSection title="Show Buddy">
            <div className="db-panel db-settings-panel">
              <label className="db-setting-row">
                <span>
                  <span className="db-setting-label">Show companion avatar</span>
                  <span className="db-setting-description">
                    Turn this off and chat shows plain dots and Swarm its usual orb instead.
                  </span>
                </span>
                <input
                  className="db-setting-toggle"
                  type="checkbox"
                  checked={settings.showCompanionAvatar}
                  onChange={(event) => void update("showCompanionAvatar", event.target.checked)}
                />
              </label>
            </div>
          </SettingsSection>
          <SettingsSection
            title="On the desktop"
            description="Ctrl+Win dictation shows through him, and he hides whenever Aura's bar is up."
          >
            <div className="db-panel db-settings-panel">
              <label className="db-setting-row">
                <span>
                  <span className="db-setting-label">Sit on the desktop</span>
                  <span className="db-setting-description">
                    Bolt waits in a corner of your screen, listens while you dictate, and holds
                    up what Aura has to say.
                  </span>
                </span>
                <input
                  className="db-setting-toggle"
                  type="checkbox"
                  checked={settings.companionOnDesktop}
                  disabled={!settings.showCompanionAvatar}
                  onChange={(event) => void update("companionOnDesktop", event.target.checked)}
                />
              </label>
              <div className="db-setting-row">
                <span>
                  <span className="db-setting-label">Corner</span>
                  <span className="db-setting-description">
                    Where he stands. Bottom left keeps him clear of notifications.
                  </span>
                </span>
                <SegmentedChoice
                  options={COMPANION_CORNERS}
                  value={corner}
                  onChange={(value) => void moveCorner(value)}
                  ariaLabel="Companion corner"
                />
              </div>
            </div>
          </SettingsSection>
          <SettingsSection
            title="Choose an avatar"
            description="Move your pointer over a card and he follows it. More avatars are on the way."
          >
            <CompanionAvatarPicker
              value={settings.companionAvatar}
              disabled={!settings.showCompanionAvatar}
              onChange={(value) => void update("companionAvatar", value)}
            />
          </SettingsSection>
          {saveError && (
            <p className="db-settings-error">Could not save that change. Try again.</p>
          )}
        </>
      )}
    </SettingsPageLayout>
  );
}
