import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { UpcomingMeeting, UpcomingMeetings } from "../../lib/calendar";
import { getMeetingBrief, type MeetingBrief } from "../../lib/dashboardApi";
import { logError } from "../../lib/log";
import { timeOfDay } from "../format";
import { meetingPath } from "../pages/MeetingsPage";
import { useDashboardScopeUid } from "../useDashboardResource";

const MAX_EVENTS = 4;
const JOIN_LEAD_MS = 10 * 60_000;

function durationLabel(event: UpcomingMeeting): string {
  const minutes = Math.round(
    (new Date(event.endTime).getTime() - new Date(event.startTime).getTime()) / 60_000,
  );
  if (!Number.isFinite(minutes) || minutes <= 0) return "";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

function countdownLabel(event: UpcomingMeeting, now: number): string {
  const start = new Date(event.startTime).getTime();
  const end = new Date(event.endTime).getTime();
  if (start <= now && now < end) return "Happening now";
  const minutes = Math.round((start - now) / 60_000);
  if (minutes < 60) return `Starts in ${Math.max(minutes, 1)} min`;
  const hours = Math.round(minutes / 60);
  return `Starts in ${hours} h`;
}

/** Where the event is, in words: a room, the call app, or nothing. A raw URL
 * as the location reads as noise, so a link shows as "Online meeting". */
function placeLabel(event: UpcomingMeeting): string {
  const location = event.location?.trim() ?? "";
  if (location && !/^https?:\/\//i.test(location)) return location;
  const link = event.meetingLink ?? location;
  if (/meet\.google\./i.test(link)) return "Google Meet";
  if (/zoom\.us/i.test(link)) return "Zoom";
  if (/teams\.microsoft\./i.test(link)) return "Microsoft Teams";
  return link ? "Online meeting" : "";
}

/** One quiet line under an event when Aura recorded something related: the
 *  last meeting of its series, else the latest meeting with the same people. */
function briefLine(brief: MeetingBrief | undefined): { text: string; meetingId: string } | null {
  if (!brief) return null;
  if (brief.last) {
    const date = brief.last.date
      ? new Date(brief.last.date).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";
    const open = brief.last.actionItems.length;
    const detail = open
      ? `${open} action item${open === 1 ? "" : "s"} from last time`
      : brief.last.summary;
    return { text: `Last time${date ? `, ${date}` : ""}: ${detail}`, meetingId: brief.last.meetingId };
  }
  const [latest] = brief.related;
  if (!latest) return null;
  const others = brief.related.length - 1;
  return {
    text: `You met with them in ${latest.title || "a recorded meeting"}${others > 0 ? ` and ${others} more` : ""}`,
    meetingId: latest.meetingId,
  };
}

/** Today's agenda, drawn like a calendar: a date tile, then each event with
 * its start and end, length, place and a countdown. Join shows only when a
 * call is about to start or already running. */
export function UpNextList({
  calendar,
  loading,
  showCalendar,
}: {
  calendar: UpcomingMeetings | null;
  loading: boolean;
  showCalendar: boolean;
}) {
  const navigate = useNavigate();
  const now = Date.now();
  const today = new Date(now);
  const upcoming = (calendar?.events ?? []).filter((event) => new Date(event.endTime).getTime() > now);
  const events = upcoming.slice(0, MAX_EVENTS);
  const hidden = upcoming.length - events.length;

  // One brief per shown event, fetched once per set of events and cached
  // across visits (getMeetingBrief). Failures and empty briefs show nothing.
  const uid = useDashboardScopeUid();
  const [briefs, setBriefs] = useState<Record<string, MeetingBrief>>({});
  const eventKey = events.map((event) => event.id).join("|");
  useEffect(() => {
    if (!eventKey) return;
    let cancelled = false;
    void Promise.all(
      eventKey.split("|").map(async (id) => [id, await getMeetingBrief(uid, id)] as const),
    ).then((pairs) => {
      if (cancelled) return;
      setBriefs(Object.fromEntries(pairs.filter((pair): pair is readonly [string, MeetingBrief] => pair[1] !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [uid, eventKey]);

  return (
    <section className="db-home-panel" aria-labelledby="db-home-upnext-title">
      <div className="db-home-panel-head">
        <h3 id="db-home-upnext-title">Up next</h3>
        <button type="button" className="db-link" onClick={() => navigate("/connectors")}>
          Calendar
        </button>
      </div>
      {!showCalendar ? (
        <div className="db-home-empty">
          <strong>Calendar is hidden</strong>
          <span>Turn it back on in Settings to see your next meeting here.</span>
          <button type="button" className="db-home-pill" onClick={() => navigate("/general")}>
            Open settings
          </button>
        </div>
      ) : loading && events.length === 0 ? (
        <div className="db-home-skeleton" aria-hidden>
          <span />
          <span />
        </div>
      ) : (
        <>
          <div className="db-home-cal-day">
            <span className="db-home-cal-date" aria-hidden>
              <span className="db-home-cal-month">
                {today.toLocaleDateString(undefined, { month: "short" })}
              </span>
              <span className="db-home-cal-num">{today.getDate()}</span>
            </span>
            <span className="db-home-cal-day-text">
              <span className="db-home-cal-weekday">
                {today.toLocaleDateString(undefined, { weekday: "long" })}
              </span>
              <span className="db-home-cal-summary">
                {!calendar?.connected
                  ? "Calendar not connected"
                  : upcoming.length === 0
                    ? "Nothing else today"
                    : `${upcoming.length} event${upcoming.length === 1 ? "" : "s"} left today`}
              </span>
            </span>
          </div>

          {events.length === 0 ? (
            <div className="db-home-empty">
              <span>
                {calendar?.connected
                  ? "Your evening is clear."
                  : "Connect Google Calendar to see your next meeting and join it in one click."}
              </span>
              {!calendar?.connected && (
                <button type="button" className="db-home-pill is-primary" onClick={() => navigate("/connectors")}>
                  Connect calendar
                </button>
              )}
            </div>
          ) : (
            <ol className="db-home-cal-list">
              {events.map((event) => {
                const start = new Date(event.startTime).getTime();
                const end = new Date(event.endTime).getTime();
                const live = start <= now && now < end;
                const soon = live || start - now <= JOIN_LEAD_MS;
                const link = event.meetingLink || event.htmlLink;
                const details = [placeLabel(event), durationLabel(event)].filter(Boolean).join(" · ");
                const brief = briefLine(briefs[event.id]);
                return (
                  <li className={`db-home-cal-event${soon ? " is-soon" : ""}`} key={event.id}>
                    <span className="db-home-cal-time">
                      <span>{timeOfDay(event.startTime)}</span>
                      <span className="db-home-cal-end">{timeOfDay(event.endTime)}</span>
                    </span>
                    <span className="db-home-cal-bar" aria-hidden />
                    <span className="db-home-cal-body">
                      <span className="db-home-cal-title">{event.title || "Untitled event"}</span>
                      {details && <span className="db-home-cal-detail">{details}</span>}
                      <span className="db-home-cal-countdown">{countdownLabel(event, now)}</span>
                      {brief && (
                        <button
                          type="button"
                          className="db-home-cal-brief"
                          onClick={() => navigate(meetingPath(brief.meetingId))}
                        >
                          {brief.text}
                        </button>
                      )}
                    </span>
                    {soon && link && (
                      <button
                        type="button"
                        className="db-home-pill is-primary"
                        onClick={() =>
                          void openUrl(link).catch((err) => logError("HomePage: open upcoming event", err))
                        }
                      >
                        {event.meetingLink ? "Join" : "Open"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {hidden > 0 && <p className="db-home-cal-more">+{hidden} more later today</p>}
        </>
      )}
    </section>
  );
}
