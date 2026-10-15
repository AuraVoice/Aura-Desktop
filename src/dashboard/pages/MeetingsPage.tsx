import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openPath } from "@tauri-apps/plugin-opener";
import { useSearchParams } from "react-router-dom";
import {
  ArrowLeft,
  Captions,
  Check,
  Copy,
  Download,
  FileDown,
  FileJson,
  FileText,
  Hash,
  LoaderCircle,
  Mail,
  MessageCircleQuestion,
  NotebookPen,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Video,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import {
  getMeeting,
  getMeetings,
  searchMeetings,
  type MeetingSearchResult,
} from "../../lib/dashboardApi";
import { CHAT_ATTACH_REQUESTED, type ChatAttachRequest } from "../../lib/ipcEvents";
import { logError } from "../../lib/log";
import {
  meetingActionFailureCopy,
  meetingFailureCopy,
  meetingKindLabels,
  meetingFollowUpCopy,
  meetingNotes,
  meetingSearchCopy,
  meetingShareCopy,
} from "../../lib/meetingCopy";
import { fetchConnectors } from "../../lib/connectors";
import type { PendingActionTool } from "../../lib/pendingActions";
import { MeetingCaptureButtons, MeetingCaptureStatus, useMeetingCaptureModes } from "./MeetingCaptureModes";
import { MeetingFollowUp } from "./MeetingFollowUp";
import {
  OTHERS_LABEL,
  SpeakerNameInput,
  speakerDisplayName,
  WhoIsCard,
  type WhoIsState,
} from "./MeetingSpeakers";
import { MeetingDialog, MeetingSendToSlack, MeetingShare } from "./MeetingShare";
import {
  canExportSubtitles,
  clockStamp,
  meetingChatDocument,
  noteMarkdown,
  saveMeetingFile,
  shownNote,
  transcriptText,
  transcriptVtt,
  type MeetingExportFormat,
  type ShownNote,
} from "../../lib/meetingExport";
import {
  deleteMeeting,
  MEETING_KINDS,
  MeetingActionError,
  regenerateMeetingNote,
  restoreAiNote,
  retryMeeting,
  matchMeetingCalendar,
  saveEditedNote,
  setMeetingPinned,
  setSpeakerName,
  type EditedNote,
  type MeetingDoc,
  type MeetingKind,
  type MeetingProcessingStage,
  type TranscriptTurn,
} from "../../lib/meetings";
import { CardGrid } from "../components/CardGrid";
import type { CardModel } from "../components/DashboardCard";
import { EmptyState } from "../components/EmptyState";
import { ExpandingSearch } from "../components/ExpandingSearch";
import { PageError } from "../components/PageError";
import { ChipStrip } from "../components/RangeChips";
import { RefreshIndicator } from "../components/RefreshIndicator";
import { RowMenu, type RowMenuItem } from "../components/RowMenu";
import { SlidingTabs, useTabStage } from "../components/SlidingTabs";
import { durationCoarse, relativeTime, shortDateTime, timeOfDay } from "../format";
import { useDashboardResource } from "../useDashboardResource";

type MeetingPane = "insights" | "transcript";

interface LocalRecording {
  meetingId: string;
  captureRunId: string;
  eventId: string;
  state: string;
  startedAtMs: number;
  finishedAtMs: number | null;
  retainLocalUntilMs: number | null;
  segmentCount: number;
  uploadedCount: number;
  durationMs: number;
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

/** How often an open, still-processing meeting re-reads the server doc and the
 *  device queue. Upload segments land every few seconds, so slower reads as frozen. */
const PROGRESS_POLL_MS = 4_000;

/** Which of the four steps (recorded, sent, transcribed, notes) is under way.
 *  The server stage wins; without one, the device queue says whether the upload
 *  is still running. */
function progressStep(meeting: MeetingDoc, local?: LocalRecording): number {
  if (meeting.status === "capturing") {
    // The server stage reads "uploading" as soon as the first five minute
    // segment lands mid-call, which ticked "Recorded" off while still
    // recording. Only this device knows whether the recording has stopped.
    return local && local.finishedAtMs !== null ? 1 : 0;
  }
  switch (meeting.processingStage) {
    case "capturing":
      return 0;
    case "uploading":
      return 1;
    case "queued":
    case "transcribing":
      return 2;
    case "building_insights":
    case "quality_check":
      return 3;
    default:
      if (meeting.status === "synthesizing") return 3;
      if (local && local.uploadedCount < local.segmentCount) return 1;
      return meeting.status === "uploaded" ? 2 : 1;
  }
}

function MeetingProgress({ meeting, local }: { meeting: MeetingDoc; local?: LocalRecording }) {
  const active = progressStep(meeting, local);
  const total = local?.segmentCount ?? 0;
  const sent = Math.min(local?.uploadedCount ?? 0, total);
  const audio = local && local.durationMs > 0
    ? meetingNotes.progressAudioLength(durationCoarse(local.durationMs / 1000))
    : null;
  const uploadDetail = total > 0
    ? sent < total
      ? meetingNotes.progressUploadCount(sent, total)
      : meetingNotes.progressUploadConfirming(total)
    : meetingNotes.progressUploadElsewhere;
  const steps: { label: string; detail: string | null; fraction?: number }[] = [
    {
      label: meetingNotes.progressRecorded,
      detail: active === 0 ? meetingNotes.progressRecordingTranscribing : audio,
    },
    {
      label: meetingNotes.progressUpload,
      detail: active === 1 ? uploadDetail : null,
      fraction: active === 1 && total > 0 ? sent / total : undefined,
    },
    {
      label: meetingNotes.progressTranscribe,
      detail: active !== 2
        ? null
        : meeting.processingStage === "queued"
          ? meetingNotes.progressQueued
          : meetingNotes.progressTranscribing,
    },
    {
      label: meetingNotes.progressNotes,
      detail: active !== 3
        ? null
        : meeting.processingStage === "quality_check"
          ? meetingNotes.progressChecking
          : meetingNotes.progressWriting,
    },
  ];

  return (
    <>
    <div className="db-meeting-progress" role="status" aria-live="polite">
      <ol className="db-meeting-progress-steps">
        {steps.map((step, index) => {
          const phase = index < active ? "done" : index === active ? "active" : "pending";
          return (
            <li key={step.label} className={`db-meeting-progress-step is-${phase}`}>
              <span className="db-meeting-progress-mark" aria-hidden="true">
                {phase === "done" ? (
                  <Check size={14} />
                ) : phase === "active" ? (
                  <LoaderCircle size={14} />
                ) : null}
              </span>
              <div className="db-meeting-progress-body">
                <span className="db-meeting-progress-label">{step.label}</span>
                {step.detail && <span className="db-meeting-progress-detail">{step.detail}</span>}
                {step.fraction !== undefined && (
                  <span className="db-meeting-progress-bar" aria-hidden="true">
                    <span style={{ width: `${Math.round(step.fraction * 100)}%` }} />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <p className="db-meeting-progress-foot">
        {meetingNotes.progressLastChange(relativeTime(meeting.updatedAt))}
      </p>
    </div>
    {/* Outside the live region on purpose: a status announcement on every
        poll must not read the whole conversation aloud. */}
    {meeting.liveTranscript.length > 0 && (
      <section className="db-meeting-live" aria-label={meetingNotes.liveTranscriptHeading(clockStamp(meeting.liveThroughMs / 1000))}>
        <header className="db-meeting-live-head">
          <h3>{meetingNotes.liveTranscriptHeading(clockStamp(meeting.liveThroughMs / 1000))}</h3>
          <p>{meetingNotes.liveTranscriptNote}</p>
        </header>
        <MeetingTranscript
          turns={meeting.liveTranscript}
          jump={null}
          speakerNames={meeting.speakerNames}
          people={meeting.people}
          onRename={NO_RENAME}
          readOnly
        />
      </section>
    )}
    </>
  );
}

/** Live labels can change before the note lands, and the server only accepts a
 *  name for a label the published transcript uses, so the live view is read only. */
const NO_RENAME = () => {};

/** The list only mentions retention when it matters soon: a pinned note, or
 *  one that is deleted within two days. */
function cardRetention(meeting: MeetingDoc): string | null {
  if (meeting.status !== "ready") return null;
  if (meeting.pinned) return meetingNotes.pinned;
  if (!meeting.expiresAt) return null;
  const days = daysUntil(meeting.expiresAt);
  return days !== null && days <= 2 ? meetingNotes.expiresIn(days) : null;
}

function meetingToCard(
  meeting: MeetingDoc,
  local: LocalRecording | undefined,
  onDelete: (meeting: MeetingDoc) => void,
  localItems: RowMenuItem[],
): CardModel {
  const state = visualState(meeting, local);
  return {
    id: meeting.meetingId,
    badge: { Icon: statusIcon(meeting, local), label: statusLabel(meeting, local) },
    title: meeting.title || "Untitled meeting",
    meta: cardRetention(meeting)
      ? `${shortDateTime(meeting.createdAt)} · ${cardRetention(meeting)}`
      : shortDateTime(meeting.createdAt),
    preview:
      state === "ready"
        ? meeting.note?.summary || meetingNotes.processing
        : stateCopy(meeting, local),
    menu: [
      ...localItems,
      {
        label: "Delete this recording",
        Icon: Trash2,
        danger: true,
        onSelect: () => onDelete(meeting),
      },
    ],
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

/** Meeting-relative stamp for a turn. Notes written before
 *  meeting-transcript-v3 have no timings, and those turns show none. */
function turnStamp(seconds: number | undefined): string | null {
  return seconds === undefined ? null : clockStamp(seconds);
}

/** The turn a chapter lands on: the server snaps every chapter onto a turn's
 *  exact start, so the last turn starting at or before it is that turn. */
function chapterTurnIndex(turns: TranscriptTurn[], startS: number): number {
  let found = 0;
  turns.forEach((turn, index) => {
    if (turn.startS !== undefined && turn.startS <= startS) found = index;
  });
  return found;
}

/** Calendar days from today to the deletion date, so "tomorrow" means the
 *  next calendar day rather than the next 24 hours. */
function daysUntil(iso: string): number | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const startOf = (ms: number) => {
    const day = new Date(ms);
    day.setHours(0, 0, 0, 0);
    return day.getTime();
  };
  return Math.round((startOf(at) - startOf(Date.now())) / 86_400_000);
}

function retentionLabel(meeting: MeetingDoc): string | null {
  if (meeting.pinned) return meetingNotes.pinnedMeta;
  if (!meeting.expiresAt) return null;
  const days = daysUntil(meeting.expiresAt);
  return days === null ? null : meetingNotes.expiresIn(days);
}

function MeetingInsights({
  note,
  onChapter,
}: {
  note: ShownNote;
  onChapter?: (startS: number) => void;
}) {
  return (
    <div className="db-meeting-note">
      {note.summary && (
        <section className="db-meeting-section">
          <h2>Summary</h2>
          <p className="db-detail-text">{note.summary}</p>
        </section>
      )}
      {note.sinceLastTime.length > 0 && (
        <section className="db-meeting-section">
          <h2>{meetingNotes.sinceLastTimeHeading}</h2>
          <NoteList items={note.sinceLastTime} />
        </section>
      )}
      {note.chapters.length > 0 && onChapter && (
        <section className="db-meeting-section">
          <h2>{meetingNotes.chaptersHeading}</h2>
          <ol className="db-meeting-chapters">
            {note.chapters.map((chapter) => (
              <li key={chapter.startS}>
                <button type="button" className="db-meeting-chapter" onClick={() => onChapter(chapter.startS)}>
                  <time>{clockStamp(chapter.startS)}</time>
                  <span>{chapter.title}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
      {note.keyPoints.length > 0 && (
        <section className="db-meeting-section">
          <h2>{meetingNotes.keyPointsHeading}</h2>
          <NoteList items={note.keyPoints} />
        </section>
      )}
      {note.kind === "interview" && note.debrief.length > 0 && (
        <section className="db-meeting-section">
          <h2>{meetingNotes.debriefHeading}</h2>
          <ol className="db-meeting-debrief">
            {note.debrief.map((item, index) => (
              <li key={index} className="db-meeting-debrief-item">
                <p className="db-meeting-debrief-question">{item.question}</p>
                <p className="db-detail-text">{item.answered}</p>
                {item.improve && (
                  <p className="db-meeting-debrief-improve">
                    <span>{meetingNotes.debriefImprove}</span> {item.improve}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}
      {note.decisions.length > 0 && (
        <section className="db-meeting-section">
          <h2>{meetingNotes.decisionsHeading}</h2>
          <NoteList items={note.decisions} />
        </section>
      )}
      {note.actionItems.length > 0 && (
        <section className="db-meeting-section">
          <h2>{meetingNotes.actionItemsHeading}</h2>
          <NoteList items={note.actionItems} />
        </section>
      )}
      {note.blockers.length > 0 && (
        <section className="db-meeting-section">
          <h2>{meetingNotes.blockersHeading}</h2>
          <NoteList items={note.blockers} />
        </section>
      )}
      {note.openQuestions.length > 0 && (
        <section className="db-meeting-section">
          <h2>{meetingNotes.openQuestionsHeading}</h2>
          <NoteList items={note.openQuestions} />
        </section>
      )}
      {(note.oneSided || note.partial) && (
        <div className="db-meeting-caveats">
          {note.oneSided && <p>{meetingNotes.oneSidedCaveat}</p>}
          {note.partial && <p>{meetingNotes.partialCaveat}</p>}
        </div>
      )}
    </div>
  );
}

type EditableList = "decisions" | "actionItems" | "openQuestions" | "keyPoints" | "blockers";

const editableLists: { key: EditableList; heading: string }[] = [
  { key: "keyPoints", heading: meetingNotes.keyPointsHeading },
  { key: "decisions", heading: meetingNotes.decisionsHeading },
  { key: "actionItems", heading: meetingNotes.actionItemsHeading },
  { key: "blockers", heading: meetingNotes.blockersHeading },
  { key: "openQuestions", heading: meetingNotes.openQuestionsHeading },
];

/** Every editable section as a plain textarea, one list item per line. Key
 *  points and blockers only appear for the kinds that use them, or when the
 *  note already has some. */
function MeetingNoteEditor({
  note,
  saving,
  onSave,
  onCancel,
}: {
  note: ShownNote;
  saving: boolean;
  onSave: (edited: Omit<EditedNote, "editedAt">) => void;
  onCancel: () => void;
}) {
  const [summary, setSummary] = useState(note.summary);
  const [lists, setLists] = useState<Record<EditableList, string>>(() => ({
    decisions: note.decisions.join("\n"),
    actionItems: note.actionItems.join("\n"),
    openQuestions: note.openQuestions.join("\n"),
    keyPoints: note.keyPoints.join("\n"),
    blockers: note.blockers.join("\n"),
  }));
  const shown = editableLists.filter(({ key }) =>
    key === "keyPoints"
      ? note.kind === "lecture" || note.keyPoints.length > 0
      : key === "blockers"
        ? note.kind === "standup" || note.blockers.length > 0
        : true,
  );
  const lines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);
  const submit = () =>
    onSave({
      summary: summary.trim(),
      decisions: lines(lists.decisions),
      actionItems: lines(lists.actionItems),
      openQuestions: lines(lists.openQuestions),
      keyPoints: lines(lists.keyPoints),
      blockers: lines(lists.blockers),
    });
  const rows = (text: string) => Math.min(12, Math.max(3, text.split("\n").length + 1));

  return (
    <form
      className="db-meeting-note db-meeting-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="db-meeting-editor-hint">{meetingNotes.editHint}</p>
      <label className="db-meeting-section">
        <h2>Summary</h2>
        <textarea
          className="db-meeting-editor-field"
          rows={rows(summary)}
          maxLength={4000}
          value={summary}
          disabled={saving}
          onChange={(event) => setSummary(event.target.value)}
        />
      </label>
      {shown.map(({ key, heading }) => (
        <label key={key} className="db-meeting-section">
          <h2>{heading}</h2>
          <textarea
            className="db-meeting-editor-field"
            rows={rows(lists[key])}
            value={lists[key]}
            disabled={saving}
            onChange={(event) => {
              const value = event.target.value;
              setLists((current) => ({ ...current, [key]: value }));
            }}
          />
        </label>
      ))}
      <div className="db-meeting-editor-actions">
        <button type="button" className="db-secondary-btn" disabled={saving} onClick={onCancel}>
          {meetingNotes.cancel}
        </button>
        <button type="submit" className="db-primary-btn" disabled={saving}>
          {saving ? meetingNotes.saving : meetingNotes.save}
        </button>
      </div>
    </form>
  );
}

/** One transcript turn as a chat bubble: the user's own on the right, every
 *  other speaker on the left. A run of turns from one speaker shows the name
 *  once, above its first bubble, and the time once, under its last.
 *  Memoized so a chapter flash re-renders the two rows whose `flashing`
 *  flips, not every turn of a two hour meeting. */
const TranscriptTurnRow = memo(function TranscriptTurnRow({
  turn,
  index,
  flashing,
  first,
  last,
  name,
  renaming,
  onStartRename,
  onRename,
  onCancelRename,
  readOnly,
}: {
  turn: TranscriptTurn;
  index: number;
  flashing: boolean;
  first: boolean;
  last: boolean;
  name: string;
  renaming: boolean;
  onStartRename: (index: number) => void;
  onRename: (label: string, name: string) => void;
  onCancelRename: () => void;
  readOnly: boolean;
}) {
  const stamp = turnStamp(turn.startS);
  // "You" is the device owner's microphone channel; the backend owns
  // both labels, so this is the one comparison the client may make.
  const mine = turn.speaker === "You";
  return (
    <article
      className={`db-meeting-turn ${mine ? "is-mine" : "is-theirs"}${first ? " is-first" : ""}${flashing ? " is-flash" : ""}`}
      data-turn={index}
    >
      {first && !mine && (
        <header>
          {readOnly ? (
            <span className="db-meeting-turn-name">{name}</span>
          ) : renaming ? (
            <SpeakerNameInput
              initial={name === turn.speaker ? "" : name}
              label={turn.speaker}
              onSave={(next) => onRename(turn.speaker, next)}
              onCancel={onCancelRename}
            />
          ) : (
            <button
              type="button"
              className="db-meeting-turn-speaker"
              title={meetingNotes.renameSpeaker(name)}
              onClick={() => onStartRename(index)}
            >
              {name}
              <Pencil size={11} aria-hidden="true" />
            </button>
          )}
        </header>
      )}
      <p className="db-meeting-bubble">{turn.text}</p>
      {last && stamp && <time className="db-meeting-turn-stamp">{stamp}</time>}
    </article>
  );
});

/** Memoized: MeetingDetail's own state (menu, status, copy flash, busy) never
 *  changes `turns`, `jump` or the names, so none of it reaches the transcript. */
const MeetingTranscript = memo(function MeetingTranscript({
  turns,
  jump,
  speakerNames,
  people,
  onRename,
  notice,
  readOnly = false,
}: {
  turns: TranscriptTurn[];
  /** A chapter click: scroll that turn into view and flash it. The nonce makes
   *  a second click on the same chapter move the view again. */
  jump: { index: number; nonce: number } | null;
  speakerNames: Record<string, string>;
  people: string[];
  onRename: (label: string, name: string) => void;
  /** The "who is Others" card, above the first bubble. */
  notice?: ReactNode;
  /** Speaker names shown as plain text, not rename buttons. */
  readOnly?: boolean;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const cancelRename = useCallback(() => setRenamingIndex(null), []);
  const rename = useCallback((label: string, name: string) => {
    setRenamingIndex(null);
    onRename(label, name);
  }, [onRename]);

  useEffect(() => {
    if (!jump) return;
    const target = listRef.current?.querySelector<HTMLElement>(`[data-turn="${jump.index}"]`);
    if (!target) return;
    const reduce = document.querySelector(".db-reduce-motion") !== null
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setFlashIndex(jump.index);
    const timer = window.setTimeout(() => setFlashIndex(null), 1600);
    return () => window.clearTimeout(timer);
  }, [jump]);

  return (
    <div className="db-meeting-transcript">
      {notice}
      <div className="db-meeting-turns" ref={listRef}>
        {turns.map((turn, index) => (
          <TranscriptTurnRow
            key={`${index}:${turn.startS ?? ""}`}
            turn={turn}
            index={index}
            flashing={flashIndex === index}
            first={index === 0 || turns[index - 1].speaker !== turn.speaker}
            last={index === turns.length - 1 || turns[index + 1].speaker !== turn.speaker}
            name={speakerDisplayName(turn.speaker, speakerNames, people)}
            renaming={renamingIndex === index}
            onStartRename={setRenamingIndex}
            onRename={rename}
            onCancelRename={cancelRename}
            readOnly={readOnly}
          />
        ))}
      </div>
    </div>
  );
});

type ActionStatus =
  | { tone: "info"; text: string }
  | { tone: "error"; text: string }
  | null;

/** The last segment of a saved file's path, for the export dialog. */
function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function actionErrorText(err: unknown): string {
  return meetingActionFailureCopy(err instanceof MeetingActionError ? err.code : "");
}

function MeetingDetail({
  meeting,
  local,
  initialSecond,
  onBack,
  onListReload,
  onLocalReload,
}: {
  meeting: MeetingDoc;
  local?: LocalRecording;
  /** Open at this moment of the transcript: a chat citation or a search hit. */
  initialSecond?: number | null;
  onBack: () => void;
  onListReload: () => void;
  onLocalReload: () => void;
}) {
  const detail = useDashboardResource<MeetingDoc | null>(
    `meeting:${meeting.meetingId}`,
    (signal) => getMeeting(meeting.meetingId, signal),
  );
  // The doc a pin, edit or regenerate just returned, shown until the reload
  // it triggers lands, so the page never flashes back to the old note.
  const [updated, setUpdated] = useState<MeetingDoc | null>(null);
  useEffect(() => {
    setUpdated(null);
  }, [detail.data]);
  const current = updated ?? detail.data ?? meeting;
  const state = visualState(current, local);
  // While the note is being made, keep both sources fresh so the steps move on
  // their own; refresh the list once it lands so its card stops spinning too.
  const reloadDetail = detail.reload;
  const wasProcessing = useRef(state === "processing");
  useEffect(() => {
    if (state !== "processing") {
      if (wasProcessing.current) onListReload();
      wasProcessing.current = false;
      return;
    }
    wasProcessing.current = true;
    const timer = window.setInterval(() => {
      reloadDetail();
      onLocalReload();
    }, PROGRESS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [state, reloadDetail, onLocalReload, onListReload]);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  const pane = useTabStage<MeetingPane>("transcript");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "pin" | "restore" | "regenerate" | "export">("");
  const [regeneratingKind, setRegeneratingKind] = useState<MeetingKind | null>(null);
  const [pendingKind, setPendingKind] = useState<MeetingKind | null>(null);
  const [status, setStatus] = useState<ActionStatus>(null);
  // The file an export just wrote; shown in a dialog with Open.
  const [saved, setSaved] = useState<{ path: string; format: MeetingExportFormat } | null>(null);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [jump, setJump] = useState<{ index: number; nonce: number } | null>(null);
  // One panel under the actions bar at a time: a send to Notion or Slack.
  const [panel, setPanel] = useState<null | PendingActionTool>(null);
  // The follow-up email floats in its own compose card, so it stays open
  // while the notes and transcript are read and other panels come and go.
  const [followUpOpen, setFollowUpOpen] = useState(false);
  // Which destinations the user has connected; read once per opened meeting.
  const [connected, setConnected] = useState({ notion: false, slack: false });
  // Null until read; decides whether "Others" is named automatically.
  const [calendarConnected, setCalendarConnected] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchConnectors()
      .then((catalog) => {
        if (!cancelled) {
          setConnected({ notion: catalog.notion.enabled, slack: catalog.accounts.slack.enabled });
          setCalendarConnected(catalog.googleCalendar.enabled);
        }
      })
      .catch((err) => logError("MeetingsPage: connector status", err));
    return () => {
      cancelled = true;
    };
  }, []);

  const note = current.note ? shownNote(current.note, current.editedNote) : null;
  const turns = current.note?.transcript ?? [];

  // "Others" carries a real name: the user's own, else the invitees of the
  // calendar event behind the meeting. An ad-hoc call was claimed without an
  // event, so with Calendar connected Aura looks one up, once per meeting.
  const meetingId = current.meetingId;
  const [matching, setMatching] = useState(false);
  const [whoIsDismissed, setWhoIsDismissed] = useState(false);
  const othersUnnamed = state === "ready"
    && turns.some((turn) => turn.speaker === OTHERS_LABEL)
    && !current.speakerNames[OTHERS_LABEL]
    && current.people.length === 0;
  const matchCalendar = useCallback(async () => {
    setMatching(true);
    try {
      setUpdated(await matchMeetingCalendar(meetingId));
      reloadDetail();
      onListReload();
    } catch (err) {
      if (err instanceof MeetingActionError && err.code === "calendar_not_connected") {
        setCalendarConnected(false);
      } else {
        logError("MeetingsPage: calendar match", err);
        setStatus({ tone: "error", text: actionErrorText(err) });
      }
    } finally {
      setMatching(false);
    }
  }, [meetingId, reloadDetail, onListReload]);
  const autoMatchedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!othersUnnamed || current.calendarMatch !== null || calendarConnected !== true) return;
    if (autoMatchedRef.current === meetingId) return;
    autoMatchedRef.current = meetingId;
    void matchCalendar();
  }, [othersUnnamed, current.calendarMatch, calendarConnected, meetingId, matchCalendar]);
  const calendarJustConnected = useCallback(() => {
    autoMatchedRef.current = null;
    setCalendarConnected(true);
  }, []);
  const renameSpeaker = useCallback((label: string, name: string) => {
    if (name === (current.speakerNames[label] ?? "")) return;
    setStatus(null);
    void setSpeakerName(meetingId, label, name)
      .then((doc) => {
        setUpdated(doc);
        reloadDetail();
      })
      .catch((err) => {
        logError("MeetingsPage: rename speaker", err);
        setStatus({ tone: "error", text: actionErrorText(err) });
      });
  }, [meetingId, current.speakerNames, reloadDetail]);
  const whoIs: WhoIsState | null = !othersUnnamed || whoIsDismissed
    ? null
    : matching
      ? "checking"
      : current.calendarMatch !== null
        ? "no_event"
        : calendarConnected === false
          ? "connect"
          : null;
  const dateLabel = shortDateTime(current.createdAt);
  const retention = retentionLabel(current);
  const canPin = current.pinned || current.expiresAt !== null;
  const kindLabel = (kind: MeetingKind) => meetingKindLabels[kind] ?? meetingKindLabels.meeting;

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

  /** One path for every server action: show the doc it returns at once, then
   *  refresh both the detail and the list behind it. */
  const runAction = async (
    kind: "save" | "pin" | "restore" | "regenerate",
    action: () => Promise<MeetingDoc>,
    after?: () => void,
  ) => {
    setBusy(kind);
    setStatus(null);
    try {
      setUpdated(await action());
      after?.();
      detail.reload();
      onListReload();
    } catch (err) {
      logError(`MeetingsPage: ${kind} meeting`, err);
      setStatus({ tone: "error", text: actionErrorText(err) });
    } finally {
      setBusy("");
    }
  };

  // Copies whichever tab is open: the whole transcript, or the whole note.
  const copyTranscript = turns.length > 0 && pane.tab === "transcript";
  const copyNotes = async () => {
    try {
      await writeText(copyTranscript ? transcriptText(turns) : noteMarkdown(current, dateLabel));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      trackEvent("meeting_notes_copied", { tab: copyTranscript ? "transcript" : "insights" });
    } catch (err) {
      logError("MeetingsPage: copy notes", err);
      setStatus({ tone: "error", text: "Aura couldn't copy the notes. Try again." });
    }
  };

  const exportAs = async (format: MeetingExportFormat) => {
    setBusy("export");
    setStatus(null);
    try {
      const text = format === "md"
        ? noteMarkdown(current, dateLabel)
        : format === "vtt"
          ? transcriptVtt(turns)
          : transcriptText(turns);
      const path = await saveMeetingFile(current.title || "Meeting notes", format, text);
      setSaved({ path, format });
      trackEvent("meeting_exported", { format });
    } catch (err) {
      logError("MeetingsPage: export meeting", err);
      setStatus({
        tone: "error",
        text: typeof err === "string" ? err : "Aura couldn't save that file. Try again in a moment.",
      });
    } finally {
      setBusy("");
    }
  };

  const askAura = async () => {
    setStatus(null);
    try {
      const payload: ChatAttachRequest = {
        fileName: `${(current.title || "Meeting").replace(/[\\/:*?"<>|]+/g, " ").trim()} notes.txt`,
        text: meetingChatDocument(current, dateLabel),
      };
      await emitTo("main", CHAT_ATTACH_REQUESTED, payload);
      await invoke("summon_chat");
      trackEvent("meeting_ask_aura", { turns: turns.length });
    } catch (err) {
      logError("MeetingsPage: ask aura about meeting", err);
      setStatus({ tone: "error", text: "Aura couldn't open chat. Try again." });
    }
  };

  const regenerate = (kind: MeetingKind) => {
    setPendingKind(null);
    setEditing(false);
    setRegeneratingKind(kind);
    void runAction(
      "regenerate",
      () => regenerateMeetingNote(current.meetingId, kind),
      () => trackEvent("meeting_regenerated", { kind }),
    ).finally(() => setRegeneratingKind(null));
  };

  const askRegenerate = (kind: MeetingKind) => {
    if (current.editedNote) setPendingKind(kind);
    else regenerate(kind);
  };

  const jumpToSecond = (startS: number) => {
    setJump({ index: chapterTurnIndex(turns, startS), nonce: Date.now() });
    if (pane.tab !== "transcript") pane.switchTab("transcript");
  };

  const openChapter = (startS: number) => {
    jumpToSecond(startS);
    trackEvent("meeting_chapter_opened", {});
  };

  // A link that names a moment jumps there once, as soon as the transcript
  // has loaded; later re-renders of the same meeting leave the view alone.
  const jumpedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (initialSecond == null || turns.length === 0) return;
    const key = `${current.meetingId}:${initialSecond}`;
    if (jumpedForRef.current === key) return;
    jumpedForRef.current = key;
    jumpToSecond(initialSecond);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSecond, turns.length, current.meetingId]);

  const menuItems: RowMenuItem[] = note
    ? [
        {
          label: meetingNotes.edit,
          Icon: Pencil,
          disabled: editing || busy !== "",
          onSelect: () => {
            setStatus(null);
            setPendingKind(null);
            setEditing(true);
            // The editor lives on the Insights tab.
            if (pane.tab !== "insights") pane.switchTab("insights");
          },
        },
        ...(connected.notion
          ? [{
              label: meetingShareCopy.notion,
              Icon: NotebookPen,
              disabled: busy !== "",
              onSelect: () => setPanel("notion_save_meeting"),
            }]
          : []),
        ...(connected.slack
          ? [{
              label: meetingShareCopy.slack,
              Icon: Hash,
              disabled: busy !== "",
              onSelect: () => setPanel("slack_post_meeting"),
            }]
          : []),
        { label: meetingNotes.exportMarkdown, Icon: FileText, onSelect: () => void exportAs("md") },
        {
          label: meetingNotes.exportText,
          Icon: FileDown,
          disabled: turns.length === 0,
          onSelect: () => void exportAs("txt"),
        },
        {
          label: meetingNotes.exportSubtitles,
          Icon: Captions,
          disabled: !canExportSubtitles(turns),
          onSelect: () => void exportAs("vtt"),
        },
        ...MEETING_KINDS.filter((kind) => kind !== note.kind).map((kind) => ({
          label: meetingNotes.regenerateAs(kindLabel(kind).toLowerCase()),
          Icon: WandSparkles,
          disabled: turns.length === 0 || busy !== "",
          onSelect: () => askRegenerate(kind),
        })),
        ...(current.editedNote
          ? [{
              label: meetingNotes.restoreAi,
              Icon: RotateCcw,
              disabled: busy !== "",
              onSelect: () =>
                void runAction(
                  "restore",
                  () => restoreAiNote(current.meetingId),
                  () => trackEvent("meeting_note_restored", {}),
                ),
            }]
          : []),
      ]
    : [];

  // Sits on the tab row's right edge and copies whichever tab is open.
  const copyButton = (
    <button
      type="button"
      className="db-row-action db-meeting-copy"
      title={copied
        ? meetingNotes.copied
        : copyTranscript ? meetingNotes.copyTranscript : meetingNotes.copyNotes}
      aria-label={copyTranscript ? meetingNotes.copyTranscript : meetingNotes.copyNotes}
      onClick={() => void copyNotes()}
    >
      {copied ? <Check size={17} /> : <Copy size={17} />}
    </button>
  );

  const insights = note ? (
    editing ? (
      <MeetingNoteEditor
        note={note}
        saving={busy === "save"}
        onCancel={() => setEditing(false)}
        onSave={(edited) =>
          void runAction(
            "save",
            () => saveEditedNote(current.meetingId, edited),
            () => {
              setEditing(false);
              trackEvent("meeting_note_edited", {});
            },
          )
        }
      />
    ) : (
      <MeetingInsights note={note} onChapter={turns.length > 0 ? openChapter : undefined} />
    )
  ) : null;

  return (
    <div className="db-meeting-detail ph-no-capture">
      <div className="db-meeting-detail-bar">
        <button type="button" className="db-meeting-back" onClick={onBack}>
          <ArrowLeft size={17} /> Back to meetings
        </button>
        <RefreshIndicator
          refreshing={detail.refreshing && state !== "processing"}
          stale={detail.stale || detail.error}
          cachedAt={detail.cachedAt}
          onRetry={detail.reload}
        />
      </div>

      <div className="db-meeting-heading-row">
        <div>
          <h1 className="db-meeting-title">{current.title || "Untitled meeting"}</h1>
          <p className="db-detail-meta">
            {dateLabel}
            {state === "ready" && retention && <> · {retention}</>}
          </p>
        </div>
        {state === "ready" && note && (
          <div className="db-meeting-actions">
            <button
              type="button"
              className="db-row-action"
              title={meetingNotes.askAura}
              aria-label={meetingNotes.askAura}
              onClick={() => void askAura()}
            >
              <MessageCircleQuestion size={17} />
            </button>
            <button
              type="button"
              className={`db-row-action${followUpOpen ? " is-active" : ""}`}
              title={meetingFollowUpCopy.button}
              aria-label={meetingFollowUpCopy.button}
              aria-pressed={followUpOpen}
              onClick={() => setFollowUpOpen((open) => !open)}
            >
              <Mail size={17} />
            </button>
            {canPin && (
              <button
                type="button"
                className={`db-row-action${current.pinned ? " is-active" : ""}`}
                aria-pressed={current.pinned}
                aria-label={current.pinned ? meetingNotes.pinned : meetingNotes.pin}
                title={current.pinned ? meetingNotes.pinned : meetingNotes.pinHint}
                disabled={busy !== ""}
                onClick={() => {
                  const pinned = !current.pinned;
                  void runAction(
                    "pin",
                    () => setMeetingPinned(current.meetingId, pinned),
                    () => trackEvent("meeting_pinned", { pinned }),
                  );
                }}
              >
                {current.pinned ? <PinOff size={17} /> : <Pin size={17} />}
              </button>
            )}
            <RowMenu items={menuItems} open={menuOpen} onOpenChange={setMenuOpen} />
          </div>
        )}
      </div>

      {state === "ready" && note && followUpOpen && (
        <MeetingFollowUp meetingId={current.meetingId} onClose={() => setFollowUpOpen(false)} />
      )}
      {state === "ready" && note && panel === "slack_post_meeting" && (
        <MeetingSendToSlack meeting={current} onClose={() => setPanel(null)} />
      )}
      {state === "ready" && note && panel && panel !== "slack_post_meeting" && (
        <MeetingShare meeting={current} tool={panel} onClose={() => setPanel(null)} />
      )}
      {pendingKind && (
        <div className="db-meeting-action-status" role="alert">
          <span>{meetingNotes.regenerateReplacesEdits}</span>
          <button type="button" className="db-secondary-btn" onClick={() => setPendingKind(null)}>
            {meetingNotes.cancel}
          </button>
          <button type="button" className="db-primary-btn" onClick={() => regenerate(pendingKind)}>
            {meetingNotes.regenerateAs(kindLabel(pendingKind).toLowerCase())}
          </button>
        </div>
      )}
      {regeneratingKind && (
        <p className="db-meeting-action-status" role="status">
          <LoaderCircle size={15} className="db-meeting-spin" />
          {meetingNotes.regenerating(kindLabel(regeneratingKind).toLowerCase())}
        </p>
      )}
      {status && (
        <div
          className={`db-meeting-action-status${status.tone === "error" ? " is-error" : ""}`}
          role={status.tone === "error" ? "alert" : "status"}
        >
          <span>{status.text}</span>
        </div>
      )}
      {saved && (
        <MeetingDialog
          title={meetingNotes.exportedTitle(saved.format)}
          onDismiss={() => setSaved(null)}
          actions={
            <>
              <button type="button" className="db-local-confirm-cancel" onClick={() => setSaved(null)}>
                {meetingNotes.close}
              </button>
              <button
                type="button"
                className="db-local-confirm-primary"
                autoFocus
                onClick={() => {
                  const path = saved.path;
                  setSaved(null);
                  void openPath(path).catch(() =>
                    setStatus({ tone: "error", text: meetingNotes.openFailed("Downloads, Aura Documents") }),
                  );
                }}
              >
                {meetingNotes.open}
              </button>
            </>
          }
        >
          <p>{meetingNotes.savedFile(fileName(saved.path), "Downloads, Aura Documents")}</p>
        </MeetingDialog>
      )}

      {state === "ready" && note ? (
        turns.length === 0 ? (
          <div className="db-detail">
            <div className="db-meeting-tab-row">
              <span />
              <span />
              {copyButton}
            </div>
            {insights}
          </div>
        ) : (
          <div className="db-detail">
            <div className="db-meeting-tab-row">
              <span />
              <SlidingTabs
                tabs={[
                  {
                    value: "transcript",
                    label: "Transcript",
                    Icon: MessageSquareText,
                    count: turns.length,
                  },
                  { value: "insights", label: "Insights", Icon: Sparkles },
                ]}
                value={pane.tab}
                onChange={pane.switchTab}
                ariaLabel="Meeting detail"
                idPrefix="meeting"
              />
              {copyButton}
            </div>
            <div className={`db-tab-stage is-${pane.transition}`}>
              {pane.renderedTab === "transcript" ? (
                <div id="meeting-transcript-panel" role="tabpanel" aria-labelledby="meeting-transcript-tab">
                  <MeetingTranscript
                    turns={turns}
                    jump={jump}
                    speakerNames={current.speakerNames}
                    people={current.people}
                    onRename={renameSpeaker}
                    notice={whoIs && (
                      <WhoIsCard
                        state={whoIs}
                        time={timeOfDay(current.createdAt)}
                        onConnected={calendarJustConnected}
                        onSaveName={(name) => renameSpeaker(OTHERS_LABEL, name)}
                        onDismiss={() => setWhoIsDismissed(true)}
                      />
                    )}
                  />
                </div>
              ) : (
                <div id="meeting-insights-panel" role="tabpanel" aria-labelledby="meeting-insights-tab">
                  {insights}
                </div>
              )}
            </div>
          </div>
        )
      ) : state === "processing" ? (
        <MeetingProgress meeting={current} local={local} />
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

/// The device-copy actions for one card's overflow menu, plus the confirm
/// dialog Delete local audio needs. Outcomes land in the page's notice line.
function useLocalRecordingActions(
  loadRecordings: () => void,
  onListReload: () => void,
  setNotice: (notice: string | null) => void,
) {
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<LocalRecording | null>(null);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  const exportRecording = (recording: LocalRecording, includeAudio: boolean) =>
    run(async () => {
      try {
        const result = await invoke<ExportResult>("export_local_recording", {
          meetingId: recording.meetingId,
          captureRunId: recording.captureRunId,
          includeAudio,
        });
        const done = includeAudio
          ? `Exported ${result.segmentCount} verified audio segment${result.segmentCount === 1 ? "" : "s"}`
          : "Exported a sanitized support bundle";
        try {
          await openPath(result.path);
          setNotice(`${done}.`);
        } catch (err) {
          logError("MeetingsPage: open exported local recording", err);
          setNotice(`${done}, but Aura could not open its folder.`);
        }
      } catch (err) {
        logError("MeetingsPage: export local recording", err);
        setNotice("Aura could not export this recording. Its retained copy was not changed.");
      }
    });

  const retryRecording = (recording: LocalRecording) =>
    run(async () => {
      try {
        const requeued = await invoke<boolean>("retry_capture_jobs", {
          captureRunId: recording.captureRunId,
        });
        setNotice(
          requeued
            ? "Queued for upload. Aura will send it and build the note."
            : "Nothing left to send for this recording.",
        );
        loadRecordings();
        onListReload();
      } catch (err) {
        logError("MeetingsPage: retry local recording", err);
        setNotice("Aura could not queue this recording. Its local copy is untouched.");
      }
    });

  const deleteRecording = (recording: LocalRecording) =>
    run(async () => {
      try {
        await invoke("delete_local_recording", {
          meetingId: recording.meetingId,
          captureRunId: recording.captureRunId,
        });
        setNotice("Removing local audio. Cloud notes stay available.");
        loadRecordings();
      } catch (err) {
        logError("MeetingsPage: delete local recording", err);
        setNotice("Aura could not finish deletion. It will retain and retry the deletion job.");
      } finally {
        setPendingDelete(null);
      }
    });

  // Stable between renders so the page's card models (and every card) stay
  // memoized while the user types in search. The actions above only close
  // over these deps and state setters.
  const menuItems = useCallback((recording: LocalRecording | undefined): RowMenuItem[] => {
    if (!recording || recording.state === "local_deleted") return [];
    const settled = !recording.exportable || recording.state === "delete_requested";
    return [
      ...(canRetryLocally(recording)
        ? [{
            label: "Process now",
            Icon: RefreshCw,
            disabled: busy,
            onSelect: () => void retryRecording(recording),
          }]
        : []),
      {
        label: "Export audio",
        Icon: Download,
        disabled: busy || settled,
        onSelect: () => void exportRecording(recording, true),
      },
      {
        label: "Support bundle",
        Icon: FileJson,
        disabled: busy,
        onSelect: () => void exportRecording(recording, false),
      },
      {
        label: "Delete local audio",
        Icon: Trash2,
        danger: true,
        disabled: busy || settled,
        onSelect: () => setPendingDelete(recording),
      },
    ];
  }, [busy, loadRecordings, onListReload, setNotice]);

  const dialog = pendingDelete && (
    <div
      className="db-local-confirm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="local-delete-title"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) setPendingDelete(null);
      }}
    >
      <button
        type="button"
        className="db-local-confirm-scrim"
        aria-label="Keep local audio"
        disabled={busy}
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
            disabled={busy}
            onClick={() => setPendingDelete(null)}
          >
            Keep audio
          </button>
          <button
            type="button"
            className="db-local-confirm-delete"
            disabled={busy}
            onClick={() => void deleteRecording(pendingDelete)}
          >
            <Trash2 size={15} />
            {busy ? "Removing..." : "Delete audio"}
          </button>
        </div>
      </div>
    </div>
  );

  return { menuItems, dialog };
}

/** Route to the Meetings page with one meeting open (Home links use this). */
export function meetingPath(meetingId: string): string {
  return `/meetings?id=${encodeURIComponent(meetingId)}`;
}

type KindFilter = MeetingKind | "all";

const KIND_FILTER_OPTIONS: { value: KindFilter; label: string }[] = [
  { value: "all", label: "All" },
  ...MEETING_KINDS.map((kind) => ({ value: kind, label: meetingKindLabels[kind] ?? kind })),
];

/** Typing pauses this long before a search runs, so a query is one request. */
const SEARCH_DEBOUNCE_MS = 400;

export function MeetingsPage() {
  const [kind, setKind] = useState<KindFilter>("all");
  const res = useDashboardResource<MeetingDoc[]>(
    kind === "all" ? "meetings" : `meetings:${kind}`,
    (signal) => getMeetings(signal, { kind: kind === "all" ? "" : kind }),
  );
  const local = useLocalRecordings();
  const captureModes = useMeetingCaptureModes(() => {
    res.reload();
    local.loadRecordings();
  });
  const [searchParams, setSearchParams] = useSearchParams();
  const paramId = searchParams.get("id");
  const paramSecond = Number.parseInt(searchParams.get("t") ?? "", 10);
  const [selectedId, setSelectedIdState] = useState<string | null>(paramId);
  const [openSecond, setOpenSecond] = useState<number | null>(
    Number.isFinite(paramSecond) ? paramSecond : null,
  );
  useEffect(() => {
    if (!paramId) return;
    setSelectedIdState(paramId);
    setOpenSecond(Number.isFinite(paramSecond) ? paramSecond : null);
  }, [paramId, paramSecond]);
  const setSelectedId = (id: string | null, second: number | null = null) => {
    setSelectedIdState(id);
    setOpenSecond(second);
    if (!id && paramId) setSearchParams({}, { replace: true });
  };
  const [pendingMeetingDelete, setPendingMeetingDelete] = useState<MeetingDoc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const localActions = useLocalRecordingActions(local.loadRecordings, res.reload, setNotice);
  const localMenuItems = localActions.menuItems;

  // "Load more" pages, appended after the first page the resource owns. A
  // filter change starts over.
  const [morePages, setMorePages] = useState<MeetingDoc[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [noMore, setNoMore] = useState(false);
  useEffect(() => {
    setMorePages([]);
    setNoMore(false);
  }, [kind, res.data]);

  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<{
    query: string;
    results: MeetingSearchResult[] | null;
    error: boolean;
  }>({ query: "", results: null, error: false });
  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setSearch({ query: "", results: null, error: false });
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchMeetings(trimmed, controller.signal)
        .then((results) => {
          setSearch({ query: trimmed, results, error: false });
          trackEvent("meetings_searched", { results: results.length });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          logError("MeetingsPage: search", err);
          setSearch({ query: trimmed, results: [], error: true });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  // A link (chat citation, notification, Home) can name a meeting older than
  // any loaded page; fetch it on its own so the link always opens it.
  const [linked, setLinked] = useState<MeetingDoc | null>(null);

  const listed = useMemo(() => [...(res.data ?? []), ...morePages], [res.data, morePages]);
  const searching = search.results !== null;
  const meetings = useMemo(
    () => (searching ? (search.results ?? []).map((result) => result.meeting) : listed),
    [searching, search.results, listed],
  );
  const localByMeeting = useMemo(() => {
    const map = new Map<string, LocalRecording>();
    for (const recording of local.recordings) {
      map.set(recording.meetingId, recording);
    }
    return map;
  }, [local.recordings]);
  const models = useMemo(
    () =>
      searching
        ? (search.results ?? []).map((result) => ({
            ...meetingToCard(
              result.meeting,
              localByMeeting.get(result.meeting.meetingId),
              setPendingMeetingDelete,
              localMenuItems(localByMeeting.get(result.meeting.meetingId)),
            ),
            preview: result.excerpt || result.meeting.note?.summary || "",
          }))
        : meetings.map((meeting) =>
            meetingToCard(
              meeting,
              localByMeeting.get(meeting.meetingId),
              setPendingMeetingDelete,
              localMenuItems(localByMeeting.get(meeting.meetingId)),
            ),
          ),
    [searching, search.results, meetings, localByMeeting, localMenuItems],
  );
  const known = selectedId
    ? meetings.find((meeting) => meeting.meetingId === selectedId)
      ?? listed.find((meeting) => meeting.meetingId === selectedId)
      ?? (linked?.meetingId === selectedId ? linked : null)
    : null;
  const selectedMeeting = known ?? null;

  useEffect(() => {
    if (!selectedId || known || res.loading) return;
    let cancelled = false;
    getMeeting(selectedId)
      .then((meeting) => {
        if (!cancelled) setLinked(meeting);
      })
      .catch((err) => logError("MeetingsPage: open linked meeting", err));
    return () => {
      cancelled = true;
    };
  }, [selectedId, known, res.loading]);

  const loadMore = async () => {
    const last = listed[listed.length - 1];
    if (!last || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await getMeetings(undefined, {
        kind: kind === "all" ? "" : kind,
        before: last.createdAt,
      });
      setMorePages((current) => [...current, ...page]);
      if (page.length < 20) setNoMore(true);
    } catch (err) {
      logError("MeetingsPage: load more", err);
      setNotice("Aura couldn't load more meetings. Try again.");
    } finally {
      setLoadingMore(false);
    }
  };

  // Stable for the memoized cards. Inlines setSelectedId(id, second), which
  // with a non-null id only sets these two states.
  const openFromList = useCallback((id: string) => {
    const hit = search.results?.find((result) => result.meeting.meetingId === id);
    setSelectedIdState(id);
    setOpenSecond(hit && hit.matchStartS > 0 ? hit.matchStartS : null);
  }, [search.results]);

  const removeMeeting = async (meeting: MeetingDoc) => {
    setDeleting(true);
    setNotice(null);
    try {
      // Server first: it holds the authoritative copy (doc, notes, transcript).
      await deleteMeeting(meeting.meetingId);
    } catch (err) {
      logError("MeetingsPage: delete meeting", err);
      setNotice("Aura could not delete this meeting. Nothing was removed - try again.");
      setDeleting(false);
      setPendingMeetingDelete(null);
      return;
    }
    // Best effort local cascade: on failure the evidence store retains the
    // clip and retries its own deletion job, same as the recovery section.
    const recording = localByMeeting.get(meeting.meetingId);
    if (recording) {
      try {
        await invoke("delete_local_recording", {
          meetingId: recording.meetingId,
          captureRunId: recording.captureRunId,
        });
      } catch (err) {
        logError("MeetingsPage: delete meeting local audio", err);
      }
    }
    if (selectedId === meeting.meetingId) setSelectedId(null);
    setDeleting(false);
    setPendingMeetingDelete(null);
    res.reload();
    local.loadRecordings();
  };

  return (
    <div className="db-page db-page-full">
      {selectedMeeting ? (
        <MeetingDetail
          meeting={selectedMeeting}
          local={localByMeeting.get(selectedMeeting.meetingId)}
          initialSecond={openSecond}
          onBack={() => setSelectedId(null)}
          onListReload={res.reload}
          onLocalReload={local.loadRecordings}
        />
      ) : (
        <>
          <div className="db-page-toolbar">
            {searching ? (
              <span className="db-meeting-search-summary" role="status">
                {search.error
                  ? meetingSearchCopy.failed
                  : meetingSearchCopy.results(search.results?.length ?? 0, search.query)}
              </span>
            ) : (
              <ChipStrip
                label={meetingSearchCopy.kindLabel}
                options={KIND_FILTER_OPTIONS}
                value={kind}
                onChange={setKind}
              />
            )}
            <div className="db-meeting-toolbar-end">
              <MeetingCaptureButtons modes={captureModes} />
              <ExpandingSearch
                value={query}
                onChange={setQuery}
                placeholder={meetingSearchCopy.placeholder}
                label={meetingSearchCopy.label}
              />
              <RefreshIndicator
                refreshing={res.refreshing}
                stale={res.stale}
                cachedAt={res.cachedAt}
                onRetry={res.reload}
              />
            </div>
          </div>

          <MeetingCaptureStatus modes={captureModes} />
          {notice && (
            <p className="db-local-recordings-message" role="status">
              {notice}
            </p>
          )}
          {res.error && !searching ? (
            <PageError authExpired={res.authExpired} onRetry={res.reload} />
          ) : (
            <CardGrid
              models={models}
              loading={!searching && res.loading}
              columns="three"
              onOpen={openFromList}
              empty={
                searching ? (
                  <EmptyState
                    Icon={Search}
                    heading={meetingSearchCopy.emptyHeading}
                    copy={meetingSearchCopy.emptyCopy}
                  />
                ) : (
                  <EmptyState
                    Icon={Video}
                    heading={kind === "all" ? "No meetings yet" : meetingSearchCopy.noKind}
                    copy={
                      kind === "all"
                        ? "Turn on meeting notes during a call and your notes will show up here."
                        : meetingSearchCopy.noKindCopy
                    }
                  />
                )
              }
            />
          )}
          {!searching && !res.error && !noMore && (res.data?.length ?? 0) >= 20 && (
            <div className="db-meeting-load-more">
              <button
                type="button"
                className="db-secondary-btn"
                disabled={loadingMore}
                onClick={() => void loadMore()}
              >
                {loadingMore ? meetingSearchCopy.loadingMore : meetingSearchCopy.loadMore}
              </button>
            </div>
          )}
        </>
      )}

      {localActions.dialog}
      {pendingMeetingDelete && (
        <div
          className="db-local-confirm"
          role="dialog"
          aria-modal="true"
          aria-labelledby="meeting-delete-title"
          onKeyDown={(event) => {
            if (event.key === "Escape" && !deleting) setPendingMeetingDelete(null);
          }}
        >
          <button
            type="button"
            className="db-local-confirm-scrim"
            aria-label="Keep this recording"
            disabled={deleting}
            onClick={() => setPendingMeetingDelete(null)}
          />
          <div className="db-local-confirm-panel">
            <h2 id="meeting-delete-title">Delete this recording?</h2>
            <p>
              The recording, its notes and transcript are permanently deleted from
              Aura's servers. Any copy still on this device is removed too.
              This cannot be undone.
            </p>
            <div className="db-local-confirm-actions">
              <button
                type="button"
                className="db-local-confirm-cancel"
                autoFocus
                disabled={deleting}
                onClick={() => setPendingMeetingDelete(null)}
              >
                Keep recording
              </button>
              <button
                type="button"
                className="db-local-confirm-delete"
                disabled={deleting}
                onClick={() => void removeMeeting(pendingMeetingDelete)}
              >
                <Trash2 size={15} />
                {deleting ? "Deleting..." : "Delete recording"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
