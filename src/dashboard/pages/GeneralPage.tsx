import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_GENERAL_SETTINGS,
  IMPROVEMENT_CONSENT_VERSION,
  loadGeneralSettings,
  saveGeneralSettings,
  type GeneralSettings,
} from "../../lib/generalSettings";
import { logError } from "../../lib/log";
import { resetHotkeyBindings } from "../../lib/hotkeys";
import { useHotkeyBindings } from "../../state/useHotkeyBindings";
import { ShortcutEditorDialog } from "../../overlay/ShortcutEditorDialog";
import {
  SettingsPageLayout,
  SettingsSection,
} from "../components/SettingsPageLayout";

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

export type GeneralPageSection = "general" | "system" | "privacy";

const PAGE_COPY: Record<GeneralPageSection, { title: string; description: string }> = {
  general: {
    title: "General",
    description: "Choose what Aura brings into your day.",
  },
  system: {
    title: "System",
    description: "Control desktop behavior and change Aura's keyboard shortcuts.",
  },
  privacy: {
    title: "Data and privacy",
    description: "Control optional data sharing and what Aura may show outside the app.",
  },
};

export function GeneralPage({ section = "general" }: { section?: GeneralPageSection }) {
  const { bindings: hotkeyBindings, voice: voiceHotkey } = useHotkeyBindings();
  const [editingShortcut, setEditingShortcut] = useState<{ id: string; label: string } | null>(null);
  const [resettingShortcuts, setResettingShortcuts] = useState(false);
  const [shortcutResetError, setShortcutResetError] = useState<string | null>(null);
  const [settings, setSettings] = useState<GeneralSettings>(DEFAULT_GENERAL_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);
  // Launch-at-startup is NOT part of GeneralSettings: autostart.rs owns it in
  // its own store and the checkbox reflects the real registry entry, so a
  // failed write shows as off instead of lying. Same source of truth as the
  // tray's "Start with Windows" item, which stays in sync automatically.
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const pageCopy = PAGE_COPY[section];

  useEffect(() => {
    if (section !== "system") return;
    invoke<boolean>("autostart_enabled")
      .then(setLaunchAtStartup)
      .catch((err) => logError("GeneralPage: read autostart", err));
  }, [section]);

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

  async function updateImprovementChoice(
    key: "improveConversations" | "improveActions",
    value: boolean,
  ) {
    const previous = settings;
    const next = { ...settings, [key]: value };
    next.improvementConsentVersion = next.improveConversations || next.improveActions
      ? IMPROVEMENT_CONSENT_VERSION
      : 0;
    setSettings(next);
    setSaveError(false);
    try {
      await saveGeneralSettings(next);
    } catch (err) {
      logError("GeneralPage: save improvement consent", err);
      setSettings(previous);
      setSaveError(true);
    }
  }

  // Persist first, then apply to the live window. Unlike the other System
  // toggles there is no store subscriber for this one: dashboard.rs reads the
  // preference when it BUILDS the window (so the taskbar button never flickers
  // on a fresh open), which means an already-open window has to be told here.
  async function updateTaskbarVisibility(value: boolean) {
    await update("showInTaskbar", value);
    try {
      await invoke("set_dashboard_in_taskbar", { visible: value });
    } catch (err) {
      logError("GeneralPage: set taskbar visibility", err);
    }
  }

  // The command returns the resulting REAL state rather than the requested
  // one, so a registry write that silently failed flips the toggle back
  // instead of leaving the user believing it stuck.
  async function updateLaunchAtStartup(value: boolean) {
    setLaunchAtStartup(value);
    setSaveError(false);
    try {
      setLaunchAtStartup(await invoke<boolean>("set_autostart_enabled", { enabled: value }));
    } catch (err) {
      logError("GeneralPage: set autostart", err);
      setLaunchAtStartup(!value);
      setSaveError(true);
    }
  }

  if (!loaded) {
    return (
      <SettingsPageLayout title={pageCopy.title} description={pageCopy.description}>
        <div className="db-panel db-state db-muted">Loading settings...</div>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout title={pageCopy.title} description={pageCopy.description}>
      {section === "general" && (
        <SettingsSection
          title="Briefing and calendar"
          description="Control the information Aura brings into your day."
        >
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
        </SettingsSection>
      )}

      {section === "system" && (
        <>
          <SettingsSection
            title="App settings"
            description="These preferences apply only to this Windows device."
          >
            <div className="db-panel db-settings-panel">
              <ToggleRow
                label="Open Aura when Windows starts"
                description="Open the Aura dashboard automatically after you sign in to Windows."
                checked={launchAtStartup}
                onChange={(value) => void updateLaunchAtStartup(value)}
              />
              <ToggleRow
                label="Show the Aura bar at all times"
                description="Keep the bar on screen instead of hiding it until you summon it."
                checked={settings.alwaysShowBar}
                onChange={(value) => void update("alwaysShowBar", value)}
              />
              <ToggleRow
                label="Show Aura in the taskbar"
                description="Give this window a taskbar button. Aura stays reachable from the tray either way."
                checked={settings.showInTaskbar}
                onChange={(value) => void updateTaskbarVisibility(value)}
              />
              <ToggleRow
                label="Reduce motion"
                description="Use fades instead of pulsing keycaps and larger transitions."
                checked={settings.reduceMotion}
                onChange={(value) => void update("reduceMotion", value)}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Sound"
            description="Audio cues while you dictate and when Aura notifies you."
          >
            <div className="db-panel db-settings-panel">
              <ToggleRow
                label="Dictation and notification sounds"
                description="Play a short cue when dictation starts and ends, and let notifications chime."
                checked={settings.dictationSounds}
                onChange={(value) => void update("dictationSounds", value)}
              />
              <ToggleRow
                label="Mute other apps while dictating"
                description="Silence music and other audio for the length of a dictation, then restore it."
                checked={settings.muteOthersWhileDictating}
                onChange={(value) => void update("muteOthersWhileDictating", value)}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Notifications"
            description="Choose which kinds of updates Aura may send you."
          >
            <div className="db-panel db-settings-panel">
              <ToggleRow
                label="Suggestions"
                description="Tips about getting set up or getting more out of Aura."
                checked={settings.notifySuggestions}
                onChange={(value) => void update("notifySuggestions", value)}
              />
              <ToggleRow
                label="Announcements"
                description="New features and capabilities."
                checked={settings.notifyAnnouncements}
                onChange={(value) => void update("notifyAnnouncements", value)}
              />
              <ToggleRow
                label="Milestones"
                description="Streaks and activity milestones as you use Aura."
                checked={settings.notifyMilestones}
                onChange={(value) => void update("notifyMilestones", value)}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Keyboard shortcuts"
            description="Use Aura from anywhere while it is running. Pick whatever keys suit you."
          >
            <div className="db-panel db-shortcut-list">
              {voiceHotkey && (
                <div className="db-shortcut-row">
                  <span>Start or end voice</span>
                  <span className="db-shortcut-keys">
                    {voiceHotkey.keys.map((key, index) => <kbd key={`${key}:${index}`}>{key}</kbd>)}
                    {voiceHotkey.gesture === "doubleTap" && <kbd>twice</kbd>}
                  </span>
                  <button
                    type="button"
                    className="db-shortcut-change"
                    onClick={() => setEditingShortcut({ id: "voice", label: "Start or end voice" })}
                  >
                    Change
                  </button>
                </div>
              )}
              {hotkeyBindings.map((binding) => (
                <div className="db-shortcut-row" key={binding.id}>
                  <span>{binding.label}</span>
                  <span className="db-shortcut-keys">
                    {binding.keys.map((key, index) => <kbd key={`${key}:${index}`}>{key}</kbd>)}
                  </span>
                  <button
                    type="button"
                    className="db-shortcut-change"
                    onClick={() => setEditingShortcut({ id: binding.id, label: binding.label })}
                  >
                    Change
                  </button>
                </div>
              ))}
            </div>
            <div className="db-shortcut-footer">
              <button
                type="button"
                className="db-shortcut-reset"
                disabled={resettingShortcuts}
                onClick={() => {
                  setResettingShortcuts(true);
                  setShortcutResetError(null);
                  resetHotkeyBindings()
                    .catch((err) => {
                      logError("GeneralPage: reset shortcuts", err);
                      setShortcutResetError(err instanceof Error ? err.message : String(err));
                    })
                    .finally(() => setResettingShortcuts(false));
                }}
              >
                {resettingShortcuts ? "Resetting..." : "Reset to defaults"}
              </button>
              {shortcutResetError && <span className="db-shortcut-reset-error">{shortcutResetError}</span>}
            </div>
          </SettingsSection>

          {editingShortcut && (
            <ShortcutEditorDialog
              id={editingShortcut.id}
              label={editingShortcut.label}
              bindings={hotkeyBindings}
              voice={voiceHotkey}
              // useHotkeyBindings already re-reads from the change events Rust
              // emits on save, so there is nothing to push back up here.
              onSavedBindings={() => {}}
              onSavedVoice={() => {}}
              onClose={() => setEditingShortcut(null)}
            />
          )}
        </>
      )}

      {section === "privacy" && (
        <>
          <SettingsSection
            title="Improvement preferences"
            description="Control optional data sharing for voice and screen-aware improvements."
          >
            <div className="db-panel db-settings-panel">
              <ToggleRow
                label="Conversation samples"
                description="Save an opt-in preference for selected voice recordings and transcripts."
                checked={settings.improveConversations}
                onChange={(value) => void updateImprovementChoice("improveConversations", value)}
              />
              <ToggleRow
                label="Action samples"
                description="Save an opt-in preference for selected screen context, corrections, and outcomes."
                checked={settings.improveActions}
                onChange={(value) => void updateImprovementChoice("improveActions", value)}
              />
            </div>
          </SettingsSection>

          <SettingsSection
            title="Notification privacy"
            description="Control what appears outside the Aura window."
          >
            <div className="db-panel db-settings-panel">
              <ToggleRow
                label="Detailed notification previews"
                description="Show meeting titles and message details in Windows notifications."
                checked={settings.sensitiveNotificationPreviews}
                onChange={(value) => void update("sensitiveNotificationPreviews", value)}
              />
            </div>
          </SettingsSection>
        </>
      )}

      {saveError && <p className="db-settings-error">That preference could not be saved. Your previous setting was restored.</p>}
    </SettingsPageLayout>
  );
}
