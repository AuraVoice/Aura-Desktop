import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  ArrowLeft,
  Download,
  FileJson,
  HardDrive,
  LoaderCircle,
  RefreshCw,
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

// "stalled" is the state this page could not previously express. The server doc
// and the device queue are two different sources of truth, and when the handoff
// between them broke the card kept rendering an ordinary spinner forever while
// the recovery panel below said "Needs attention" about the very same recording.
type MeetingVisualState = "ready" | "processing" | "failed" | "stalled";

// Mirrors the backend's F.STALL_DEADLINE_MINUTES. Past this, "processing" is not
// a claim this UI is entitled to keep making.
const STALL_AFTER_MS = 6 * 60 * 60_000;

const processingLabels: Partial<Record<MeetingProcessingStage, string>> = {
  capturing: "Capturing",
  uploading: "Uploading",
  queued: "Queued",
  transcribing: "Transcribing",
  building_insights: "Building insights",
  quality_check: "Checking quality",
  needs_attention: "Needs attention",
};

/// True when this device still holds a finished recording the server has not
/// acknowledged, so any server-side "processing" is describing work that never
/// actually arrived.
function localHandoffPending(local: LocalRecording | undefined): boolean {
  if (!local) return false;
  return local.state === "needs_attention"
    || local.state === "finalized_local"
    || local.state === "capturing_interrupted";
}

function visualState(
  meeting: MeetingDoc,
  local?: LocalRecording,
): MeetingVisualState {
  if (meeting.status === "ready") return "ready";
  if (meeting.status === "failed" || meeting.status === "excluded") return "failed";
  if (meeting.status === "needs_attention") return "stalled";
  if (localHandoffPending(local)) return "stalled";
  const startedAt = Date.parse(meeting.createdAt);
  if (Number.isFinite(startedAt) && Date.now() - startedAt > STALL_AFTER_MS) {
    return "stalled";
  }
  return "processing";
}

function statusIcon(meeting: MeetingDoc, local?: LocalRecording): LucideIcon {
  const state = visualState(meeting, local);
  if (state === "ready") return Video;
  if (state === "failed" || state === "stalled") return TriangleAlert;
  return LoaderCircle;
}

function statusLabel(meeting: MeetingDoc, local?: LocalRecording): string {
  if (meeting.status === "ready") return "Ready";
  if (meeting.status === "excluded") return "Skipped";
  if (meeting.status === "failed") return "Failed";
  if (visualState(meeting, local) === "stalled") {
    return localHandoffPending(local) ? "On this device" : "Stalled";
  }
  return meeting.processingStage
    ? processingLabels[meeting.processingStage] ?? "Processing"
    : "Processing";
}

function stateCopy(meeting: MeetingDoc, local?: LocalRecording): string {
  if (meeting.status === "failed" || meeting.status === "excluded") {
    return meetingFailureCopy(meeting.failureCode);
  }
  if (visualState(meeting, local) === "stalled") {
    if (localHandoffPending(local)) {
      return "Recorded and saved on this device. Aura has not finished sending it "
        + "for transcription yet, and will keep trying.";
    }
    return meeting.failureCode
      ? meetingFailureCopy(meeting.failureCode)
      : "This has been processing far longer than it should. Aura is retrying it.";
  }
  if (meeting.processingStage === "transcribing") return meetingNotes.processingTranscript;
  if (meeting.processingStage === "building_insights") return meetingNotes.buildingInsights;
  return meetingNotes.processing;
}

function meetingToCard(meeting: MeetingDoc, local?: LocalRecording): CardModel {
  const state = visualState(meeting, local);
  return {
    id: meeting.meetingId,
    badge: { Icon: statusIcon(meeting, local), label: statusLabel(meeting, local) },
    title: meeting.title || "Untitled meeting",
    meta: shortDateTime(meeting.createdAt),
    preview:
      state === "ready"
        ? meeting.note?.summary || meetingNotes.processing
        : stateCopy(meeting, local),
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
  local,
  onBack,
  onListReload,
}: {
  meeting: MeetingDoc;
  local?: LocalRecording;
  onBack: () => void;
  onListReload: () => void;
}) {
  const detail = useDashboardResource<MeetingDoc | null>(
    `meeting:${meeting.meetingId}`,
    (signal) => getMeeting(meeting.meetingId, signal),
  );
  const current = detail.data ?? meeting;
  const state = visualState(current, local);
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

/// True when this recording still has work to hand off. Drives "Process now".
function canRetryLocally(recording: LocalRecording): boolean {
  return recording.exportable
    && recording.state !== "local_deleted"
    && recording.state !== "uploaded_verified"
    && recording.state !== "split_brain"
    && recording.state !== "local_missing"
    && recording.state !== "capture_failed_integrity"
    && recording.state !== "delete_requested";
}

function localRecordingStatus(recording: LocalRecording): string {
  if (recording.state === "local_deleted") return "Local audio deleted";
  if (recording.state === "delete_requested") {
    return recording.deletionState === "retry"
      ? "Removing local audio. Aura will retry automatically."
      : "Removing local audio...";
  }
  // Deliberately ahead of lastErrorCode: a run still waiting to hand off is the
  // useful fact, and an error that has since been retried is not.
  if (recording.state === "needs_attention") return "Waiting to upload. Aura will retry.";
  if (recording.state === "finalized_local") return "Recorded here, waiting to upload";
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
  if (recording.state === "delete_requested") {
    return recording.deletionState === "retry";
  }
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

/// One source for the device queue, shared by the meeting cards and the recovery
/// list. They used to read separate data and could contradict each other about
/// the same recording.
function useLocalRecordings() {
  const [recordings, setRecordings] = useState<LocalRecording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadRecordings = useCallback(() => {
    setLoading(true);
    setError(false);
    void invoke<LocalRecording[]>("local_recordings")
      .then(setRecordings)
      .catch((err) => {
        logError("MeetingsPage: local recordings", err);
        setError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => loadRecordings(), [loadRecordings]);
  return { recordings, loading, error, loadRecordings };
}

function LocalRecoverySection({
  recordings,
  loading,
  error,
  loadRecordings,
  onListReload,
}: ReturnType<typeof useLocalRecordings> & { onListReload: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LocalRecording | null>(null);
  const visibleRecordings = useMemo(
    () => recordings.filter((recording) => recording.state !== "local_deleted"),
    [recordings],
  );

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

  const retryRecording = async (recording: LocalRecording) => {
    const action = `${recording.captureRunId}:retry`;
    setBusy(action);
    setMessage(null);
    try {
      const requeued = await invoke<boolean>("retry_capture_jobs", {
        captureRunId: recording.captureRunId,
      });
      setMessage(
        requeued
          ? "Queued for upload. Aura will send it and build the note."
          : "Nothing left to send for this recording.",
      );
      loadRecordings();
      onListReload();
    } catch (err) {
      logError("MeetingsPage: retry local recording", err);
      setMessage("Aura could not queue this recording. Its local copy is untouched.");
    } finally {
      setBusy(null);
    }
  };

  const retryAll = async () => {
    setBusy("retry-all");
    setMessage(null);
    try {
      const revived = await invoke<number>("revive_stranded_captures");
      setMessage(
        revived > 0
          ? `Queued ${revived} recording${revived === 1 ? "" : "s"} for upload.`
          : "Every recording on this device is already handed off or queued.",
      );
      loadRecordings();
      onListReload();
    } catch (err) {
      logError("MeetingsPage: retry all local recordings", err);
      setMessage("Aura could not queue these recordings. Their local copies are untouched.");
    } finally {
      setBusy(null);
    }
  };

  const deleteRecording = async (recording: LocalRecording) => {
    const action = `${recording.captureRunId}:delete`;
    setBusy(action);
    setMessage(null);
    try {
      await invoke("delete_local_recording", {
        meetingId: recording.meetingId,
        captureRunId: recording.captureRunId,
      });
      setMessage("Removing local audio. This recording will disappear when deletion finishes.");
      loadRecordings();
    } catch (err) {
      logError("MeetingsPage: delete local recording", err);
      setMessage("Aura could not finish deletion. It will retain and retry the deletion job.");
    } finally {
      setPendingDelete(null);
      setBusy(null);
    }
  };

  if (!loading && !error && visibleRecordings.length === 0) return null;

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
        <div className="db-local-recording-actions">
          {visibleRecordings.some(canRetryLocally) && (
            <button
              type="button"
              className="db-primary-btn"
              onClick={() => void retryAll()}
              disabled={busy !== null || loading}
            >
              <RefreshCw size={15} />
              {busy === "retry-all" ? "Queueing..." : "Retry all"}
            </button>
          )}
          <button
            type="button"
            className="db-secondary-btn"
            onClick={loadRecordings}
            disabled={loading}
          >
            <RefreshCw size={15} />
            {loading ? "Checking..." : "Refresh"}
          </button>
        </div>
      </div>

      {error ? (
        <p className="db-local-recordings-message">
          Local recovery is available only in the Aura process that owns meeting capture.
        </p>
      ) : (
        <div className="db-local-recording-list">
          {visibleRecordings.map((recording) => {
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
                  {canRetryLocally(recording) && (
                    <button
                      type="button"
                      className="db-primary-btn"
                      disabled={busy !== null}
                      onClick={() => void retryRecording(recording)}
                    >
                      <RefreshCw size={15} />
                      {busy === `${recording.captureRunId}:retry`
                        ? "Queueing..."
                        : "Process now"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="db-secondary-btn"
                    disabled={
                      !recording.exportable
                      || recording.state === "delete_requested"
                      || busy !== null
                    }
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
                    disabled={
                      !recording.exportable
                      || recording.state === "delete_requested"
                      || busy !== null
                    }
                    onClick={() => setPendingDelete(recording)}
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
      {pendingDelete && (
        <div
          className="db-local-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="local-delete-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && busy === null) setPendingDelete(null);
          }}
        >
          <button
            type="button"
            className="db-local-confirm-scrim"
            aria-label="Keep local audio"
            disabled={busy !== null}
            onClick={() => setPendingDelete(null)}
          />
          <div className="db-local-confirm-panel">
            <span className="db-local-confirm-icon"><Trash2 size={20} /></span>
            <h2 id="local-delete-title">Delete local audio?</h2>
            <p>
              Aura will remove the encrypted recording from this device. Cloud notes and
              server data stay available. This cannot be undone.
            </p>
            <div className="db-local-confirm-actions">
              <button
                type="button"
                className="db-local-confirm-cancel"
                autoFocus
                disabled={busy !== null}
                onClick={() => setPendingDelete(null)}
              >
                Keep audio
              </button>
              <button
                type="button"
                className="db-local-confirm-delete"
                disabled={busy !== null}
                onClick={() => void deleteRecording(pendingDelete)}
              >
                <Trash2 size={15} />
                {busy === `${pendingDelete.captureRunId}:delete` ? "Removing..." : "Delete audio"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function MeetingsPage() {
  const res = useDashboardResource<MeetingDoc[]>(
    "meetings",
    (signal) => getMeetings(signal),
  );
  const local = useLocalRecordings();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const meetings = useMemo(() => res.data ?? [], [res.data]);
  const localByMeeting = useMemo(() => {
    const map = new Map<string, LocalRecording>();
    for (const recording of local.recordings) {
      map.set(recording.meetingId, recording);
    }
    return map;
  }, [local.recordings]);
  const models = useMemo(
    () => meetings.map((meeting) => meetingToCard(meeting, localByMeeting.get(meeting.meetingId))),
    [meetings, localByMeeting],
  );
  const selectedMeeting = selectedId
    ? meetings.find((meeting) => meeting.meetingId === selectedId) ?? null
    : null;

  return (
    <div className="db-page db-page-full">
      {selectedMeeting ? (
        <MeetingDetail
          meeting={selectedMeeting}
          local={localByMeeting.get(selectedMeeting.meetingId)}
          onBack={() => setSelectedId(null)}
          onListReload={res.reload}
        />
      ) : (
        <>
          <LocalRecoverySection {...local} onListReload={res.reload} />
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
