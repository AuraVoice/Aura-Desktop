import { openUrl } from "@tauri-apps/plugin-opener";
import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CalendarIcon, CloseIcon, NotesIcon, RefreshIcon } from "./icons";
import { calendarAgenda as copy, createEventUrl } from "../lib/copy";
import { meetingNotes as notesCopy } from "../lib/meetingCopy";
import { logError } from "../lib/log";
import type { UpcomingMeeting } from "../lib/calendar";
import type { MeetingsState } from "./useMeetings";
import { isEligibleForNotes, type MeetingArmState } from "./useMeetingArm";
import "./CalendarAgendaCard.css";

/** Local wall-clock time of an event, e.g. "10:00 AM", from its UTC start. */
function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Local short date of an event, e.g. "Jul 10", for a future (non-today) row. */
function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

/** Stable per-local-day key (Y-M-D) so "is this event today" ignores time. */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function isToday(iso: string, todayKey: string): boolean {
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && localDayKey(d) === todayKey;
}

/** Placeholder shimmer rows shown while the first fetch is in flight, sized to
 * mirror the real event rows so the card doesn't jump when data arrives. */
function AgendaSkeleton() {
  const widths = ["70%", "55%", "45%"];
  return (
    <div className="calendar-agenda-skeleton" aria-label={copy.loading} aria-busy="true">
      {widths.map((w) => (
        <div className="calendar-agenda-skeleton-row" key={w}>
          <span className="agenda-skeleton-pill agenda-skeleton-time" />
          <span className="agenda-skeleton-pill agenda-skeleton-title" style={{ width: w }} />
        </div>
      ))}
    </div>
  );
}

/**
 * Upcoming meetings, opened from the kebab's Calendar entry. Reuses the
 * below-bar slot and the same useMeetings data as the ticker (no second fetch).
 * When today still has meetings it lists those under "Today"; once today is
 * clear it falls back to the next events this week under "Upcoming"; only when
 * the whole week is empty does it show the centered "no events, create one"
 * state. A row with a join link joins the meeting; a row without one opens the
 * event in Google Calendar. The first load shows a skeleton, and a failed fetch
 * offers a retry so it never sticks.
 */
export function CalendarAgendaCard({
  meetings,
  arm,
  onClose,
  onConnect,
}: {
  meetings: MeetingsState;
  /** Meeting-notes arm state: per-row toggles + the global footer default. */
  arm: MeetingArmState;
  onClose: () => void;
  onConnect: () => void;
}) {
  const { connected, loaded, loadFailed, events } = meetings;

  const todayKey = localDayKey(new Date());
  const todayEvents = events.filter((ev) => isToday(ev.startTime, todayKey));
  // Today's meetings while any remain; otherwise the next upcoming ones. `events`
  // arrives sorted by start time, so its head is the soonest event.
  const showingToday = todayEvents.length > 0;
  const displayEvents: UpcomingMeeting[] = showingToday ? todayEvents : events;
  const headerTitle = showingToday ? copy.title : copy.upcomingTitle;
  const hasEvents = connected && events.length > 0;

  function openEvent(target: string | null) {
    if (!target) return;
    void openUrl(target).catch((err) => logError("CalendarAgendaCard: open event", err));
  }

  function openCreateEvent() {
    void openUrl(createEventUrl).catch((err) => logError("CalendarAgendaCard: create event", err));
  }

  return (
    <GlassSurface className="calendar-agenda-card" draggable={false}>
      <div className="calendar-agenda-inner">
        <div className="calendar-agenda-header">
          <CalendarIcon />
          <span className="calendar-agenda-title">{headerTitle}</span>
          <BarIconButton title={copy.dismissTooltip} onClick={onClose}>
            <CloseIcon />
          </BarIconButton>
        </div>

        {!loaded && !loadFailed ? (
          <AgendaSkeleton />
        ) : loadFailed ? (
          <div className="calendar-agenda-fallback">
            <p className="calendar-agenda-empty">{copy.errorTitle}</p>
            <button
              type="button"
              className="calendar-agenda-retry"
              onClick={meetings.refresh}
            >
              <RefreshIcon />
              <span>{copy.retry}</span>
            </button>
          </div>
        ) : !connected ? (
          <div className="calendar-agenda-fallback">
            <p className="calendar-agenda-empty">{copy.notConnected}</p>
            <button type="button" className="calendar-agenda-connect" onClick={onConnect}>
              {copy.connectCta}
            </button>
          </div>
        ) : events.length === 0 ? (
          <div className="calendar-agenda-empty-state">
            <p className="calendar-agenda-empty-text">{copy.empty}</p>
            <button type="button" className="calendar-agenda-connect" onClick={openCreateEvent}>
              {copy.createEvent}
            </button>
          </div>
        ) : (
          <ul className="calendar-agenda-list">
            {displayEvents.map((ev) => {
              const today = isToday(ev.startTime, todayKey);
              const started = Date.parse(ev.startTime) < Date.now();
              const target = ev.meetingLink ?? ev.htmlLink;
              // Long meetings (past the 60-minute clamp) and linkless events
              // get no arm toggle at all - not armable, not truncated.
              const armable = isEligibleForNotes(ev);
              const armed = armable && arm.isArmed(ev.id);
              return (
                <li key={ev.id} className="calendar-agenda-li">
                  <button
                    type="button"
                    className="calendar-agenda-row"
                    title={ev.meetingLink ? copy.joinTooltip : copy.openTooltip}
                    onClick={() => openEvent(target)}
                    disabled={!target}
                  >
                    <span className="calendar-agenda-time">
                      {today ? (
                        started ? copy.now : shortTime(ev.startTime)
                      ) : (
                        <>
                          <span className="calendar-agenda-when-date">{shortDate(ev.startTime)}</span>
                          <span className="calendar-agenda-when-time">{shortTime(ev.startTime)}</span>
                        </>
                      )}
                    </span>
                    <span className="calendar-agenda-event">{ev.title}</span>
                    {ev.meetingLink && <span className="calendar-agenda-join">{copy.join}</span>}
                  </button>
                  {/* Sibling of the row button (a button can't nest a button). */}
                  {armable && (
                    <BarIconButton
                      className="calendar-agenda-arm"
                      title={armed ? notesCopy.disarmTooltip : notesCopy.armTooltip}
                      active={armed}
                      onClick={() => arm.toggleArm(ev.id)}
                    >
                      <NotesIcon />
                      <span className="bar-icon-button-dot" aria-hidden="true" />
                    </BarIconButton>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {hasEvents && (
          <div className="calendar-agenda-footer">
            <button
              type="button"
              className="calendar-agenda-turn-off"
              onClick={meetings.turnOffAlerts}
            >
              {copy.turnOff}
            </button>
            <button
              type="button"
              className="calendar-agenda-turn-off calendar-agenda-auto-notes"
              onClick={arm.toggleAutoNotes}
            >
              {arm.autoNotes ? notesCopy.autoNotesOn : notesCopy.autoNotesOff}
            </button>
          </div>
        )}
      </div>
    </GlassSurface>
  );
}
