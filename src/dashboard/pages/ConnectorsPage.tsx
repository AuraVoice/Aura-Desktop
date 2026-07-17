import { fetchUpcomingMeetings, type UpcomingMeetings } from "../../lib/calendar";
import { DataView } from "../DataView";
import { useAsyncData } from "../useAsyncData";

interface ConnectorState {
  calendar: UpcomingMeetings | null;
}

export function ConnectorsPage() {
  const state = useAsyncData<ConnectorState>(
    async () => ({ calendar: await fetchUpcomingMeetings(10_000) }),
    "calendar connection",
  );

  return (
    <div className="db-page">
      <DataView
        state={state}
        isEmpty={({ calendar }) => calendar === null || !calendar.connected}
        emptyLabel="Google Calendar is not connected or unavailable. Connect it from the Aura mobile app."
      >
        {({ calendar }) => (
          <div className="db-panel db-details">
            <div className="db-details-row">
              <span className="db-details-label">Google Calendar</span>
              <span className="db-details-value">Connected</span>
            </div>
            <p className="db-muted db-details-note">
              {calendar!.events.length > 0
                ? `${calendar!.events.length} upcoming calendar event${calendar!.events.length === 1 ? "" : "s"} found.`
                : "No upcoming calendar events today."}
            </p>
          </div>
        )}
      </DataView>
    </div>
  );
}
