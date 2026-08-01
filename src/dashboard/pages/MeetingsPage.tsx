import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Download,
  FileJson,
  HardDrive,
  LoaderCircle,
  Trash2,
  TriangleAlert,
  Video,
  type LucideIcon,
} from "lucide-react";
import { getMeeting, getMeetings } from "../../lib/dashboardApi";
import { logError } from "../../lib/log";
import { meetingFailureCopy, meetingNotes } from "../../lib/meetingCopy";
import {
  retryMeeting,
  type MeetingDoc,
  type MeetingProcessingStage,
} from "../../lib/meetings";
import { CardGrid } from "../components/CardGrid";
import type { CardModel } from "../components/DashboardCard";
import { EmptyState } from "../components/EmptyState";
import { PageError } from "../components/PageError";
import { RefreshIndicator } from "../components/RefreshIndicator";
import { shortDateTime } from "../format";
import { useDashboardResource } from "../useDashboardResource";

interface LocalRecording {
  meetingId: string;
  captureRunId: string;
  eventId: string;
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  retainLocalUntilMs: number | null;
  segmentCount: number;
  byteLength: number;
  exportable: boolean;
  deletionState: string | null;
  lastErrorCode: string | null;
}

interface ExportResult {
  path: string;
  segmentCount: number;
  includedAudio: boolean;
}

type MeetingVisualState = "ready" | "processing" | "failed";

const processingLabels: Partial<Record<MeetingProcessingStage, string>> = {
  capturing: "Capturing",
  uploading: "Uploading",
  queued: "Queued",
  transcribing: "Transcribing",
  building_insights: "Building insights",
};

function visualState(meeting: MeetingDoc): MeetingVisualState {
  if (meeting.status === "ready") return "ready";
  if (meeting.status === "failed" || meeting.status === "excluded") return "failed";
  return "processing";
}

function statusIcon(meeting: MeetingDoc): LucideIcon {
  const state = visualState(meeting);
  if (state === "ready") return Video;
  if (state === "failed") return TriangleAlert;
  return LoaderCircle;
}

function statusLabel(meeting: MeetingDoc): string {
  if (meeting.status === "ready") return "Ready";
  if (meeting.status === "excluded") return "Skipped";
  if (meeting.status === "failed") return "Failed";
  return meeting.processingStage
    ? processingLabels[meeting.processingStage] ?? "Processing"
    : "Processing";
}

function stateCopy(meeting: MeetingDoc): string {
  if (meeting.status === "failed" || meeting.status === "excluded") {
    return meetingFailureCopy(meeting.failureCode);
  }
  if (meeting.processingStage === "transcribing") return meetingNotes.processingTranscript;
  if (meeting.processingStage === "building_insights") return meetingNotes.buildingInsights;
  return meetingNotes.processing;
}

function meetingToCard(meeting: MeetingDoc): CardModel {
  const state = visualState(meeting);
  return {
    id: meeting.meetingId,
    badge: { Icon: statusIcon(meeting), label: statusLabel(meeting) },
    title: meeting.title || "Untitled meeting",
    meta: shortDateTime(meeting.createdAt),
    preview:
      state === "ready"
        ? meeting.note?.summary || meetingNotes.processing
        : stateCopy(meeting),
  };
}

function NoteList({ items }: { items: string[] }) {
  return (
    <ul className="db-meeting-list">
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>{item}</li>
      ))}
    </ul>
  );
}

function MeetingDetail({
  meeting,
  onBack,
  onListReload,
}: {
  meeting: MeetingDoc;
  onBack: () => void;
  onListReload: () => void;
}) {
  const detail = useDashboardResource<MeetingDoc | null>(
    `meeting:${meeting.meetingId}`,
    (signal) => getMeeting(meeting.meetingId, signal),
  );
  const current = detail.data ?? meeting;
  const state = visualState(current);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);

  const handleRetry = async () => {
    setRetrying(true);
    setRetryError(false);
    try {
      await retryMeeting(current.meetingId);
      onListReload();
      detail.reload();
    } catch (err) {
      logError("MeetingsPage: retry meeting", err);
      setRetryError(true);
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="db-meeting-detail">
      <div className="db-meeting-detail-bar">
        <button type="button" className="db-meeting-back" onClick={onBack}>
          <ArrowLeft size={17} /> Back to meetings
        </button>
        <RefreshIndicator
          refreshing={detail.refreshing}
          stale={detail.stale || detail.error}
          cachedAt={detail.cachedAt}
          onRetry={detail.reload}
        />
      </div>

      <div className="db-meeting-heading-row">
        <div>
          <h1 className="db-meeting-title">{current.title || "Untitled meeting"}</h1>
          <p className="db-detail-meta">{shortDateTime(current.createdAt)}</p>
        </div>
        <span className={`db-tag db-tag-${state}`}>{statusLabel(current)}</span>
      </div>

      {state === "ready" && current.note ? (
        <div className="db-detail db-meeting-note">
          {current.note.summary && (
            <section className="db-meeting-section">
              <h2>Summary</h2>
              <p className="db-detail-text">{current.note.summary}</p>
            </section>
          )}
          {current.note.decisions.length > 0 && (
            <section className="db-meeting-section">
              <h2>{meetingNotes.decisionsHeading}</h2>
              <NoteList items={current.note.decisions} />
            </section>
          )}
          {current.note.actionItems.length > 0 && (
            <section className="db-meeting-section">
              <h2>{meetingNotes.actionItemsHeading}</h2>
              <NoteList items={current.note.actionItems} />
            </section>
          )}
          {current.note.openQuestions.length > 0 && (
            <section className="db-meeting-section">
              <h2>Open questions</h2>
              <NoteList items={current.note.openQuestions} />
            </section>
          )}
          {(current.note.oneSided || current.note.partial) && (
            <div className="db-meeting-caveats">
              {current.note.oneSided && <p>{meetingNotes.oneSidedCaveat}</p>}
              {current.note.partial && <p>{meetingNotes.partialCaveat}</p>}
            </div>
          )}
          {current.note.transcript.length > 0 && (
            <section className="db-meeting-section db-detail-transcript">
              <h2>Transcript</h2>
              {current.note.transcript.map((turn, index) => (
                <div className="db-turn" key={`${index}:${turn.speaker}`}>
                  <span className="db-turn-role">{turn.speaker || "Speaker"}</span>
                  <p className="db-turn-text">{turn.text}</p>
                </div>
              ))}
            </section>
          )}
        </div>
      ) : (
        <div className={`db-meeting-state db-meeting-state-${state}`}>
          {state === "failed" ? <TriangleAlert size={20} /> : <LoaderCircle size={20} />}
          <div>
            <p>{stateCopy(current)}</p>
            {state === "failed" && current.retryable && (
              <button
                type="button"
                className="db-primary-btn db-meeting-retry"
                onClick={() => void handleRetry()}
                disabled={retrying}
              >
                {retrying ? "Retrying..." : meetingNotes.retryNow}
              </button>
            )}
            {retryError && <p className="db-meeting-retry-error">Couldn't retry this meeting.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function localRecordingStatus(recording: LocalRecording): string {
  if (recording.state === "local_deleted") return "Local audio deleted";
  if (recording.lastErrorCode) return "Needs attention";
  if (recording.retainLocalUntilMs) {
    const remainingMs = recording.retainLocalUntilMs - Date.now();
    if (recording.exportable && remainingMs <= 0) {
      return "Retention cleanup is due. Export this recording now if you need it.";
    }
    if (recording.exportable && remainingMs <= 24 * 60 * 60_000) {
      return `Recovery copy expires ${new Date(recording.retainLocalUntilMs).toLocaleString()}`;
    }
    return `Audio kept until ${new Date(recording.retainLocalUntilMs).toLocaleString()}`;
  }
  return recording.exportable ? "Recoverable on this device" : "Metadata retained";
}

function hasLocalRecordingWarning(recording: LocalRecording): boolean {
  return Boolean(
    recording.lastErrorCode
    || (
      recording.exportable
      && recording.retainLocalUntilMs !== null
      && recording.retainLocalUntilMs - Date.now() <= 24 * 60 * 60_000
    ),
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function LocalRecoverySection() {
  const [recordings, setRecordings] = useState<LocalRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const loadRecordings = () => {
    setLoading(true);
    setError(false);
    void invoke<LocalRecording[]>("local_recordings")
      .then(setRecordings)
      .catch((err) => {
        logError("MeetingsPage: local recordings", err);
        setError(true);
      })
      .finally(() => setLoading(false));
  };

  useEffect(loadRecordings, []);

  const exportRecording = async (
    recording: LocalRecording,
    includeAudio: boolean,
  ) => {
    const action = `${recording.captureRunId}:${includeAudio ? "audio" : "support"}`;
    setBusy(action);
    setMessage(null);
    try {
      const result = await invoke<ExportResult>("export_local_recording", {
        meetingId: recording.meetingId,
        captureRunId: recording.captureRunId,
        includeAudio,
      });
      setMessage(
        includeAudio
          ? `Exported ${result.segmentCount} verified audio segment${result.segmentCount === 1 ? "" : "s"}.`
          : "Exported a sanitized support bundle.",
      );
      try {
        await openPath(result.path);
      } catch (err) {
        logError("MeetingsPage: open exported local recording", err);
        setMessage(
          includeAudio
            ? `Exported ${result.segmentCount} verified audio segment${result.segmentCount === 1 ? "" : "s"}, but Aura could not open its folder.`
            : "Exported a sanitized support bundle, but Aura could not open its folder.",
        );
      }
    } catch (err) {
      logError("MeetingsPage: export local recording", err);
      setMessage("Aura could not export this recording. Its retained copy was not changed.");
    } finally {
      setBusy(null);
    }
  };

  const deleteRecording = async (recording: LocalRecording) => {
    const confirmed = window.confirm(
      "Delete the retained audio from this device now? Cloud notes and server-side data are not deleted by this action. This cannot be undone.",
    );
    if (!confirmed) return;
    const action = `${recording.captureRunId}:delete`;
    setBusy(action);
    setMessage(null);
    try {
      await invoke("delete_local_recording", {
        meetingId: recording.meetingId,
        captureRunId: recording.captureRunId,
      });
      setMessage("Local audio deleted. Aura retained the deletion receipt and evidence metadata.");
      loadRecordings();
    } catch (err) {
      logError("MeetingsPage: delete local recording", err);
      setMessage("Aura could not finish deletion. It will retain and retry the deletion job.");
    } finally {
      setBusy(null);
    }
  };

  if (!loading && !error && recordings.length === 0) return null;

  return (
    <section className="db-local-recordings" aria-labelledby="local-recordings-heading">
      <div className="db-local-recordings-heading">
        <div>
          <span className="db-eyebrow"><HardDrive size={14} /> Device recovery</span>
          <h2 id="local-recordings-heading">Retained meeting recordings</h2>
          <p>
            Encrypted source audio stays recoverable on this device for at least seven days
            after capture ends.
          </p>
        </div>
        <button
          type="button"
          className="db-secondary-btn"
          onClick={loadRecordings}
          disabled={loading}
        >
          {loading ? "Checking..." : "Refresh"}
        </button>
      </div>

      {error ? (
        <p className="db-local-recordings-message">
          Local recovery is available only in the Aura process that owns meeting capture.
        </p>
      ) : (
        <div className="db-local-recording-list">
          {recordings.map((recording) => {
            const audioAction = `${recording.captureRunId}:audio`;
            const supportAction = `${recording.captureRunId}:support`;
            const deleteAction = `${recording.captureRunId}:delete`;
            return (
              <article className="db-local-recording" key={recording.captureRunId}>
                <div className="db-local-recording-copy">
                  <strong>{new Date(recording.startedAtMs).toLocaleString()}</strong>
                  <span>
                    {recording.segmentCount} segment{recording.segmentCount === 1 ? "" : "s"}
                    {" · "}
                    {formatBytes(recording.byteLength)}
                  </span>
                  <span className={hasLocalRecordingWarning(recording) ? "db-local-warning" : ""}>
                    {localRecordingStatus(recording)}
                  </span>
                </div>
                <div className="db-local-recording-actions">
                  <button
                    type="button"
                    className="db-primary-btn"
                    disabled={!recording.exportable || busy !== null}
                    onClick={() => void exportRecording(recording, true)}
                  >
                    <Download size={15} />
                    {busy === audioAction ? "Exporting..." : "Export audio"}
                  </button>
                  <button
                    type="button"
                    className="db-secondary-btn"
                    disabled={busy !== null}
                    onClick={() => void exportRecording(recording, false)}
                  >
                    <FileJson size={15} />
                    {busy === supportAction ? "Exporting..." : "Support bundle"}
                  </button>
                  <button
                    type="button"
                    className="db-local-delete"
                    disabled={!recording.exportable || busy !== null}
                    onClick={() => void deleteRecording(recording)}
                  >
                    <Trash2 size={15} />
                    {busy === deleteAction ? "Deleting..." : "Delete local audio"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {message && (
        <p className="db-local-recordings-message" role="status">
          {message}
        </p>
      )}
    </section>
  );
}

export function MeetingsPage() {
  const res = useDashboardResource<MeetingDoc[]>(
    "meetings",
    (signal) => getMeetings(signal),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const meetings = useMemo(() => res.data ?? [], [res.data]);
  const models = useMemo(() => meetings.map(meetingToCard), [meetings]);
  const selectedMeeting = selectedId
    ? meetings.find((meeting) => meeting.meetingId === selectedId) ?? null
    : null;

  return (
    <div className="db-page db-page-full">
      {selectedMeeting ? (
        <MeetingDetail
          meeting={selectedMeeting}
          onBack={() => setSelectedId(null)}
          onListReload={res.reload}
        />
      ) : (
        <>
          <LocalRecoverySection />
          <div className="db-page-toolbar db-page-toolbar-end">
            <RefreshIndicator
              refreshing={res.refreshing}
              stale={res.stale}
              cachedAt={res.cachedAt}
              onRetry={res.reload}
            />
          </div>

          {res.error ? (
            <PageError authExpired={res.authExpired} onRetry={res.reload} />
          ) : (
            <CardGrid
              models={models}
              loading={res.loading}
              columns="three"
              onOpen={setSelectedId}
              empty={
                <EmptyState
                  Icon={Video}
                  heading="No meetings yet"
                  copy="Turn on meeting notes during a call and your notes will show up here."
                />
              }
            />
          )}
        </>
      )}
    </div>
  );
}
