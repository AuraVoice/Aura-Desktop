import { invoke } from "@tauri-apps/api/core";
import { blobToBase64 } from "./chatAttachments";
import type { EditedNote, MeetingDoc, MeetingNote, TranscriptTurn } from "./meetings";
import { meetingNotes } from "./meetingCopy";

export type MeetingExportFormat = "md" | "txt" | "vtt";

/** Writes the text into Downloads/Aura Documents (never overwriting) through
 *  the same command Swarm documents use. Returns the saved path. Rejects with
 *  the command's own message string. */
export async function saveMeetingFile(
  title: string,
  format: MeetingExportFormat,
  text: string,
): Promise<string> {
  const dataBase64 = await blobToBase64(new Blob([text], { type: "text/plain" }));
  const saved = await invoke<{ path: string }>("save_swarm_document", {
    stem: title.trim() || "Meeting notes",
    extension: format,
    dataBase64,
  });
  return saved.path;
}

/** The sections a reader sees: the user's edit when there is one, else the
 *  model's. Everything that is a record of what was said (transcript, debrief,
 *  chapters) always comes from the model's note. */
export type ShownNote = MeetingNote & { edited: boolean };

export function shownNote(note: MeetingNote, edited: EditedNote | null): ShownNote {
  if (!edited) return { ...note, edited: false };
  return {
    ...note,
    summary: edited.summary,
    decisions: edited.decisions,
    actionItems: edited.actionItems,
    openQuestions: edited.openQuestions,
    keyPoints: edited.keyPoints,
    blockers: edited.blockers,
    edited: true,
  };
}

/** "mm:ss", or "h:mm:ss" past the hour. */
export function clockStamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const body = `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return hours > 0 ? `${hours}:${body}` : body;
}

/** Subtitles need a start and an end on every turn; notes from before
 *  meeting-transcript-v3 have neither. */
export function canExportSubtitles(turns: TranscriptTurn[]): boolean {
  return turns.length > 0
    && turns.every((turn) => turn.startS !== undefined && turn.endS !== undefined);
}

function section(heading: string, items: string[]): string {
  return items.length ? `## ${heading}\n\n${items.map((item) => `- ${item}`).join("\n")}\n\n` : "";
}

function oneLine(text: string): string {
  return text.replace(/\s*\n+\s*/g, " ").trim();
}

/** The note as Markdown: what Copy notes puts on the clipboard and what the
 *  .md export holds. Pastes cleanly into Notion, Docs and email. */
export function noteMarkdown(meeting: MeetingDoc, dateLabel: string): string {
  if (!meeting.note) return "";
  const note = shownNote(meeting.note, meeting.editedNote);
  let out = `# ${meeting.title || "Untitled meeting"}\n\n`;
  if (dateLabel) out += `${dateLabel}\n\n`;
  if (note.summary) out += `## Summary\n\n${note.summary}\n\n`;
  out += section(meetingNotes.keyPointsHeading, note.keyPoints);
  if (note.kind === "interview" && note.debrief.length) {
    out += `## ${meetingNotes.debriefHeading}\n\n`;
    note.debrief.forEach((item, index) => {
      out += `${index + 1}. **${item.question}**\n   ${oneLine(item.answered)}\n`;
      if (item.improve) out += `   ${meetingNotes.debriefImprove} ${oneLine(item.improve)}\n`;
    });
    out += "\n";
  }
  out += section(meetingNotes.decisionsHeading, note.decisions);
  out += section(meetingNotes.actionItemsHeading, note.actionItems);
  out += section(meetingNotes.blockersHeading, note.blockers);
  out += section(meetingNotes.openQuestionsHeading, note.openQuestions);
  out += section(
    meetingNotes.chaptersHeading,
    note.chapters.map((chapter) => `${clockStamp(chapter.startS)} ${chapter.title}`),
  );
  return out.trimEnd() + "\n";
}

/** One line per turn, stamped when the turn has a time. */
export function transcriptText(turns: TranscriptTurn[]): string {
  return turns
    .map((turn) => {
      const stamp = turn.startS !== undefined ? `[${clockStamp(turn.startS)}] ` : "";
      return `${stamp}${turn.speaker || "Speaker"}: ${oneLine(turn.text)}`;
    })
    .join("\n") + "\n";
}

function vttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(hours)}:${two(minutes)}:${two(secs)}.${String(millis).padStart(3, "0")}`;
}

/** WebVTT, one cue per turn. Callers check canExportSubtitles first. A cue's
 *  text may not contain "-->" or a blank line, so both are flattened. */
export function transcriptVtt(turns: TranscriptTurn[]): string {
  const cues = turns.map((turn, index) => {
    const start = turn.startS ?? 0;
    const end = Math.max(turn.endS ?? start, start + 0.5);
    const text = oneLine(`${turn.speaker || "Speaker"}: ${turn.text}`).replace(/-->/g, "->");
    return `${index + 1}\n${vttTime(start)} --> ${vttTime(end)}\n${text}`;
  });
  return `WEBVTT\n\n${cues.join("\n\n")}\n`;
}

/** What "Ask Aura" attaches to chat: the note, then the full transcript, so a
 *  question can be answered from either. */
export function meetingChatDocument(meeting: MeetingDoc, dateLabel: string): string {
  const turns = meeting.note?.transcript ?? [];
  const notes = noteMarkdown(meeting, dateLabel);
  return turns.length ? `${notes}\n## Transcript\n\n${transcriptText(turns)}` : notes;
}
