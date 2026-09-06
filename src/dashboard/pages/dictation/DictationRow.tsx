import { memo } from "react";
import { Play, Square, Loader2, Flag, Trash2, FileText, Download, ScrollText } from "lucide-react";
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
/**
 * Memoized, and the handler props all take the entry rather than closing over
 * it. Both halves are needed: without `memo` every row re-rendered on every
 * keystroke and on every menu toggle, and with `memo` but per-row closures the
 * props would differ on every render and the memo would never hit.
 */
export const DictationRow = memo(function DictationRow({
  entry,
  playback,
  expanded,
  showRaw,
  menuOpen,
  onMenuOpenChange,
  onPlay,
  onToggleExpanded,
  onToggleRaw,
  onFlag,
  onDelete,
  onExportText,
  onExportAudio,
}: {
  entry: DictationHistoryEntry;
  playback: PlaybackState;
  expanded: boolean;
  showRaw: boolean;
  menuOpen: boolean;
  onMenuOpenChange: (entry: DictationHistoryEntry, open: boolean) => void;
  onPlay: (entry: DictationHistoryEntry) => void;
  onToggleExpanded: (entry: DictationHistoryEntry) => void;
  onToggleRaw: (entry: DictationHistoryEntry) => void;
  onFlag: (entry: DictationHistoryEntry) => void;
  onDelete: (entry: DictationHistoryEntry) => void;
  onExportText: (entry: DictationHistoryEntry) => void;
  onExportAudio: (entry: DictationHistoryEntry) => void;
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
      <div className="db-dictation-text-cell">
        <button
          type="button"
          className={expanded ? "db-dictation-text is-expanded" : "db-dictation-text"}
          aria-expanded={expanded}
          onClick={() => onToggleExpanded(entry)}
        >
          {entry.text}
        </button>
        {showRaw && entry.rawText && (
          <div className="db-dictation-raw">
            <span className="db-dictation-raw-label">Original speech</span>
            <p>{entry.rawText}</p>
          </div>
        )}
      </div>
      <div className="db-dictation-actions">
        <button
          type="button"
          className="db-row-action"
          title={playLabel}
          aria-label={playLabel}
          disabled={!entry.hasAudio || playback === "loading"}
          onClick={() => onPlay(entry)}
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
          onClick={() => onFlag(entry)}
        >
          {/* The fill is driven from CSS, not from this attribute: a
              presentation attribute loses to any rule, so hover and the
              reported state can both solid-fill the cloth in one place. */}
          <Flag size={17} fill="none" />
        </button>
        <RowMenu
          open={menuOpen}
          onOpenChange={(open) => onMenuOpenChange(entry, open)}
          label="More actions for this dictation"
          items={[
            { label: "Save as text", Icon: FileText, onSelect: () => onExportText(entry) },
            {
              label: "Extract audio",
              Icon: Download,
              onSelect: () => onExportAudio(entry),
              disabled: !entry.hasAudio,
            },
            {
              label: showRaw ? "Hide original speech" : "View original speech",
              Icon: ScrollText,
              onSelect: () => onToggleRaw(entry),
              // Present but greyed when polish never changed this dictation,
              // so the option is discoverable without implying hidden text.
              disabled: !entry.rawText,
            },
            { label: "Delete this transcript", Icon: Trash2, onSelect: () => onDelete(entry), danger: true },
          ]}
        />
      </div>
    </div>
  );
});
