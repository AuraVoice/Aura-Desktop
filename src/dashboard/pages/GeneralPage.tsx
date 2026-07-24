import { useEffect, useState } from "react";
import { hotkeyHints } from "../../lib/copy";
import {
  DEFAULT_GENERAL_SETTINGS,
  loadGeneralSettings,
  saveGeneralSettings,
  type GeneralSettings,
} from "../../lib/generalSettings";
import { logError } from "../../lib/log";

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="db-setting-row">
      <span>
        <span className="db-setting-label">{label}</span>
        <span className="db-setting-description">{description}</span>
      </span>
      <input
        className="db-setting-toggle"
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function GeneralPage() {
  const [settings, setSettings] = useState<GeneralSettings>(DEFAULT_GENERAL_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);

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
        logError("GeneralPage: load settings", err);
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
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
      logError("GeneralPage: save settings", err);
      setSettings(previous);
      setSaveError(true);
    }
  }

  if (!loaded) return <div className="db-page"><div className="db-state db-muted">Loading settings...</div></div>;

  return (
    <div className="db-page db-page-wide">
      <section className="db-settings-section">
        <div className="db-settings-heading">
          <h2>Briefing and calendar</h2>
          <p>Choose which ambient information Aura shows on this PC.</p>
        </div>
        <div className="db-panel db-settings-panel">
          <ToggleRow
            label="Daily catch-up"
            description="Show one short personalized catch-up in the overlay each day."
            checked={settings.dailyCatchUp}
            onChange={(value) => void update("dailyCatchUp", value)}
          />
          <ToggleRow
            label="Daily briefing"
            description="Build a Today view from meetings, drafts, saved items, and activity."
            checked={settings.dailyBriefing}
            onChange={(value) => void update("dailyBriefing", value)}
          />
          <ToggleRow
            label="Calendar in briefing"
            description="Include connected Google Calendar events in Today."
            checked={settings.calendarInBriefing}
            onChange={(value) => void update("calendarInBriefing", value)}
          />
          <ToggleRow
            label="Calendar in overlay"
            description="Allow the compact Aura overlay to show today's agenda."
            checked={settings.calendarOverlay}
            onChange={(value) => void update("calendarOverlay", value)}
          />
        </div>
      </section>

      <section className="db-settings-section">
        <div className="db-settings-heading">
          <h2>Privacy and motion</h2>
          <p>These preferences apply to this Windows device.</p>
        </div>
        <div className="db-panel db-settings-panel">
          <ToggleRow
            label="Detailed notification previews"
            description="Show meeting titles and message details in Windows notifications."
            checked={settings.sensitiveNotificationPreviews}
            onChange={(value) => void update("sensitiveNotificationPreviews", value)}
          />
          <ToggleRow
            label="Reduce motion"
            description="Use fades instead of pulsing keycaps and larger transitions."
            checked={settings.reduceMotion}
            onChange={(value) => void update("reduceMotion", value)}
          />
        </div>
      </section>

      <section className="db-settings-section">
        <div className="db-settings-heading">
          <h2>Keyboard shortcuts</h2>
          <p>These shortcuts work globally while Aura is running.</p>
        </div>
        <div className="db-panel db-shortcut-list">
          {Object.values(hotkeyHints).map((hint) => (
            <div className="db-shortcut-row" key={hint.action}>
              <span>{hint.action}</span>
              <span className="db-shortcut-keys">
                {hint.keys.map((key) => <kbd key={key}>{key}</kbd>)}
              </span>
            </div>
          ))}
          <div className="db-shortcut-row">
            <span>toggle Guide Mode</span>
            <span className="db-shortcut-keys"><kbd>Ctrl</kbd><kbd>Alt</kbd><kbd>G</kbd></span>
          </div>
        </div>
      </section>

      {saveError && <p className="db-settings-error">That preference could not be saved. Your previous setting was restored.</p>}
    </div>
  );
}
