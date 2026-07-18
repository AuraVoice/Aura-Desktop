import { useMemo, useState } from "react";
import {
  ArrowLeft,
  LoaderCircle,
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
