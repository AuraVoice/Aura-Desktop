import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { logError } from "../../lib/log";
import {
  loadDictationConsent,
  setDictationConsent,
} from "../../lib/dictationConsent";
import {
  loadPolishSettings,
  savePolishSettings,
  type PolishSettings,
} from "../../lib/dictationPolish";
import { dictationConsent as consentCopy, dictationChord as chordCopy } from "../../lib/copy";
import { chordLabelOf, useDictationStatus } from "../../lib/dictationStatus";
import { SettingsPageLayout, SettingsSection } from "../components/SettingsPageLayout";
import { useDashboardUser } from "../useDashboardUser";

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
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
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

/**
 * The AI formatting section owns its own state: it talks to its own Rust
 * store and none of its state is shared with the rest of the page.
 */
function PolishSection({ signedIn }: { signedIn: boolean }) {
  const [polish, setPolish] = useState<PolishSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadPolishSettings()
      .then((saved) => {
        if (active) setPolish(saved);
      })
      .catch((err) => {
        logError("DictationPage: polish load", err);
        if (active) setError("AI formatting settings could not be read.");
      });
    return () => {
      active = false;
    };
  }, []);

  if (polish === null) {
    return error ? <p className="db-trace-note">{error}</p> : null;
  }

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      setPolish(await savePolishSettings({ enabled }));
    } catch (err) {
      logError("DictationPage: polish toggle", err);
      setError("The change could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title="AI formatting"
      description="Optional cleanup of each dictation before the words are typed."
    >
      <div className="db-panel db-settings-panel">
        <ToggleRow
          label="Clean up my dictation with AI"
          description="When this is on, the finished transcript (text only, never audio) is sent to Aura's servers to fix punctuation, remove filler words, and apply spoken commands like 'new paragraph'. Off by default. If the service is slow or unreachable, the unformatted text is typed instead."
          checked={polish.enabled}
          disabled={busy || !signedIn}
          onChange={(value) => void toggle(value)}
        />
        {!signedIn && (
          <p className="db-trace-note">
            Sign in to use AI formatting. The cleanup runs against your account,
            like transcription itself.
          </p>
        )}
        {error && <p className="db-trace-note">{error}</p>}
      </div>

      <p className="db-trace-privacy">
        <ShieldCheck size={14} />
        Only the transcript text of each dictation is sent, and nothing about it
        is stored after the cleaned text comes back.
      </p>
    </SettingsSection>
  );
}

export function DictationPage() {
  // Dictation now needs an account too, not just sharing: transcription runs
  // against a service, and the credential for it is minted per session.
  const signedIn = useDashboardUser() !== null;
  const [onlineAccepted, setOnlineAccepted] = useState<boolean | null>(null);
  const dictationStatus = useDictationStatus();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    loadDictationConsent()
      .then((state) => {
        if (active) setOnlineAccepted(state.accepted);
      })
      .catch((err) => {
        logError("DictationPage: load consent", err);
        // Unknown, not "on". This section says whether audio leaves the
        // machine, so it must never claim consent it could not read.
        if (active) setOnlineAccepted(null);
      });
    return () => {
      active = false;
    };
  }, []);

  async function updateOnlineConsent(accepted: boolean) {
    setBusy("consent");
    setError(null);
    try {
      const state = await setDictationConsent(accepted);
      setOnlineAccepted(state.accepted);
    } catch (err) {
      logError("DictationPage: set consent", err);
      setError("That setting could not be saved on this device.");
    } finally {
      setBusy(null);
    }
  }

  const intro =
    "Hold the dictation keys, speak, and the words are typed where you were. Your speech is transcribed online while you hold them.";

  return (
    <SettingsPageLayout title="Dictation" description={intro}>
      <SettingsSection
        title={chordCopy.sectionHeading}
        description={chordCopy.sectionDescription(chordLabelOf(dictationStatus))}
      >
        <div className="db-panel db-settings-panel">
          <div className="db-setting-row">
            <span>
              <span className="db-setting-label">{chordCopy.rowLabel}</span>
              <span className="db-setting-description">
                {chordCopy.fixedNote(chordLabelOf(dictationStatus))}
              </span>
            </span>
            <span className="db-setting-label">{chordCopy.fixed}</span>
          </div>
          <div className="db-setting-row">
            <span className="db-setting-label">{chordCopy.statusLabel}</span>
            <span className="db-setting-description">
              {dictationStatus === null
                ? chordCopy.statusChecking
                : dictationStatus.available
                  ? chordCopy.statusReady
                  : dictationStatus.reason}
            </span>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={consentCopy.settingsHeading}
        description={consentCopy.body}
      >
        <div className="db-panel db-settings-panel">
          <ToggleRow
            label={
              onlineAccepted
                ? consentCopy.enabledLabel
                : consentCopy.disabledLabel
            }
            description={consentCopy.detail}
            checked={onlineAccepted === true}
            disabled={busy === "consent" || onlineAccepted === null}
            onChange={(value) => void updateOnlineConsent(value)}
          />
          {onlineAccepted === false && (
            <p className="db-trace-note">{consentCopy.offNotice}</p>
          )}
          {onlineAccepted === null && (
            <p className="db-trace-note">
              This setting could not be read on this device, so dictation will
              ask again the next time you use it.
            </p>
          )}
          {onlineAccepted === true && !signedIn && (
            <p className="db-trace-note">
              Sign in to dictate. Transcription runs against your account, so the
              keys will not type anything while you are signed out.
            </p>
          )}
        </div>

        <p className="db-trace-privacy">
          <ShieldCheck size={14} />
          Online transcription runs only while you are holding the keys, and
          nothing you dictate is stored on this PC.
        </p>
      </SettingsSection>

      <PolishSection signedIn={signedIn} />

      {error && <p className="db-settings-error">{error}</p>}
    </SettingsPageLayout>
  );
}
