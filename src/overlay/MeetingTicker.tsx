import { openUrl } from "@tauri-apps/plugin-opener";
import { BarIconButton } from "./BarIconButton";
import { CloseIcon, NotesIcon } from "./icons";
import { meetingTicker as copy } from "../lib/copy";
import { meetingNotes as notesCopy } from "../lib/meetingCopy";
import { logError } from "../lib/log";
import type { SoonestMeeting } from "./useMeetings";
import "./MeetingTicker.css";

/**
 * The "breaking news" meeting marquee that replaces the bar's caption when a
 * meeting is imminent (resolved by useMeetings, gated to !isLive by VoiceBar).
 * Only the label scrolls on a loop; the Join button and dismiss stay pinned so
 * they're clickable. Every interactive element is a real <button> (drag-region
 * rule).
 */
export function MeetingTicker({
  soonest,
  onDismiss,
  notesArmed = false,
}: {
  soonest: SoonestMeeting;
  onDismiss: (eventId: string) => void;
  /** Meeting notes are armed for this meeting (small passive glyph). */
  notesArmed?: boolean;
}) {
  const { meeting, minutesUntil } = soonest;
  const countdown = minutesUntil <= 0 ? copy.startingNow : copy.inMinutes(minutesUntil);
  const label = `${meeting.title} · ${countdown}${meeting.startLocal ? ` · ${meeting.startLocal}` : ""}`;

  function handleJoin() {
    if (!meeting.meetingLink) return;
    void openUrl(meeting.meetingLink).catch((err) => logError("MeetingTicker: join", err));
  }

  return (
    <div className="meeting-ticker">
      <span className="meeting-ticker-badge" aria-hidden="true" />
      {notesArmed && (
        <span className="meeting-ticker-notes-armed" title={notesCopy.armedTooltip}>
          <NotesIcon />
        </span>
      )}
      <div className="meeting-ticker-track" title={label}>
        <div className="meeting-ticker-scroll">
          <span className="meeting-ticker-text">{label}</span>
          <span className="meeting-ticker-text" aria-hidden="true">
            {label}
          </span>
        </div>
      </div>
      {meeting.meetingLink && (
        <button
          type="button"
          className="meeting-ticker-join"
          title={copy.joinTooltip}
          onClick={handleJoin}
        >
          {copy.join}
        </button>
      )}
      <BarIconButton title={copy.dismissTooltip} onClick={() => onDismiss(meeting.id)}>
        <CloseIcon />
      </BarIconButton>
    </div>
  );
}
