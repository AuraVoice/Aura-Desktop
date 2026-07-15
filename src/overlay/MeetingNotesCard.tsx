import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CloseIcon } from "./icons";
import { meetingFailureCopy, meetingNotes as copy } from "../lib/meetingCopy";
import { openDashboard } from "../lib/dashboardLink";
import type { MeetingNotesState } from "./useMeetingNotes";
import "./MeetingNotesCard.css";

/**
 * A finished meeting note, delivered into the below-bar slot (between the
 * kebab menu and the catch-up card in OverlayRoot's priority ladder). Shows
 * the summary, the first few action items, and any honesty caveats (one-sided
 * capture, non-English audio); the dashboard holds the full history. Every
 * interactive element is a real <button> per the drag-region rule.
 */
export function MeetingNotesCard({ card }: { card: MeetingNotesState }) {
  const doc = card.doc;
  const activity = card.activity;
  if (!doc && !activity) return null;
  const note = doc?.note ?? null;

  const caveat = note?.oneSided
    ? copy.oneSidedCaveat
    : note?.partial
      ? copy.partialCaveat
      : note?.language && !note.language.startsWith("en")
        ? copy.languageCaveat(note.language)
        : null;
  const bullets = note
    ? note.actionItems.length > 0
      ? note.actionItems
      : note.decisions
    : [];
  const bulletsHeading =
    note && note.actionItems.length > 0 ? copy.actionItemsHeading : copy.decisionsHeading;
  const statusMessage = activity
    ? activity.phase === "saved_local"
      ? copy.savedLocal(activity.segmentCount)
      : activity.phase === "uploading"
        ? copy.uploading(activity.uploadedCount, activity.segmentCount)
        : activity.phase === "processing"
          ? copy.processing
          : activity.phase === "recording"
            ? "Recording this meeting securely."
            : meetingFailureCopy(activity.failureCode)
    : doc?.status === "excluded"
      ? meetingFailureCopy(doc.failureCode ?? "excluded_sensitive")
      : doc?.status === "failed"
        ? meetingFailureCopy(doc.failureCode)
        : doc?.processingStage === "building_insights"
          ? copy.buildingInsights
          : doc?.processingStage === "transcribing"
            ? copy.processingTranscript
            : copy.processing;
  const retryable = activity?.retryable === true || doc?.retryable === true;

  return (
    <GlassSurface className="meeting-notes-card" draggable={false}>
      <div className="meeting-notes-card-inner">
        <div className="meeting-notes-card-header">
          <span className="meeting-notes-card-title">{copy.cardTitle}</span>
          <span className="meeting-notes-card-meeting" title={doc?.title ?? ""}>
            {doc?.title ?? "Meeting activity"}
          </span>
          <BarIconButton title={copy.dismissTooltip} onClick={card.dismiss}>
            <CloseIcon />
          </BarIconButton>
        </div>

        <p className="meeting-notes-card-summary">{note?.summary || statusMessage}</p>

        {bullets.length > 0 && (
          <div className="meeting-notes-card-items">
            <span className="meeting-notes-card-items-heading">{bulletsHeading}</span>
            <ul className="meeting-notes-card-list">
              {bullets.slice(0, 3).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}

        {caveat && <p className="meeting-notes-card-caveat">{caveat}</p>}

        <div className="meeting-notes-card-footer">
          <button
            type="button"
            className="meeting-notes-card-view-all"
            onClick={() => void openDashboard()}
          >
            {copy.viewAll}
          </button>
          {retryable && (
            <button
              type="button"
              className="meeting-notes-card-retry"
              onClick={card.retry}
            >
              {copy.retryNow}
            </button>
          )}
          <button type="button" className="meeting-notes-card-turn-off" onClick={card.turnOff}>
            {copy.turnOff}
          </button>
        </div>
      </div>
    </GlassSurface>
  );
}
