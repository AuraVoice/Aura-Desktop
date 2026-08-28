import { authFetchWithTimeout, AuthRequiredError, TimeoutError } from "./api";
import { logError } from "./log";

/** One upcoming calendar event, mirroring the backend's query_events() shape
 * (see google_calendar_connector.py) as re-exposed by GET /calendar/upcoming. */
export interface UpcomingMeeting {
  id: string;
  title: string;
  /** UTC ISO 8601. The one authority for the local countdown (DST/skew safe),
   * unlike a server-computed "minutes until" that would be stale on arrival. */
  startTime: string;
  endTime: string;
  /** Pre-formatted in the user's calendar timezone, e.g. "Thu, Jul 9, 10:00 AM PDT". */
  startLocal: string;
  /** Google Meet / conferencing link, or null for an in-person event. */
  meetingLink: string | null;
  /** The event in Google Calendar, used when there's no join link. */
  htmlLink: string | null;
  location: string | null;
}

export interface UpcomingMeetings {
  /** false when no Google Calendar integration exists for this account; drives
   * the "Connect in the Aura app" empty state rather than an error. */
  connected: boolean;
  events: UpcomingMeeting[];
}

// The endpoint returns the rest of the user's local day (from now to local
// midnight), so the agenda card can show "Today" in full; the client derives
// the ticker window (~60 min) and auto-summon lead (~10 min) locally from each
// event's UTC start. limit caps a pathologically busy day.
const UPCOMING_LIMIT = 20;

function parseMeeting(raw: unknown): UpcomingMeeting | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const title = typeof row.title === "string" ? row.title : "";
  const startTime = typeof row.start_time === "string" ? row.start_time : "";
  // An event with no start time can't drive a countdown - drop it.
  if (!id || !startTime) return null;
  return {
    id,
    title: title || "Untitled event",
    startTime,
    endTime: typeof row.end_time === "string" ? row.end_time : "",
    startLocal: typeof row.start_local === "string" ? row.start_local : "",
    meetingLink: typeof row.meeting_link === "string" && row.meeting_link ? row.meeting_link : null,
    htmlLink: typeof row.html_link === "string" && row.html_link ? row.html_link : null,
    location: typeof row.location === "string" && row.location ? row.location : null,
  };
}

/**
 * Fetches the user's upcoming meetings (next ~hour). Returns null for every
 * non-usable outcome - not connected is NOT null (it's { connected: false }),
 * but a timeout, network error, non-ok status, or expired session all return
 * null. Like the catch-up card, this is an ambient surface that must never
 * raise an error to the user, and never routes to sign-in on auth failure.
 */
export async function fetchUpcomingMeetings(timeoutMs: number): Promise<UpcomingMeetings | null> {
  try {
    const response = await authFetchWithTimeout(
      `/calendar/upcoming?limit=${UPCOMING_LIMIT}`,
      undefined,
      timeoutMs,
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { connected?: unknown; events?: unknown };
    const connected = data.connected === true;
    const events = Array.isArray(data.events)
      ? data.events.map(parseMeeting).filter((e): e is UpcomingMeeting => e !== null)
      : [];
    return { connected, events };
  } catch (err) {
    if (!(err instanceof AuthRequiredError) && !(err instanceof TimeoutError)) {
      logError("fetchUpcomingMeetings", err);
    }
    return null;
  }
}
