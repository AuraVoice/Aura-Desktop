import { useMemo, useState, type ComponentType } from "react";
import {
  CalendarCheck2,
  Clock3,
  FileText,
  Flame,
  MessageSquare,
  MousePointer2,
  Save,
  Sparkles,
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
import { PageError } from "../components/PageError";
import { RefreshIndicator } from "../components/RefreshIndicator";
import { useDashboardResource } from "../useDashboardResource";

type InsightRange = "7d" | "30d";

interface InsightSnapshot {
  history: HistorySessions;
  drafts: RawDraft[];
  saves: RawScreenSave[];
  meetings: MeetingDoc[];
}

interface DailyActivity {
  key: string;
  label: string;
  fullLabel: string;
  conversations: number;
  creations: number;
  total: number;
}

function startOfLocalDay(value: Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function daysAgo(days: number): Date {
  const date = startOfLocalDay(new Date());
  date.setDate(date.getDate() - days);
  return date;
}

function localDateKey(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-CA");
}

function activeStreak(dates: string[]): number {
  const active = new Set(dates.map(localDateKey).filter(Boolean));
  const cursor = startOfLocalDay(new Date());
  if (!active.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (active.has(localDateKey(cursor))) {
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

function formatDuration(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? "<1 min" : "0 min";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} hr`;
  return `${Math.round(seconds / 60)} min`;
}

function comparisonLabel(current: number, previous: number): string {
  if (current === 0 && previous === 0) return "No activity in either period";
  if (previous === 0) return current > 0 ? "New this period" : "No change";
  const percentage = Math.round(((current - previous) / previous) * 100);
  if (percentage === 0) return "Same as previous period";
  return `${Math.abs(percentage)}% ${percentage > 0 ? "more" : "less"} than previous`;
}

function MetricCard({
  Icon,
  label,
  value,
  detail,
  featured = false,
}: {
  Icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  label: string;
  value: string;
  detail: string;
  featured?: boolean;
}) {
  return (
    <article className={`db-insight-card${featured ? " is-featured" : ""}`}>
      <div className="db-insight-card-head">
        <span>{label}</span>
        <span className="db-insight-card-icon"><Icon size={18} aria-hidden /></span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export function InsightsPage() {
  const [range, setRange] = useState<InsightRange>("7d");
  const rangeDays = range === "7d" ? 7 : 30;
  const currentCutoff = useMemo(() => daysAgo(rangeDays - 1), [rangeDays]);
  const previousCutoff = useMemo(() => daysAgo(rangeDays * 2 - 1), [rangeDays]);
  const res = useDashboardResource<InsightSnapshot>(
    `insights:${range}`,
    async (signal) => {
      const [history, drafts, saves, meetings] = await Promise.all([
        getHistorySessions(previousCutoff.toISOString(), signal),
        getDrafts(signal),
        getScreenSaves(signal),
        getMeetings(signal),
      ]);
      return { history, drafts, saves, meetings };
    },
  );

  const metrics = useMemo(() => {
    if (!res.data) return null;
    const currentMs = currentCutoff.getTime();
    const previousMs = previousCutoff.getTime();
    const timestamp = (value: string) => new Date(value).getTime();
    const inCurrent = (value: string) => timestamp(value) >= currentMs;
    const inPrevious = (value: string) => {
      const time = timestamp(value);
      return time >= previousMs && time < currentMs;
    };

    const sessions = res.data.history.sessions.filter((item) => inCurrent(item.started_at));
    const previousSessions = res.data.history.sessions.filter((item) => inPrevious(item.started_at));
    const drafts = res.data.drafts.filter((item) => inCurrent(item.created_at));
    const saves = res.data.saves.filter((item) => inCurrent(item.created_at));
    const meetings = res.data.meetings.filter((item) => inCurrent(item.createdAt));
    const activeDates = [
      ...sessions.map((item) => item.started_at),
      ...drafts.map((item) => item.created_at),
      ...saves.map((item) => item.created_at),
      ...meetings.map((item) => item.createdAt),
    ];
    const streakDates = [
      ...res.data.history.sessions.map((item) => item.started_at),
      ...res.data.drafts.map((item) => item.created_at),
      ...res.data.saves.map((item) => item.created_at),
      ...res.data.meetings.map((item) => item.createdAt),
    ];
    const voiceSeconds = sessions.reduce(
      (sum, item) => sum + durationSeconds(item.total_duration),
      0,
    );
    const previousVoiceSeconds = previousSessions.reduce(
      (sum, item) => sum + durationSeconds(item.total_duration),
      0,
    );

    const daily = Array.from({ length: rangeDays }, (_, index): DailyActivity => {
      const date = new Date(currentCutoff);
      date.setDate(date.getDate() + index);
      const key = localDateKey(date);
      return {
        key,
        label: rangeDays === 7
          ? date.toLocaleDateString(undefined, { weekday: "short" })
          : String(date.getDate()),
        fullLabel: date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
        conversations: sessions.filter((item) => localDateKey(item.started_at) === key).length,
        creations:
          drafts.filter((item) => localDateKey(item.created_at) === key).length +
          saves.filter((item) => localDateKey(item.created_at) === key).length +
          meetings.filter((item) => localDateKey(item.createdAt) === key).length,
        total: 0,
      };
    }).map((day) => ({ ...day, total: day.conversations + day.creations }));

    const bestDay = daily.reduce<DailyActivity | null>(
      (best, day) => (!best || day.total > best.total ? day : best),
      null,
    );

    return {
      conversations: sessions.length,
      previousConversations: previousSessions.length,
      exchanges: sessions.reduce((sum, item) => sum + item.num_of_turns, 0),
      toolCalls: sessions.reduce((sum, item) => sum + item.num_of_tool_calls, 0),
      screenFrames: sessions.reduce((sum, item) => sum + item.screen_sight_frame_count, 0),
      voiceSeconds,
      previousVoiceSeconds,
      averageSeconds: sessions.length > 0 ? Math.round(voiceSeconds / sessions.length) : 0,
      drafts: drafts.length,
      saves: saves.length,
      meetings: meetings.length,
      streak: activeStreak(streakDates),
      activeDays: new Set(activeDates.map(localDateKey).filter(Boolean)).size,
      daily,
      bestDay,
    };
  }, [res.data, currentCutoff, previousCutoff, rangeDays]);

  const maxDaily = Math.max(1, ...(metrics?.daily.map((day) => day.total) ?? [1]));

  return (
    <div className="db-page db-page-wide db-insights-page">
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
          {Array.from({ length: 8 }, (_, index) => (
            <div className="db-insight-card db-insight-card-loading" key={index} />
          ))}
        </div>
      ) : (
        <>
          <section className="db-insight-hero">
            <div>
              <p className="db-insight-eyebrow">YOUR AURA ACTIVITY</p>
              <h2>
                {metrics.activeDays > 0
                  ? `${metrics.activeDays} active day${metrics.activeDays === 1 ? "" : "s"} in this period.`
                  : "Your activity will build here."}
              </h2>
              <p>
                Conversations, creations, saved context, and captured meetings across your
                Aura account.
              </p>
            </div>
            <div className="db-insight-streak">
              <Flame size={20} aria-hidden />
              <strong>{metrics.streak}</strong>
              <span>day streak</span>
            </div>
          </section>

          <section className="db-insight-grid" aria-label="Activity metrics">
            <MetricCard
              Icon={MessageSquare}
              label="Conversations"
              value={String(metrics.conversations)}
              detail={comparisonLabel(metrics.conversations, metrics.previousConversations)}
              featured
            />
            <MetricCard
              Icon={Clock3}
              label="Voice time"
              value={formatDuration(metrics.voiceSeconds)}
              detail={comparisonLabel(metrics.voiceSeconds, metrics.previousVoiceSeconds)}
              featured
            />
            <MetricCard
              Icon={Sparkles}
              label="Dialogue exchanges"
              value={String(metrics.exchanges)}
              detail="User and Aura turns"
            />
            <MetricCard
              Icon={CalendarCheck2}
              label="Average conversation"
              value={formatDuration(metrics.averageSeconds)}
              detail="Across this period"
            />
            <MetricCard
              Icon={FileText}
              label="Drafts created"
              value={String(metrics.drafts)}
              detail="Available draft history"
            />
            <MetricCard
              Icon={Save}
              label="Items saved"
              value={String(metrics.saves)}
              detail="Screenshots, notes, and context"
            />
            <MetricCard
              Icon={Video}
              label="Meetings captured"
              value={String(metrics.meetings)}
              detail="Available meeting history"
            />
            <MetricCard
              Icon={MousePointer2}
              label="Actions assisted"
              value={String(metrics.toolCalls + metrics.screenFrames)}
              detail={`${metrics.toolCalls} tool calls · ${metrics.screenFrames} screen frames`}
            />
          </section>

          <section className="db-panel db-insight-pattern">
            <div className="db-insight-pattern-head">
              <div>
                <h3>Activity pattern</h3>
                <p>Conversations and things Aura helped create or capture.</p>
              </div>
              <span>
                {metrics.bestDay && metrics.bestDay.total > 0
                  ? `Most active: ${metrics.bestDay.fullLabel}`
                  : "No active day yet"}
              </span>
            </div>
            <div className={`db-insight-chart db-insight-chart-${range}`}>
              {metrics.daily.map((day) => (
                <div className="db-insight-day" key={day.key}>
                  <div
                    className="db-insight-bar"
                    style={{ height: `${Math.max(day.total > 0 ? 10 : 2, (day.total / maxDaily) * 100)}%` }}
                    title={`${day.fullLabel}: ${day.total} activities`}
                  >
                    {day.creations > 0 && (
                      <span
                        className="db-insight-bar-creations"
                        style={{ height: `${(day.creations / day.total) * 100}%` }}
                      />
                    )}
                  </div>
                  <span>{day.label}</span>
                </div>
              ))}
            </div>
            <div className="db-insight-legend">
              <span><i className="is-conversation" /> Conversations</span>
              <span><i className="is-creation" /> Created and captured</span>
            </div>
          </section>

          <aside className="db-insight-note">
            <strong>About these numbers</strong>
            <span>
              A streak is consecutive local days with verified activity. Draft history may
              expire after seven days, and saved items and meetings use the available capped
              account history. Exact spoken-word counts will appear when session metrics
              expose them.
            </span>
          </aside>
        </>
      )}
    </div>
  );
}
