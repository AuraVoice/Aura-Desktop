import {
  getDrafts,
  getHistorySessions,
  getHomeStats,
  getMeetings,
  getScreenSaves,
  type HomeStats,
  type RawDraft,
  type RawScreenSave,
} from "../../lib/dashboardApi";
import { fetchUpcomingMeetings, type UpcomingMeetings } from "../../lib/calendar";
import type { MeetingDoc } from "../../lib/meetings";
import { fetchPendingActions, type PendingAction } from "../../lib/pendingActions";
import { useGeneralSettings } from "../../state/useGeneralSettings";
import { HomeHeader } from "../home/HomeHeader";
import { InsightsCards } from "../home/InsightsCards";
import { JumpBackIn } from "../home/JumpBackIn";
import { NeedsYou } from "../home/NeedsYou";
import { QuickActions } from "../home/QuickActions";
import { UpNextList } from "../home/UpNextList";
import "../home/home.css";
import { useAsyncData } from "../useAsyncData";
import { useDashboardResource } from "../useDashboardResource";

function activeStreak(values: string[]): number {
  const days = new Set(
    values
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()))
      .map((date) => date.toLocaleDateString("en-CA")),
  );
  const cursor = new Date();
  if (!days.has(cursor.toLocaleDateString("en-CA"))) cursor.setDate(cursor.getDate() - 1);
  let result = 0;
  while (days.has(cursor.toLocaleDateString("en-CA"))) {
    result += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return result;
}

/** Saved images are short-lived signed URLs; same cache rule as SavedPanel. */
function stripImageUrls(saves: RawScreenSave[]): RawScreenSave[] {
  return saves.map((s) => ({ ...s, image_url: null }));
}

/** Home answers three questions in this order: what needs me, how do I do X
 * fast, and where was I. Every source here is a cached dashboard resource
 * shared with the page it links to, so it paints from disk. */
export function HomePage() {
  const generalSettings = useGeneralSettings();
  const stats = useDashboardResource<HomeStats>(
    "home:stats",
    (signal) => getHomeStats(signal),
    { freshnessMs: 10 * 60_000 },
  );
  const calendar = useAsyncData<UpcomingMeetings | null>(
    () => fetchUpcomingMeetings(10_000),
    "home calendar",
  );
  const history = useDashboardResource(
    "home:streak:31d",
    (signal) => getHistorySessions(
      new Date(Date.now() - 31 * 86_400_000).toISOString(),
      signal,
    ),
    { freshnessMs: 30 * 60_000 },
  );
  const meetings = useDashboardResource<MeetingDoc[]>(
    "meetings",
    (signal) => getMeetings(signal),
  );
  const drafts = useDashboardResource<RawDraft[]>("drafts", (signal) => getDrafts(signal));
  const saves = useDashboardResource<RawScreenSave[]>(
    "screen-saves",
    (signal) => getScreenSaves(signal),
    { toCache: stripImageUrls },
  );
  const approvals = useDashboardResource<PendingAction[]>(
    "home:pending-actions",
    () => fetchPendingActions(),
    { freshnessMs: 60_000 },
  );
  const streak = activeStreak(history.data?.sessions.map((session) => session.started_at) ?? []);

  return (
    <div className="db-home">
      <HomeHeader />
      <QuickActions />
      <div className="db-home-split">
        <NeedsYou approvals={approvals} meetings={meetings} />
        <UpNextList
          calendar={calendar.data ?? null}
          loading={calendar.loading}
          showCalendar={generalSettings.calendarInBriefing}
        />
      </div>
      <div className="db-home-split">
        <JumpBackIn history={history} drafts={drafts} saves={saves} meetings={meetings} />
        <InsightsCards stats={stats.data} streak={streak} />
      </div>
    </div>
  );
}
