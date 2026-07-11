import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CloseIcon } from "./icons";
import { meetingNotes as copy } from "../lib/meetingCopy";
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
  if (!doc || !doc.note) return null;
  const note = doc.note;

  const caveat = note.oneSided
    ? copy.oneSidedCaveat
    : note.partial
      ? copy.partialCaveat
      : note.language && !note.language.startsWith("en")
        ? copy.languageCaveat(note.language)
        : null;
  const bullets = note.actionItems.length > 0 ? note.actionItems : note.decisions;
  const bulletsHeading =
    note.actionItems.length > 0 ? copy.actionItemsHeading : copy.decisionsHeading;

  return (
    <GlassSurface className="meeting-notes-card" draggable={false}>
      <div className="meeting-notes-card-inner">
        <div className="meeting-notes-card-header">
          <span className="meeting-notes-card-title">{copy.cardTitle}</span>
          <span className="meeting-notes-card-meeting" title={doc.title}>
            {doc.title}
          </span>
          <BarIconButton title={copy.dismissTooltip} onClick={card.dismiss}>
            <CloseIcon />
          </BarIconButton>
        </div>

        <p className="meeting-notes-card-summary">{note.summary}</p>

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
          <button type="button" className="meeting-notes-card-turn-off" onClick={card.turnOff}>
            {copy.turnOff}
          </button>
        </div>
      </div>
    </GlassSurface>
  );
}
