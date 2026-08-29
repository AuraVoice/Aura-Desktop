import { Play, Square, Loader2, Flag, Trash2, FileText, Download } from "lucide-react";
import { CopyButton } from "../../components/CopyButton";
import { RowMenu } from "../../components/RowMenu";
import { timeOfDay } from "../../format";
import type { DictationHistoryEntry } from "../../../lib/dictationHistory";

export type PlaybackState = "idle" | "loading" | "playing";

/**
 * One dictation in the day card: `time | transcript | actions`.
 *
 * The action cluster is a SIBLING of the transcript button, never nested
 * inside it. Nesting interactive elements is invalid HTML and makes the row
 * untabbable, and it is the specific mistake the notifications panel's hover
 * pattern exists to avoid.
 *
 * The cluster is always laid out and only fades, so neither the row height nor
 * the text width shifts when the pointer enters.
 */
export function DictationRow({
  entry,
  playback,
  expanded,
  menuOpen,
  onMenuOpenChange,
  onPlay,
  onToggleExpanded,
  onFlag,
  onDelete,
  onExportText,
  onExportAudio,
}: {
  entry: DictationHistoryEntry;
  playback: PlaybackState;
  expanded: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (open: boolean) => void;
  onPlay: () => void;
  onToggleExpanded: () => void;
  onFlag: () => void;
  onDelete: () => void;
  onExportText: () => void;
  onExportAudio: () => void;
}) {
  const active = menuOpen || playback !== "idle";
  const playLabel = entry.hasAudio
    ? playback === "playing"
      ? "Stop"
      : "Play this dictation"
    : "The audio for this dictation is no longer stored";

  return (
    <div className={active ? "db-dictation-row is-active" : "db-dictation-row"}>
      <span className="db-dictation-time">{timeOfDay(entry.recordedAtMs)}</span>
      <button
        type="button"
        className={expanded ? "db-dictation-text is-expanded" : "db-dictation-text"}
        aria-expanded={expanded}
        onClick={onToggleExpanded}
      >
        {entry.text}
      </button>
      <div className="db-dictation-actions">
        <button
          type="button"
          className="db-row-action"
          title={playLabel}
          aria-label={playLabel}
          disabled={!entry.hasAudio || playback === "loading"}
          onClick={onPlay}
        >
          {playback === "loading" ? (
            <Loader2 size={17} className="db-spin" />
          ) : playback === "playing" ? (
            <Square size={16} />
          ) : (
            <Play size={17} />
          )}
        </button>
        <CopyButton text={entry.text} compact />
        <button
          type="button"
          className={
            entry.flagged
              ? "db-row-action db-row-action-flag is-flagged"
              : "db-row-action db-row-action-flag"
          }
          title="Report a bad transcription"
          aria-label="Report a bad transcription"
          onClick={onFlag}
        >
          {/* The fill is driven from CSS, not from this attribute: a
              presentation attribute loses to any rule, so hover and the
              reported state can both solid-fill the cloth in one place. */}
          <Flag size={17} fill="none" />
        </button>
        <RowMenu
          open={menuOpen}
          onOpenChange={onMenuOpenChange}
          label="More actions for this dictation"
          items={[
            { label: "Save as text", Icon: FileText, onSelect: onExportText },
            {
              label: "Extract audio",
              Icon: Download,
              onSelect: onExportAudio,
              disabled: !entry.hasAudio,
            },
            { label: "Delete this transcript", Icon: Trash2, onSelect: onDelete, danger: true },
          ]}
        />
      </div>
    </div>
  );
}
