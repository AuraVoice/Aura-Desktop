import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  HardDrive,
  LoaderCircle,
  MessageCircleQuestion,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
  Video,
  WandSparkles,
  type LucideIcon,
} from "lucide-react";
import { trackEvent } from "../../lib/analytics";
import { getMeeting, getMeetings } from "../../lib/dashboardApi";
import { CHAT_ATTACH_REQUESTED, type ChatAttachRequest } from "../../lib/ipcEvents";
import { logError } from "../../lib/log";
import {
  meetingActionFailureCopy,
  meetingFailureCopy,
  meetingKindLabels,
  meetingNotes,
} from "../../lib/meetingCopy";
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
  saveEditedNote,
  setMeetingPinned,
  type EditedNote,
  type MeetingDoc,
  type MeetingKind,
  type MeetingProcessingStage,
  type TranscriptTurn,
} from "../../lib/meetings";
import { CardGrid } from "../components/CardGrid";
import type { CardModel } from "../components/DashboardCard";
import { EmptyState } from "../components/EmptyState";
import { PageError } from "../components/PageError";
import { RefreshIndicator } from "../components/RefreshIndicator";
import { RowMenu, type RowMenuItem } from "../components/RowMenu";
import { SlidingTabs, useTabStage } from "../components/SlidingTabs";
import { shortDateTime } from "../format";
import { useDashboardResource } from "../useDashboardResource";
import { useMediaQuery } from "../useMediaQuery";

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

function MeetingTranscript({
  turns,
  jump,
}: {
  turns: TranscriptTurn[];
  /** A chapter click: scroll that turn into view and flash it. The nonce makes
   *  a second click on the same chapter move the view again. */
  jump: { index: number; nonce: number } | null;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);

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
      <div className="db-meeting-transcript-head">
        <h2>Transcript</h2>
        <span>{turns.length} turns</span>
      </div>
      <div className="db-meeting-turns" ref={listRef}>
        {turns.map((turn, index) => {
          const stamp = turnStamp(turn.startS);
          // "You" is the device owner's microphone channel; the backend owns
          // both labels, so this is the one comparison the client may make.
          const mine = turn.speaker === "You";
          return (
            <article
              className={`db-meeting-turn${mine ? " is-mine" : ""}${flashIndex === index ? " is-flash" : ""}`}
              key={`${index}:${turn.startS ?? ""}`}
              data-turn={index}
            >
              <header>
                <span className="db-meeting-turn-speaker">{turn.speaker || "Speaker"}</span>
                {stamp && <time className="db-meeting-turn-stamp">{stamp}</time>}
              </header>
              <p>{turn.text}</p>
            </article>
          );
        })}
      </div>
    </div>
  );
}

type ActionStatus =
  | { tone: "info"; text: string; path?: string }
  | { tone: "error"; text: string }
  | null;

function actionErrorText(err: unknown): string {
  return meetingActionFailureCopy(err instanceof MeetingActionError ? err.code : "");
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
  // The doc a pin, edit or regenerate just returned, shown until the reload
  // it triggers lands, so the page never flashes back to the old note.
  const [updated, setUpdated] = useState<MeetingDoc | null>(null);
  useEffect(() => {
    setUpdated(null);
  }, [detail.data]);
  const current = updated ?? detail.data ?? meeting;
  const state = visualState(current, local);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState(false);
  // Wide enough for two readable columns; below it the panes take turns.
  const stacked = useMediaQuery("(max-width: 1080px)");
  const pane = useTabStage<MeetingPane>("insights");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "pin" | "restore" | "regenerate" | "export">("");
  const [regeneratingKind, setRegeneratingKind] = useState<MeetingKind | null>(null);
  const [pendingKind, setPendingKind] = useState<MeetingKind | null>(null);
  const [status, setStatus] = useState<ActionStatus>(null);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [jump, setJump] = useState<{ index: number; nonce: number } | null>(null);

  const note = current.note ? shownNote(current.note, current.editedNote) : null;
  const turns = current.note?.transcript ?? [];
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

  const copyNotes = async () => {
    try {
      await writeText(noteMarkdown(current, dateLabel));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
      trackEvent("meeting_notes_copied", {});
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
      setStatus({ tone: "info", text: meetingNotes.savedTo("Downloads, Aura Documents"), path });
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

  const openChapter = (startS: number) => {
    setJump({ index: chapterTurnIndex(turns, startS), nonce: Date.now() });
    if (stacked && pane.tab !== "transcript") pane.switchTab("transcript");
    trackEvent("meeting_chapter_opened", {});
  };

  const menuItems: RowMenuItem[] = note
    ? [
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
          refreshing={detail.refreshing}
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
        <div className="db-meeting-tags">
          {state === "ready" && note && <span className="db-tag">{kindLabel(note.kind)}</span>}
          {state === "ready" && note?.edited && <span className="db-tag">{meetingNotes.editedTag}</span>}
          <span className={`db-tag db-tag-${state}`}>{statusLabel(current)}</span>
        </div>
      </div>

      {state === "ready" && note && (
        <div className="db-meeting-actions">
          <button type="button" className="db-secondary-btn" onClick={() => void copyNotes()}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? meetingNotes.copied : meetingNotes.copyNotes}
          </button>
          <button type="button" className="db-secondary-btn" onClick={() => void askAura()}>
            <MessageCircleQuestion size={15} />
            {meetingNotes.askAura}
          </button>
          <button
            type="button"
            className="db-secondary-btn"
            disabled={editing || busy !== ""}
            onClick={() => {
              setStatus(null);
              setPendingKind(null);
              setEditing(true);
            }}
          >
            <Pencil size={15} />
            {meetingNotes.edit}
          </button>
          {canPin && (
            <button
              type="button"
              className={`db-secondary-btn${current.pinned ? " is-active" : ""}`}
              aria-pressed={current.pinned}
              title={current.pinned ? undefined : meetingNotes.pinHint}
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
              {current.pinned ? <PinOff size={15} /> : <Pin size={15} />}
              {current.pinned ? meetingNotes.pinned : meetingNotes.pin}
            </button>
          )}
          <RowMenu items={menuItems} open={menuOpen} onOpenChange={setMenuOpen} />
        </div>
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
          {status.tone === "info" && status.path && (
            <button
              type="button"
              className="db-secondary-btn"
              onClick={() => {
                const path = status.path;
                if (!path) return;
                void openPath(path).catch(() =>
                  setStatus({ tone: "error", text: "Aura couldn't open it. Find it in Downloads, Aura Documents." }),
                );
              }}
            >
              Open
            </button>
          )}
        </div>
      )}

      {state === "ready" && note ? (
        turns.length === 0 ? (
          <div className="db-detail">{insights}</div>
        ) : stacked ? (
          <div className="db-detail">
            <SlidingTabs
              tabs={[
                { value: "insights", label: "Insights", Icon: Sparkles },
                {
                  value: "transcript",
                  label: "Transcript",
                  Icon: MessageSquareText,
                  count: turns.length,
                },
              ]}
              value={pane.tab}
              onChange={pane.switchTab}
              ariaLabel="Meeting detail"
              idPrefix="meeting"
            />
            <div className={`db-tab-stage is-${pane.transition}`}>
              {pane.renderedTab === "transcript" ? (
                <div id="meeting-transcript-panel" role="tabpanel" aria-labelledby="meeting-transcript-tab">
                  <MeetingTranscript turns={turns} jump={jump} />
                </div>
              ) : (
                <div id="meeting-insights-panel" role="tabpanel" aria-labelledby="meeting-insights-tab">
                  {insights}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="db-detail db-meeting-split">
            {insights}
            <MeetingTranscript turns={turns} jump={jump} />
          </div>
        )
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

/** Route to the Meetings page with one meeting open (Home links use this). */
export function meetingPath(meetingId: string): string {
  return `/meetings?id=${encodeURIComponent(meetingId)}`;
}

export function MeetingsPage() {
  const res = useDashboardResource<MeetingDoc[]>(
    "meetings",
    (signal) => getMeetings(signal),
  );
  const local = useLocalRecordings();
  const [searchParams, setSearchParams] = useSearchParams();
  const paramId = searchParams.get("id");
  const [selectedId, setSelectedIdState] = useState<string | null>(paramId);
  // An unknown or deleted id simply matches nothing and the list shows.
  useEffect(() => {
    if (paramId) setSelectedIdState(paramId);
  }, [paramId]);
  const setSelectedId = (id: string | null) => {
    setSelectedIdState(id);
    if (!id && paramId) setSearchParams({}, { replace: true });
  };
  const [pendingMeetingDelete, setPendingMeetingDelete] = useState<MeetingDoc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const meetings = useMemo(() => res.data ?? [], [res.data]);
  const localByMeeting = useMemo(() => {
    const map = new Map<string, LocalRecording>();
    for (const recording of local.recordings) {
      map.set(recording.meetingId, recording);
    }
    return map;
  }, [local.recordings]);
  const models = useMemo(
    () =>
      meetings.map((meeting) =>
        meetingToCard(meeting, localByMeeting.get(meeting.meetingId), setPendingMeetingDelete),
      ),
    [meetings, localByMeeting],
  );
  const selectedMeeting = selectedId
    ? meetings.find((meeting) => meeting.meetingId === selectedId) ?? null
    : null;

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

          {notice && (
            <p className="db-local-recordings-message" role="status">
              {notice}
            </p>
          )}
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
