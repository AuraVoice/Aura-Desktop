import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, Mic, Pause, Play, ShieldCheck, Trash2 } from "lucide-react";
import { logError } from "../../lib/log";
import {
  deleteAllTraces,
  deleteTrace,
  exportTraces,
  formatTraceBytes,
  isGroundTruthClass,
  loadTraceSettings,
  loadTraceSummary,
  loadTraces,
  RETENTION_CHOICES,
  saveTraceSettings,
  traceAudioUrl,
  traceStateLabel,
  type EditOp,
  type TraceRecord,
  type TraceSettings,
  type TraceSummary,
} from "../../lib/dictationTraces";
import {
  loadDictationConsent,
  setDictationConsent,
} from "../../lib/dictationConsent";
import { dictationConsent as consentCopy } from "../../lib/copy";
import { loadDictationStatus, type DictationStatus } from "../../lib/dictationStatus";
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

/** Plays one trace's audio, fetching the bytes only when actually asked. */
function TracePlayer({ traceId, disabled }: { traceId: string; disabled: boolean }) {
  const [playing, setPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  // The object URL and the element both outlive a render, so both are released
  // on unmount rather than left for the garbage collector to find eventually.
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  async function toggle() {
    if (playing) {
      audioRef.current?.pause();
      setPlaying(false);
      return;
    }
    try {
      if (!audioRef.current) {
        const url = await traceAudioUrl(traceId);
        urlRef.current = url;
        const audio = new Audio(url);
        audio.addEventListener("ended", () => setPlaying(false));
        audioRef.current = audio;
      }
      await audioRef.current.play();
      setPlaying(true);
    } catch (err) {
      logError("DictationPage: play trace audio", err);
      setPlaying(false);
    }
  }

  return (
    <button
      type="button"
      className="db-secondary-btn db-trace-play"
      disabled={disabled}
      onClick={() => void toggle()}
      aria-label={playing ? "Pause this recording" : "Play this recording"}
    >
      {playing ? <Pause size={14} /> : <Play size={14} />}
      {playing ? "Pause" : "Play"}
    </button>
  );
}

function EditChip({ edit }: { edit: EditOp }) {
  const trained = isGroundTruthClass(edit.class);
  return (
    <span className={`db-trace-edit${trained ? " db-trace-edit-trained" : ""}`}>
      <span className="db-trace-edit-class">{edit.class}</span>
      {edit.from && <s>{edit.from}</s>}
      {edit.from && edit.to && <span aria-hidden="true">{"->"}</span>}
      {edit.to && <strong>{edit.to}</strong>}
    </span>
  );
}

/** What this trace's sharing state means, or null when it never left. Only the
 * states that say something the user did not already know are rendered:
 * "ineligible" is the resting state for every local-only recording and would be
 * noise on every row. */
function shareLabel(trace: TraceRecord): string | null {
  switch (trace.shareState) {
    case "uploaded":
      return "Shared with Aura";
    case "pending":
      return "Waiting to share";
    case "failed":
      return "Could not share";
    case "ineligible":
      return null;
  }
}

function TraceCard({
  trace,
  busy,
  onDelete,
}: {
  trace: TraceRecord;
  busy: boolean;
  onDelete: () => void;
}) {
  const changed =
    trace.finalText !== null && trace.finalText !== trace.insertedText;
  return (
    <article className="db-trace">
      <header className="db-trace-head">
        <div>
          <strong>{trace.app || "Unknown app"}</strong>
          <span className="db-trace-meta">
            {new Date(trace.recordedAtMs).toLocaleString()}
            {" · "}
            {(trace.audioMs / 1000).toFixed(1)}s
            {" · "}
            {traceStateLabel(trace.state)}
            {shareLabel(trace) && (
              <>
                {" · "}
                <span className="db-trace-share">{shareLabel(trace)}</span>
              </>
            )}
          </span>
        </div>
        <div className="db-trace-actions">
          {trace.hasAudio && <TracePlayer traceId={trace.traceId} disabled={busy} />}
          <button
            type="button"
            className="db-local-delete"
            disabled={busy}
            onClick={onDelete}
            aria-label="Delete this trace"
          >
            <Trash2 size={14} />
            Delete
          </button>
        </div>
      </header>

      <dl className="db-trace-texts">
        <dt>Heard</dt>
        <dd>{trace.rawTranscript}</dd>
        {trace.locallyCorrected && (
          <>
            <dt>Typed</dt>
            <dd>{trace.insertedText}</dd>
          </>
        )}
        {changed && (
          <>
            <dt>You changed it to</dt>
            <dd>{trace.finalText}</dd>
          </>
        )}
      </dl>

      {trace.edits.length > 0 && (
        <div className="db-trace-edits">
          {trace.edits.map((edit, index) => (
            <EditChip edit={edit} key={`${edit.wordIndex}-${index}`} />
          ))}
        </div>
      )}
      {trace.state === "finalized" && trace.edits.length === 0 && (
        <p className="db-trace-note">You left this exactly as it was typed.</p>
      )}
      {trace.state === "unanchored" && (
        <p className="db-trace-note">
          Aura could not follow this text after typing it, so no corrections were
          recorded for it.
        </p>
      )}
    </article>
  );
}

export function DictationPage() {
  // Dictation now needs an account too, not just sharing: transcription runs
  // against a service, and the credential for it is minted per session.
  const signedIn = useDashboardUser() !== null;
  const [onlineAccepted, setOnlineAccepted] = useState<boolean | null>(null);
  const [dictationStatus, setDictationStatus] = useState<DictationStatus | null>(null);
  const [settings, setSettings] = useState<TraceSettings | null>(null);
  const [summary, setSummary] = useState<TraceSummary | null>(null);
  const [traces, setTraces] = useState<TraceRecord[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingWipe, setConfirmingWipe] = useState(false);

  const refresh = useCallback(async (withTraces: boolean) => {
    const [nextSummary, nextTraces] = await Promise.all([
      loadTraceSummary(),
      withTraces ? loadTraces(100) : Promise.resolve<TraceRecord[]>([]),
    ]);
    setSummary(nextSummary);
    if (withTraces) setTraces(nextTraces);
  }, []);

  useEffect(() => {
    let active = true;
    loadTraceSettings()
      .then(async (saved) => {
        if (!active) return;
        setSettings(saved);
        if (saved.enabled) await refresh(true);
      })
      .catch((err) => {
        logError("DictationPage: load", err);
        if (active) setError("Dictation settings could not be loaded on this device.");
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [refresh]);

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

  useEffect(() => {
    let active = true;
    void loadDictationStatus()
      .then((status) => {
        if (active) setDictationStatus(status);
      })
      .catch((err) => logError("DictationPage: load status", err));
    const pending = listen<DictationStatus>("dictation-status-changed", (event) => {
      if (active) setDictationStatus(event.payload);
    });
    return () => {
      active = false;
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  async function updateOnlineConsent(accepted: boolean) {
    setBusy("consent");
    setMessage(null);
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

  async function update(patch: Partial<TraceSettings>) {
    if (!settings) return;
    const previous = settings;
    const next = { ...settings, ...patch };
    setSettings(next);
    setError(null);
    try {
      const saved = await saveTraceSettings({
        enabled: next.enabled,
        captureAudio: next.captureAudio,
        retentionDays: next.retentionDays,
        excludedApps: next.excludedApps,
        sharingEnabled: next.sharingEnabled,
      });
      setSettings(saved);
      if (saved.enabled) await refresh(true);
    } catch (err) {
      logError("DictationPage: save settings", err);
      setSettings(previous);
      setError("That preference could not be saved. Your previous setting was restored.");
    }
  }

  async function runExport() {
    setBusy("export");
    setMessage(null);
    setError(null);
    try {
      const result = await exportTraces(true, true);
      setMessage(
        `Exported ${result.manifestLines} training example${
          result.manifestLines === 1 ? "" : "s"
        } and ${result.correctionEdits} correction${
          result.correctionEdits === 1 ? "" : "s"
        } to ${result.directory}. ${result.styleEdits} writing-style edit${
          result.styleEdits === 1 ? " was" : "s were"
        } kept separate.`,
      );
    } catch (err) {
      logError("DictationPage: export", err);
      setError(typeof err === "string" ? err : "The export could not be written.");
    } finally {
      setBusy(null);
    }
  }

  async function removeOne(traceId: string) {
    setBusy(traceId);
    try {
      await deleteTrace(traceId);
      setTraces((current) => current.filter((trace) => trace.traceId !== traceId));
      await refresh(false);
    } catch (err) {
      logError("DictationPage: delete trace", err);
      setError("That recording could not be deleted.");
    } finally {
      setBusy(null);
    }
  }

  async function removeAll() {
    setBusy("wipe");
    setMessage(null);
    try {
      const removed = await deleteAllTraces();
      setTraces([]);
      setConfirmingWipe(false);
      await refresh(false);
      setMessage(
        `Deleted ${removed} recording${removed === 1 ? "" : "s"}. Your dictation vocabulary was not touched.`,
      );
    } catch (err) {
      logError("DictationPage: delete all", err);
      setError("The recordings could not be deleted.");
    } finally {
      setBusy(null);
    }
  }

  const intro =
    "Hold the dictation keys, speak, and the words are typed where you were. Your speech is transcribed online while you hold them; everything else on this page stays on this PC unless you say otherwise.";

  if (!loaded || !settings) {
    return (
      <SettingsPageLayout title="Dictation" description={intro}>
        <div className="db-panel db-state db-muted">Loading dictation settings...</div>
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout title="Dictation" description={intro}>
      <SettingsSection
        title="Dictation keys"
        description="Hold Ctrl + Win while speaking. Release either key to type the result."
      >
        <div className="db-panel db-settings-panel">
          <div className="db-setting-row">
            <span>
              <span className="db-setting-label">Hold to dictate</span>
              <span className="db-setting-description">
                {(dictationStatus?.chordLabel ?? "Ctrl + Win")} is fixed for every supported app.
              </span>
            </span>
            <span className="db-setting-label">Fixed</span>
          </div>
          <div className="db-setting-row">
            <span className="db-setting-label">Status</span>
            <span className="db-setting-description">
              {dictationStatus === null
                ? "Checking listener..."
                : dictationStatus.available
                  ? "Ready"
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
          Online transcription runs only while you are holding the keys. Local
          recording and cloud sharing are separate choices and start off.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Improve recognition"
        description="Let Aura learn from the words you correct, without any of it leaving this PC."
      >
        <div className="db-panel db-settings-panel">
          <ToggleRow
            label="Improve recognition"
            description="Keep each dictation's audio and text on this PC, and notice when you fix a word afterwards."
            checked={settings.enabled}
            onChange={(value) => void update({ enabled: value })}
          />
          <ToggleRow
            label="Keep the audio"
            description="Without it Aura still records which words you corrected, but the result cannot be used to retrain the model."
            checked={settings.captureAudio}
            disabled={!settings.enabled}
            onChange={(value) => void update({ captureAudio: value })}
          />
          <div className="db-setting-row">
            <span>
              <span className="db-setting-label">Keep recordings for</span>
              <span className="db-setting-description">
                Anything older is deleted automatically, and only the most recent{" "}
                {settings.maxTraces} are kept.
              </span>
            </span>
            <select
              className="db-trace-select"
              value={settings.retentionDays}
              disabled={!settings.enabled}
              onChange={(event) =>
                void update({ retentionDays: Number(event.target.value) })
              }
            >
              {RETENTION_CHOICES.map((days) => (
                <option value={days} key={days}>
                  {days} days
                </option>
              ))}
            </select>
          </div>
        </div>

        <p className="db-trace-privacy">
          <ShieldCheck size={14} />
          Password fields, password managers, and anything that looks like a card
          number or a key are never recorded. Aura only ever keeps the sentence it
          typed, not the rest of the document it typed into.
        </p>
      </SettingsSection>

      <SettingsSection
        title="Share with Aura"
        description="Optional, and separate from the setting above. Recording on your PC is not the same as sending it to us, so this is its own decision."
      >
        <div className="db-panel db-settings-panel">
          <ToggleRow
            label="Help improve dictation for everyone"
            description="Upload eligible finalized audio and transcript data for speech-model evaluation and training. Server copies expire after 180 days or are deleted earlier when you request it."
            checked={settings.sharingEnabled}
            disabled={!settings.enabled || !signedIn}
            onChange={(value) => void update({ sharingEnabled: value })}
          />
          {!settings.enabled && (
            <p className="db-trace-note">
              Turn on "Improve recognition" first. There is nothing to share until
              Aura is keeping recordings.
            </p>
          )}
          {settings.enabled && !signedIn && (
            <p className="db-trace-note">
              Sign in to share. A recording has to belong to an account before it
              can be sent anywhere.
            </p>
          )}
          {settings.sharingEnabled && summary && (
            <p className="db-trace-note">
              {summary.shared} shared, {summary.pendingShare} waiting to send
              {summary.pendingDeletions > 0
                ? `, ${summary.pendingDeletions} waiting to be deleted from our servers`
                : ""}
              .
            </p>
          )}
        </div>

        <p className="db-trace-privacy">
          <ShieldCheck size={14} />
          Only the sentences you dictated are sent, never the documents around
          them. Deleting a recording here also deletes our copy, and turning this
          off deletes everything you have already shared.
        </p>
      </SettingsSection>

      {settings.enabled && (
        <SettingsSection
          title="Stored on this PC"
          description="Export it for training, or delete all of it. Both act only on this device."
        >
          <div className="db-panel db-settings-panel">
            <div className="db-setting-row">
              <span>
                <span className="db-setting-label">
                  {summary?.total ?? 0} recording{summary?.total === 1 ? "" : "s"}
                  {summary ? ` · ${formatTraceBytes(summary.audioBytes)}` : ""}
                </span>
                <span className="db-setting-description">
                  {summary
                    ? `${summary.verified} confirmed after you finished editing, ${summary.withEdits} with corrections.`
                    : "Nothing recorded yet."}
                </span>
              </span>
              <div className="db-trace-storage-actions">
                <button
                  type="button"
                  className="db-primary-btn"
                  disabled={busy !== null || (summary?.total ?? 0) === 0}
                  onClick={() => void runExport()}
                >
                  <Download size={15} />
                  {busy === "export" ? "Exporting..." : "Export training data"}
                </button>
                {confirmingWipe ? (
                  <>
                    <button
                      type="button"
                      className="db-local-delete"
                      disabled={busy !== null}
                      onClick={() => void removeAll()}
                    >
                      {busy === "wipe" ? "Deleting..." : "Yes, delete everything"}
                    </button>
                    <button
                      type="button"
                      className="db-secondary-btn"
                      disabled={busy !== null}
                      onClick={() => setConfirmingWipe(false)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="db-local-delete"
                    disabled={busy !== null || (summary?.total ?? 0) === 0}
                    onClick={() => setConfirmingWipe(true)}
                  >
                    <Trash2 size={15} />
                    Delete everything
                  </button>
                )}
              </div>
            </div>
          </div>
          {settings.exportDirectory && (
            <p className="db-trace-note">Exports are written to {settings.exportDirectory}.</p>
          )}
        </SettingsSection>
      )}

      {settings.enabled && (
        <SettingsSection
          title="Review"
          description="Everything Aura has kept, newest first. Delete anything you would rather it forgot."
        >
          {traces.length === 0 ? (
            <div className="db-panel db-state db-muted">
              <Mic size={15} />
              Nothing recorded yet. Hold the dictation chord and speak, and what you
              said will show up here.
            </div>
          ) : (
            <div className="db-trace-list">
              {traces.map((trace) => (
                <TraceCard
                  key={trace.traceId}
                  trace={trace}
                  busy={busy === trace.traceId}
                  onDelete={() => void removeOne(trace.traceId)}
                />
              ))}
            </div>
          )}
        </SettingsSection>
      )}

      {message && (
        <p className="db-trace-message" role="status">
          {message}
        </p>
      )}
      {error && <p className="db-settings-error">{error}</p>}
    </SettingsPageLayout>
  );
}
