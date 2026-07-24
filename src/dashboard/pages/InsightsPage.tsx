import { useMemo, useState } from "react";
import {
  Clock3,
  FileText,
  Flame,
  MessageSquare,
  Mic2,
  Save,
  Video,
} from "lucide-react";
import {
  getDrafts,
  getHistorySessions,
  getMeetings,
  getScreenSaves,
  type HistorySessions,
  type RawDraft,
  type RawScreenSave,
} from "../../lib/dashboardApi";
import type { MeetingDoc } from "../../lib/meetings";
import { useDashboardResource } from "../useDashboardResource";
import { PageError } from "../components/PageError";
import { RefreshIndicator } from "../components/RefreshIndicator";

type InsightRange = "7d" | "30d";

interface InsightSnapshot {
  history: HistorySessions;
  drafts: RawDraft[];
  saves: RawScreenSave[];
  meetings: MeetingDoc[];
}

function cutoffFor(range: InsightRange): Date {
  const date = new Date();
  date.setDate(date.getDate() - (range === "7d" ? 7 : 30));
  return date;
}

function activeStreak(dates: string[]): number {
  const active = new Set(
    dates
      .map((value) => new Date(value))
      .filter((date) => !Number.isNaN(date.getTime()))
      .map((date) => date.toLocaleDateString("en-CA")),
  );
  let cursor = new Date();
  if (!active.has(cursor.toLocaleDateString("en-CA"))) {
    cursor.setDate(cursor.getDate() - 1);
  }
  let streak = 0;
  while (active.has(cursor.toLocaleDateString("en-CA"))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

function durationSeconds(value: string): number {
  const match = value.match(/(?:(\d+):)?(\d+):(\d+)/);
  if (!match) return 0;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function InsightsPage() {
  const [range, setRange] = useState<InsightRange>("7d");
  const cutoff = cutoffFor(range);
  const res = useDashboardResource<InsightSnapshot>(
    `insights:${range}`,
    async (signal) => {
      const [history, drafts, saves, meetings] = await Promise.all([
        getHistorySessions(cutoff.toISOString(), signal),
        getDrafts(signal),
        getScreenSaves(signal),
        getMeetings(signal),
      ]);
      return { history, drafts, saves, meetings };
    },
  );

  const metrics = useMemo(() => {
    if (!res.data) return null;
    const afterCutoff = (value: string) => new Date(value) >= cutoff;
    const sessions = res.data.history.sessions.filter((item) => afterCutoff(item.started_at));
    const drafts = res.data.drafts.filter((item) => afterCutoff(item.created_at));
    const saves = res.data.saves.filter((item) => afterCutoff(item.created_at));
    const meetings = res.data.meetings.filter((item) => afterCutoff(item.createdAt));
    const activeDates = [
      ...sessions.map((item) => item.started_at),
      ...drafts.map((item) => item.created_at),
      ...saves.map((item) => item.created_at),
      ...meetings.map((item) => item.createdAt),
    ];
    return {
      conversations: sessions.length,
      turns: sessions.reduce((sum, item) => sum + item.num_of_turns, 0),
      seconds: sessions.reduce((sum, item) => sum + durationSeconds(item.total_duration), 0),
      drafts: drafts.length,
      saves: saves.length,
      meetings: meetings.length,
      streak: activeStreak(activeDates),
    };
  }, [res.data, range]);

  const cards = metrics
    ? [
        { label: "Active streak", value: `${metrics.streak} days`, Icon: Flame },
        { label: "Conversations", value: String(metrics.conversations), Icon: MessageSquare },
        { label: "Conversation turns", value: String(metrics.turns), Icon: Mic2 },
        {
          label: "Voice time",
          value: metrics.seconds >= 3600
            ? `${(metrics.seconds / 3600).toFixed(1)} hr`
            : `${Math.round(metrics.seconds / 60)} min`,
          Icon: Clock3,
        },
        { label: "Drafts created", value: String(metrics.drafts), Icon: FileText },
        { label: "Items saved", value: String(metrics.saves), Icon: Save },
        { label: "Meetings captured", value: String(metrics.meetings), Icon: Video },
      ]
    : [];

  return (
    <div className="db-page db-page-wide">
      <div className="db-page-toolbar">
        <div className="db-range-chips" aria-label="Insights range">
          {(["7d", "30d"] as const).map((item) => (
            <button
              type="button"
              key={item}
              className={`db-range-chip${range === item ? " db-range-chip-active" : ""}`}
              onClick={() => setRange(item)}
            >
              {item === "7d" ? "7 days" : "30 days"}
            </button>
          ))}
        </div>
        <RefreshIndicator
          refreshing={res.refreshing}
          stale={res.stale}
          cachedAt={res.cachedAt}
          onRetry={res.reload}
        />
      </div>

      {res.error ? (
        <PageError authExpired={res.authExpired} onRetry={res.reload} />
      ) : res.loading || !metrics ? (
        <div className="db-insight-grid" aria-label="Loading insights">
          {Array.from({ length: 7 }, (_, index) => (
            <div className="db-card db-insight-card db-insight-card-loading" key={index} />
          ))}
        </div>
      ) : (
        <>
          <div className="db-insight-intro">
            <p className="db-insight-eyebrow">YOUR AURA ACTIVITY</p>
            <h2>{metrics.conversations > 0 ? "A useful week, at a glance." : "Your activity will build here."}</h2>
            <p>
              These totals cover Aura conversations, drafts, saved items, and meetings across
              your account. Word counts will appear after session-level metrics are available.
            </p>
          </div>
          <div className="db-insight-grid">
            {cards.map(({ label, value, Icon }) => (
              <div className="db-card db-insight-card" key={label}>
                <div className="db-card-head">
                  <span className="db-card-label">{label}</span>
                  <span className="db-card-icon"><Icon size={18} aria-hidden /></span>
                </div>
                <div className="db-card-value">{value}</div>
              </div>
            ))}
          </div>
          <p className="db-insight-note">
            Active streak means consecutive local days with a conversation, draft, saved item,
            or captured meeting. It is an activity reminder, not a productivity score.
          </p>
        </>
      )}
    </div>
  );
}
