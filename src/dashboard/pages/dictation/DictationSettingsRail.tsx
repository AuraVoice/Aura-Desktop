import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { relaunch } from "@tauri-apps/plugin-process";
import { logError } from "../../../lib/log";
import { requestDoubleTapPermission } from "../../../lib/hotkeys";
import {
  loadDictationConsent,
  setDictationConsent,
} from "../../../lib/dictationConsent";
import {
  loadPolishSettings,
  savePolishSettings,
  type PolishSettings,
} from "../../../lib/dictationPolish";
import {
  setDictationHistoryEnabled,
  type DictationHistorySettings,
} from "../../../lib/dictationHistory";
import { dictationConsent as consentCopy, dictationChord as chordCopy } from "../../../lib/copy";
import { chordKeysOf, useDictationStatus } from "../../../lib/dictationStatus";
import { bytes as formatBytes } from "../../format";
import { deviceNoun } from "../../../lib/platformKeys";

/**
 * The right-hand column of the Dictation page: everything that used to be the
 * whole page, stacked into one narrow rail so the transcript list does not run
 * the full width of the window, plus the history controls this feature adds.
 *
 * Each section still owns its own state and its own Rust store, exactly as
 * before. Nothing here was rewritten; it was moved.
 */
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

function RailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="db-dictation-rail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function DictationSettingsRail({
  uid,
  signedIn,
  historySettings,
  onHistoryChanged,
  onClearHistory,
}: {
  uid: string | null;
  signedIn: boolean;
  historySettings: DictationHistorySettings | null;
  onHistoryChanged: (settings: DictationHistorySettings) => void;
  onClearHistory: () => void;
}) {
  const dictationStatus = useDictationStatus();
  const [onlineAccepted, setOnlineAccepted] = useState<boolean | null>(null);
  const [polish, setPolish] = useState<PolishSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permissionAsked, setPermissionAsked] = useState(false);

  useEffect(() => {
    let active = true;
    loadDictationConsent()
      .then((state) => {
        if (active) setOnlineAccepted(state.accepted);
      })
      .catch((err) => {
        logError("DictationSettingsRail: load consent", err);
        // Unknown, not "on". This section says whether audio leaves the
        // machine, so it must never claim consent it could not read.
        if (active) setOnlineAccepted(null);
      });
    loadPolishSettings()
      .then((saved) => {
        if (active) setPolish(saved);
      })
      .catch((err) => logError("DictationSettingsRail: polish load", err));
    return () => {
      active = false;
    };
  }, []);

  async function updateOnlineConsent(accepted: boolean) {
    setBusy("consent");
    setError(null);
    try {
      setOnlineAccepted((await setDictationConsent(accepted)).accepted);
    } catch (err) {
      logError("DictationSettingsRail: set consent", err);
      setError("That setting could not be saved on this device.");
    } finally {
      setBusy(null);
    }
  }

  async function updatePolish(enabled: boolean) {
    setBusy("polish");
    setError(null);
    try {
      setPolish(await savePolishSettings({ enabled }));
    } catch (err) {
      logError("DictationSettingsRail: polish toggle", err);
      setError("The change could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function updateHistory(enabled: boolean) {
    if (!uid) return;
    setBusy("history");
    setError(null);
    try {
      onHistoryChanged(await setDictationHistoryEnabled(uid, enabled));
    } catch (err) {
      logError("DictationSettingsRail: history toggle", err);
      setError("The change could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <aside className="db-dictation-rail" aria-label="Dictation settings">
      <RailSection title={chordCopy.sectionHeading}>
        <div className="db-setting-row">
          <span>
            <span className="db-setting-label">{chordCopy.rowLabel}</span>
            <span className="db-setting-description">{chordCopy.fixedNote}</span>
          </span>
          <span className="db-shortcut-keys db-chord-flash">
            {chordKeysOf(dictationStatus).map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
          </span>
        </div>
        {/* Only surfaced when something is actually wrong. A permanent "Ready"
            row is a line of furniture that says nothing on every normal day. */}
        {dictationStatus !== null && !dictationStatus.available && (
          <p className="db-trace-note">{dictationStatus.reason}</p>
        )}
        {/* macOS: the chord's event tap needs Input Monitoring, and the grant
            is read once at launch, so both paths end in a restart. The request
            below is the same IOHIDRequestAccess the double-tap trigger uses. */}
        {dictationStatus?.blocker === "inputMonitoring" && (
          <div className="db-trace-actions">
            <button
              type="button"
              className="db-trace-action"
              onClick={() => {
                setPermissionAsked(true);
                void requestDoubleTapPermission().catch((err) =>
                  logError("DictationSettingsRail: input monitoring", err),
                );
              }}
            >
              {chordCopy.allowInputMonitoring}
            </button>
            {permissionAsked && (
              <>
                <p className="db-trace-note">{chordCopy.restartNote}</p>
                <button type="button" className="db-trace-action" onClick={() => void relaunch()}>
                  {chordCopy.restart}
                </button>
              </>
            )}
          </div>
        )}
        {dictationStatus?.blocker === "relaunch" && (
          <div className="db-trace-actions">
            <button type="button" className="db-trace-action" onClick={() => void relaunch()}>
              {chordCopy.restart}
            </button>
          </div>
        )}
      </RailSection>

      <RailSection title={consentCopy.settingsHeading}>
        <ToggleRow
          label={onlineAccepted ? consentCopy.enabledLabel : consentCopy.disabledLabel}
          description={consentCopy.detail}
          checked={onlineAccepted === true}
          disabled={busy === "consent" || onlineAccepted === null}
          onChange={(value) => void updateOnlineConsent(value)}
        />
        {onlineAccepted === false && <p className="db-trace-note">{consentCopy.offNotice}</p>}
        {onlineAccepted === true && !signedIn && (
          <p className="db-trace-note">
            Sign in to dictate. Transcription runs against your account, so the
            keys will not type anything while you are signed out.
          </p>
        )}
      </RailSection>

      <RailSection title="AI formatting">
        {polish && (
          <ToggleRow
            label="Clean up my dictation with AI"
            description="Sends the finished transcript (text only, never audio) to Aura's servers to fix punctuation and remove filler words. Off by default."
            checked={polish.enabled}
            disabled={busy === "polish" || !signedIn}
            onChange={(value) => void updatePolish(value)}
          />
        )}
      </RailSection>

      <RailSection title="Dictation history">
        <ToggleRow
          label="Save dictation history"
          description={`Keeps each finished dictation and its audio encrypted on this ${deviceNoun()} so you can replay it here. Off keeps nothing, anywhere.`}
          checked={historySettings?.enabled ?? true}
          disabled={busy === "history" || !uid}
          onChange={(value) => void updateHistory(value)}
        />
        {historySettings && historySettings.entryCount > 0 && (
          <p className="db-trace-note">
            {historySettings.entryCount} dictation
            {historySettings.entryCount === 1 ? "" : "s"} kept, using{" "}
            {formatBytes(historySettings.audioBytes)} of audio.
          </p>
        )}
        <button
          type="button"
          className="db-local-delete"
          onClick={onClearHistory}
          disabled={!uid || (historySettings?.entryCount ?? 0) === 0}
        >
          Clear history
        </button>
      </RailSection>

      <p className="db-trace-privacy">
        <ShieldCheck size={14} />
        Online transcription runs only while you hold the keys; what you
        dictate never leaves this machine.
      </p>

      {error && <p className="db-settings-error">{error}</p>}
    </aside>
  );
}
