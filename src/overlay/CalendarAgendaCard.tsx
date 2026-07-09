import { openUrl } from "@tauri-apps/plugin-opener";
import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CalendarIcon, CloseIcon } from "./icons";
import { calendarAgenda as copy } from "../lib/copy";
import { logError } from "../lib/log";
import type { MeetingsState } from "./useMeetings";
import "./CalendarAgendaCard.css";

/** Local wall-clock time of an event, e.g. "10:00 AM", from its UTC start. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Today's remaining meetings, opened from the kebab's Calendar entry. Reuses
 * the below-bar slot and the same useMeetings data as the ticker (no second
 * fetch). A row with a join link joins the meeting; a row without one opens the
 * event in Google Calendar. Not-connected and empty states never read as errors.
 */
export function CalendarAgendaCard({
  meetings,
  onClose,
}: {
  meetings: MeetingsState;
  onClose: () => void;
}) {
  const { connected, loaded, events } = meetings;
  const hasEvents = connected && events.length > 0;

  function openEvent(target: string | null) {
    if (!target) return;
    void openUrl(target).catch((err) => logError("CalendarAgendaCard: open event", err));
  }

  return (
    <GlassSurface className="calendar-agenda-card" draggable={false}>
      <div className="calendar-agenda-inner">
        <div className="calendar-agenda-header">
          <CalendarIcon />
          <span className="calendar-agenda-title">{copy.title}</span>
          <BarIconButton title={copy.dismissTooltip} onClick={onClose}>
            <CloseIcon />
          </BarIconButton>
        </div>

        {!loaded ? (
          <p className="calendar-agenda-empty">{copy.loading}</p>
        ) : !connected ? (
          <p className="calendar-agenda-empty">{copy.notConnected}</p>
        ) : events.length === 0 ? (
          <p className="calendar-agenda-empty">{copy.empty}</p>
        ) : (
          <ul className="calendar-agenda-list">
            {events.map((ev) => {
              const started = Date.parse(ev.startTime) < Date.now();
              const target = ev.meetingLink ?? ev.htmlLink;
              return (
                <li key={ev.id}>
                  <button
                    type="button"
                    className="calendar-agenda-row"
                    title={ev.meetingLink ? copy.joinTooltip : copy.openTooltip}
                    onClick={() => openEvent(target)}
                    disabled={!target}
                  >
                    <span className="calendar-agenda-time">
                      {started ? copy.now : shortTime(ev.startTime)}
                    </span>
                    <span className="calendar-agenda-event">{ev.title}</span>
                    {ev.meetingLink && <span className="calendar-agenda-join">{copy.join}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {hasEvents && (
          <button
            type="button"
            className="calendar-agenda-turn-off"
            onClick={meetings.turnOffAlerts}
          >
            {copy.turnOff}
          </button>
        )}
      </div>
    </GlassSurface>
  );
}
