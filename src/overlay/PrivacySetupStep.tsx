import { useEffect, useState } from "react";
import { platform } from "@tauri-apps/plugin-os";
import { AudioLines, Check, Keyboard, Mic, Monitor, MousePointer2 } from "lucide-react";
import {
  DEFAULT_GENERAL_SETTINGS,
  IMPROVEMENT_CONSENT_VERSION,
  loadGeneralSettings,
  saveGeneralSettings,
  type GeneralSettings,
} from "../lib/generalSettings";
import { trackEvent } from "../lib/analytics";
import { trackOnboardingStepCompleted } from "../lib/acquisitionAnalytics";
import { recordDesktopOnboardingEvent } from "../lib/profile";
import { logError } from "../lib/log";
import "./PrivacySetupStep.css";

type MicrophoneStatus = "idle" | "checking" | "granted" | "denied" | "unavailable";

/** The trailing control for a feature row the user can actually decide about.
 * Styled in this step's own CSS rather than reusing the dashboard's ToggleRow:
 * this step also renders in the overlay window, which never loads dashboard.css
 * or the --db-* tokens, so a db- class here would be a bare checkbox. */
function FeatureSwitch({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="privacy-row-switch">
      <span className="privacy-row-switch-label">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

export function PrivacySetupStep({
  onContinue,
}: {
  onContinue: () => void;
}) {
  const [settings, setSettings] = useState<GeneralSettings>(DEFAULT_GENERAL_SETTINGS);
  const [resolved, setResolved] = useState(false);
  const [microphoneStatus, setMicrophoneStatus] = useState<MicrophoneStatus>("idle");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingNoSharing, setConfirmingNoSharing] = useState(false);
  const isMac = platform() === "macos";
  useEffect(() => {
    let cancelled = false;
    loadGeneralSettings()
      .then((saved) => {
        if (!cancelled) {
          setSettings(saved);
          setResolved(true);
        }
      })
      .catch((err) => {
        logError("PrivacySetupStep: load settings", err);
        if (!cancelled) {
          setError("Aura couldn't load your privacy choices.");
          setResolved(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function checkMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setMicrophoneStatus("unavailable");
      return;
    }
    setMicrophoneStatus("checking");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      setMicrophoneStatus("granted");
    } catch (err) {
      logError("PrivacySetupStep: microphone permission", err);
      setMicrophoneStatus("denied");
    }
  }

  function setChoice(
    key: "chatScreenshots" | "voiceScreenContext" | "improveConversations" | "improveActions",
    checked: boolean,
  ) {
    setSettings((current) => ({ ...current, [key]: checked }));
  }

  async function saveAndContinue() {
    if (saving) return;
    setSaving(true);
    setError(null);
    const anyImprovementSharing = settings.improveConversations || settings.improveActions;
    try {
      await saveGeneralSettings({
        ...settings,
        improvementConsentVersion: anyImprovementSharing ? IMPROVEMENT_CONSENT_VERSION : 0,
      });
      const properties = {
        improve_conversations: settings.improveConversations,
        improve_actions: settings.improveActions,
        improvement_consent_version: anyImprovementSharing ? IMPROVEMENT_CONSENT_VERSION : 0,
        microphone_status: microphoneStatus,
      };
      trackEvent("desktop_privacy_setup_saved", properties);
      await recordDesktopOnboardingEvent(
        "desktop_privacy_setup_saved",
        properties,
        "privacy_setup_saved",
      );
      void trackOnboardingStepCompleted("privacy_setup");
      onContinue();
    } catch (err) {
      logError("PrivacySetupStep: save settings", err);
      setError("Aura couldn't save your choices. Please try again.");
      setSaving(false);
    }
  }

  function requestContinue() {
    if (!settings.improveConversations && !settings.improveActions) {
      setConfirmingNoSharing(true);
      return;
    }
    void saveAndContinue();
  }

  if (!resolved) return null;

  const microphoneLabel = microphoneStatus === "checking"
    ? "Checking..."
    : microphoneStatus === "granted"
      ? "Ready"
      : microphoneStatus === "denied"
        ? "Try again"
        : "Check microphone";

  return (
    <div className="onboarding-step privacy-setup-step">
      <div className="privacy-setup-heading">
        <div>
          <h2>You're in control</h2>
          <p>Review how Aura uses your microphone and screen. Improvement preferences are optional.</p>
        </div>
      </div>

      <section className="privacy-setup-section" aria-labelledby="feature-access-heading">
        <div className="privacy-section-heading">
          <h3 id="feature-access-heading">How features work</h3>
        </div>
        <div className="privacy-feature-list">
          <div className="privacy-feature-row">
            <span className="privacy-row-icon privacy-row-icon-microphone"><Mic size={20} aria-hidden="true" /></span>
            <span className="privacy-row-copy">
              <strong>Microphone</strong>
              <small>Used only while you talk to Buddy, dictate, or record a meeting.</small>
              {microphoneStatus === "denied" && (
                <small className="privacy-row-warning">Access was blocked. You can retry or continue without voice.</small>
              )}
            </span>
            <button
              type="button"
              className={`privacy-permission-button${microphoneStatus === "granted" ? " is-ready" : ""}`}
              disabled={microphoneStatus === "checking" || microphoneStatus === "granted"}
              onClick={() => void checkMicrophone()}
            >
              {microphoneStatus === "granted" && <Check size={15} aria-hidden="true" />}
              {microphoneLabel}
            </button>
          </div>

          <div className="privacy-feature-row">
            <span className="privacy-row-icon privacy-row-icon-desktop"><Monitor size={20} aria-hidden="true" /></span>
            <span className="privacy-row-copy">
              <strong>Text chat screenshot</strong>
              <small>
                Lets you attach what's on screen to a text chat message. Nothing is captured
                until you attach it.
                {isMac ? " macOS may ask for screen access the first time." : ""}
              </small>
            </span>
            <FeatureSwitch
              label="Allow text chat screenshots"
              checked={settings.chatScreenshots}
              onChange={(checked) => setChoice("chatScreenshots", checked)}
            />
          </div>

          <div className="privacy-feature-row">
            <span className="privacy-row-icon privacy-row-icon-voice"><AudioLines size={20} aria-hidden="true" /></span>
            <span className="privacy-row-copy">
              <strong>Voice Screen Sight</strong>
              <small>
                Sends what's on screen with each thing you say during a voice call. Nothing is
                sent while you're silent or not on a call.
              </small>
            </span>
            <FeatureSwitch
              label="Let Aura see your screen while you talk"
              checked={settings.voiceScreenContext}
              onChange={(checked) => setChoice("voiceScreenContext", checked)}
            />
          </div>

          {isMac && (
            <div className="privacy-feature-row">
              <span className="privacy-row-icon"><MousePointer2 size={20} aria-hidden="true" /></span>
              <span className="privacy-row-copy">
                <strong>Accessibility</strong>
                <small>macOS asks when Aura first needs to control text or use system-wide input.</small>
              </span>
              <span className="privacy-status-badge">Asked when needed</span>
            </div>
          )}

          {isMac && (
            <div className="privacy-feature-row">
              <span className="privacy-row-icon"><Keyboard size={20} aria-hidden="true" /></span>
              <span className="privacy-row-copy">
                <strong>Input Monitoring</strong>
                <small>Lets Aura hear the dictation keys in any app. Asked when you turn dictation on.</small>
              </span>
              <span className="privacy-status-badge">Asked when needed</span>
            </div>
          )}
        </div>
      </section>

      <div className="privacy-setup-divider" />

      <section className="privacy-setup-section" aria-labelledby="improvement-heading">
        <div className="privacy-section-heading">
          <h3 id="improvement-heading">Help improve Aura</h3>
        </div>
        <div className="privacy-improvement-grid">
          <label className={`privacy-choice-card${settings.improveConversations ? " is-selected" : ""}`}>
            <span>
              <strong>Conversation samples</strong>
              <small>Save an on-device opt-in for voice samples. Uploads are not active yet.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.improveConversations}
              onChange={(event) => setChoice("improveConversations", event.target.checked)}
            />
          </label>
          <label className={`privacy-choice-card${settings.improveActions ? " is-selected" : ""}`}>
            <span>
              <strong>Action samples</strong>
              <small>Save an on-device opt-in for screen and action samples. Uploads are not active yet.</small>
            </span>
            <input
              type="checkbox"
              checked={settings.improveActions}
              onChange={(event) => setChoice("improveActions", event.target.checked)}
            />
          </label>
        </div>
      </section>

      {error && <p className="privacy-setup-error" role="alert">{error}</p>}
      <div className="privacy-setup-actions">
        <button type="button" className="privacy-skip-button" onClick={requestContinue}>
          Skip for now
        </button>
        <button
          type="button"
          className="privacy-continue-button"
          disabled={saving}
          onClick={requestContinue}
        >
          {saving ? "Saving..." : "Continue"}
        </button>
      </div>

      {confirmingNoSharing && (
        <div className="privacy-confirm-backdrop">
          <div
            className="privacy-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="privacy-confirm-title"
            aria-describedby="privacy-confirm-description"
          >
            <h3 id="privacy-confirm-title">Continue without sharing?</h3>
            <p id="privacy-confirm-description">
              Aura will still work normally and remain personalized. Sharing optional samples may help improve
              future conversation and action quality.
            </p>
            <div className="privacy-confirm-actions">
              <button
                type="button"
                className="privacy-continue-button"
                autoFocus
                onClick={() => setConfirmingNoSharing(false)}
              >
                Review choices
              </button>
              <button
                type="button"
                className="privacy-skip-button"
                disabled={saving}
                onClick={() => void saveAndContinue()}
              >
                Continue without sharing
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
