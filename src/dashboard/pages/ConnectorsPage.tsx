import { fetchUpcomingMeetings, type UpcomingMeetings } from "../../lib/calendar";
import { DataView } from "../DataView";
import { useAsyncData } from "../useAsyncData";
import { useNavigate } from "react-router-dom";
import { CalendarDays, Mail, MessagesSquare, Notebook, Video } from "lucide-react";

interface ConnectorState {
  calendar: UpcomingMeetings | null;
}

export function ConnectorsPage() {
  const navigate = useNavigate();
  const state = useAsyncData<ConnectorState>(
    async () => ({ calendar: await fetchUpcomingMeetings(10_000) }),
    "calendar connection",
  );

  return (
    <div className="db-page db-page-wide">
      <DataView
        state={state}
        isEmpty={({ calendar }) => calendar === null || !calendar.connected}
        emptyLabel="Google Calendar is not connected or unavailable. Connect it from the Aura mobile app."
      >
        {({ calendar }) => (
          <div className="db-connector-grid">
            <article className="db-panel db-connector-card db-connector-card-live">
              <div className="db-connector-head">
                <span className="db-connector-icon"><CalendarDays size={22} /></span>
                <span className="db-connector-status">Connected</span>
              </div>
              <h2>Google Calendar</h2>
              <p className="db-muted">
                {calendar!.events.length > 0
                  ? `${calendar!.events.length} upcoming calendar event${calendar!.events.length === 1 ? "" : "s"} found today.`
                  : "Connected, with no more events today."}
              </p>
              <div className="db-connector-actions">
                <button type="button" className="db-primary-btn" onClick={() => navigate("/home")}>
                  View today
                </button>
                <button type="button" className="db-secondary-btn" onClick={() => navigate("/general")}>
                  Display settings
                </button>
              </div>
            </article>
            <FutureConnector Icon={Mail} name="Gmail" copy="Draft and review email with Aura." />
            <FutureConnector Icon={CalendarDays} name="Outlook Calendar" copy="Bring Microsoft calendar context into Today." />
            <FutureConnector Icon={Video} name="Microsoft Teams" copy="Connect meeting context and follow-ups." />
            <FutureConnector Icon={MessagesSquare} name="Slack" copy="Turn conversations into clear updates and replies." />
            <FutureConnector Icon={Notebook} name="Notion" copy="Save useful Aura output into your workspace." />
          </div>
        )}
      </DataView>
    </div>
  );
}

function FutureConnector({
  Icon,
  name,
  copy,
}: {
  Icon: typeof CalendarDays;
  name: string;
  copy: string;
}) {
  return (
    <article className="db-panel db-connector-card db-connector-card-future">
      <div className="db-connector-head">
        <span className="db-connector-icon"><Icon size={22} /></span>
        <span className="db-connector-status db-connector-status-future">Coming soon</span>
      </div>
      <h2>{name}</h2>
      <p className="db-muted">{copy}</p>
    </article>
  );
}
