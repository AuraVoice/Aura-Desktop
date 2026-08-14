import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
} from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  AudioLines,
  Bot,
  Check,
  Clock3,
  FileText,
  Info,
  Keyboard,
  Monitor,
  MousePointer2,
  Save,
  Share2,
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
type InsightTab = "usage" | "voice";

interface InsightSnapshot {
  history: HistorySessions;
  drafts: RawDraft[];
  saves: RawScreenSave[];
  meetings: MeetingDoc[];
}

interface DictationUsageEntry {
  recordedAtMs: number;
  words: number;
}

interface HeatmapDay {
  key: string;
  fullLabel: string;
  count: number;
  level: number;
  future: boolean;
  currentStreak: boolean;
  details: {
    conversations: number;
    drafts: number;
    savedItems: number;
    meetings: number;
    toolCalls: number;
    screenFrames: number;
  };
}

interface UsageRow {
  Icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  label: string;
  value: number;
  displayValue: string;
}

interface HeatmapTooltip {
  day: HeatmapDay;
  left: number;
  top: number;
}

const HEATMAP_WEEKS = 16;

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

function longestStreak(dates: string[]): number {
  const keys = [...new Set(dates.map(localDateKey).filter(Boolean))].sort();
  let longest = 0;
  let current = 0;
  let previous: Date | null = null;
  keys.forEach((key) => {
    const date = new Date(`${key}T12:00:00`);
    const dayGap = previous
      ? Math.round((date.getTime() - previous.getTime()) / 86_400_000)
      : 0;
    current = previous && dayGap === 1 ? current + 1 : 1;
    longest = Math.max(longest, current);
    previous = date;
  });
  return longest;
}

function durationSeconds(value: string): number {
  const clock = value.trim().match(/^(?:(\d+):)?(\d+):(\d+)$/);
  if (clock) {
    return Number(clock[1] ?? 0) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
  }
  const human = value.trim().match(/^(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?$/i);
  if (!human || !human.slice(1).some(Boolean)) return 0;
  return (
    Number(human[1] ?? 0) * 3600 +
    Number(human[2] ?? 0) * 60 +
    Number(human[3] ?? 0)
  );
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return seconds > 0 ? "<1 min" : "0 min";
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)} hr`;
  return `${Math.round(seconds / 60)} min`;
}

function comparisonLabel(current: number, previous: number): string {
  if (current === 0 && previous === 0) return "No activity yet";
  if (previous === 0) return current > 0 ? "New this period" : "No change";
  const percentage = Math.round(((current - previous) / previous) * 100);
  if (percentage === 0) return "Same as last period";
  return `${Math.abs(percentage)}% ${percentage > 0 ? "more" : "less"}`;
}

function percentage(value: number, total: number): number {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function CountingNumber({ value }: { value: number }) {
  const [displayValue, setDisplayValue] = useState("0");

  useLayoutEffect(() => {
    let frame = 0;
    let startedAt: number | null = null;
    setDisplayValue("0");
    const animate = (now: number) => {
      startedAt ??= now;
      const progress = Math.min(1, (now - startedAt) / 2_000);
      setDisplayValue(Math.floor(value * progress).toLocaleString());
      if (progress < 1) {
        frame = window.requestAnimationFrame(animate);
      } else {
        setDisplayValue(value.toLocaleString());
      }
    };
    frame = window.requestAnimationFrame(animate);
    return () => window.cancelAnimationFrame(frame);
  }, [value]);

  return (
    <span className="db-insight-animated-number" aria-label={value.toLocaleString()}>
      <span aria-hidden>{displayValue}</span>
    </span>
  );
}

function SummaryCard({
  label,
  value,
  detail,
  animateValue = false,
  children,
  wide = false,
}: {
  label: string;
  value: string | number;
  detail?: string;
  animateValue?: boolean;
  children?: React.ReactNode;
  wide?: boolean;
}) {
  const tooltipId = useId();
  return (
    <article className={`db-insight-summary-card${wide ? " is-wide" : ""}`}>
      <strong className="db-insight-summary-value">
        {typeof value === "number"
          ? animateValue ? <CountingNumber value={value} /> : value.toLocaleString()
          : value}
      </strong>
      <div className="db-insight-summary-label">
        <span>{label}</span>
        {detail && (
          <span
            className="db-insight-info"
            tabIndex={0}
            aria-label={`${label}: ${detail}`}
            aria-describedby={tooltipId}
          >
            <Info size={14} aria-hidden />
            <span className="db-insight-info-tooltip" id={tooltipId} role="tooltip">
              {detail}
            </span>
          </span>
        )}
      </div>
      {children}
    </article>
  );
}

function Gauge({ value, label }: { value: number; label: string }) {
  const bounded = Math.max(0, Math.min(value, 100));
  const valuePathRef = useRef<SVGPathElement>(null);

  useLayoutEffect(() => {
    const path = valuePathRef.current;
    if (!path) return;
    const animation = path.animate(
      [
        { strokeDashoffset: "100" },
        { strokeDashoffset: String(100 - bounded) },
      ],
      {
        duration: 3_000,
        easing: "cubic-bezier(0.4, 0, 0.2, 1)",
        fill: "both",
      },
    );
    return () => animation.cancel();
  }, [bounded]);

  return (
    <div className="db-insight-gauge">
      <svg viewBox="0 0 160 88" role="img" aria-label={`${label}: ${bounded}%`}>
        <path className="db-insight-gauge-track" d="M 16 76 A 64 64 0 0 1 144 76" />
        <path
          ref={valuePathRef}
          className="db-insight-gauge-value"
          d="M 16 76 A 64 64 0 0 1 144 76"
          pathLength="100"
          style={{ strokeDashoffset: 100 - bounded }}
        />
      </svg>
      <span>{label}</span>
    </div>
  );
}

function UsageBars({ rows }: { rows: UsageRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  return (
    <div className="db-insight-usage-list">
      {rows.map(({ Icon, label, value, displayValue }, index) => {
        const share = percentage(value, total);
        return (
          <div className="db-insight-usage-row" key={label}>
            <Icon size={19} aria-hidden />
            <span
              className="db-insight-usage-tag"
              style={{ "--tag-tone": index } as CSSProperties}
            >
              {share}%
            </span>
            <div className="db-insight-usage-track" aria-hidden>
              <span
                style={{
                  "--bar-value": `${share}%`,
                  "--bar-delay": `${240 + (index * 90)}ms`,
                } as CSSProperties}
              />
            </div>
            <strong>{displayValue}</strong>
          </div>
        );
      })}
    </div>
  );
}

export function InsightsPage() {
  const [range, setRange] = useState<InsightRange>("7d");
  const [tab, setTab] = useState<InsightTab>("usage");
  const [shareState, setShareState] = useState<"idle" | "done" | "error">("idle");
  const [heatmapTooltip, setHeatmapTooltip] = useState<HeatmapTooltip | null>(null);
  const [dictationUsage, setDictationUsage] = useState<DictationUsageEntry[]>([]);
  const rangeDays = range === "7d" ? 7 : 30;
  const currentCutoff = useMemo(() => daysAgo(rangeDays - 1), [rangeDays]);
  const previousCutoff = useMemo(() => daysAgo(rangeDays * 2 - 1), [rangeDays]);
  const historyCutoff = useMemo(() => daysAgo(HEATMAP_WEEKS * 7), []);
  const res = useDashboardResource<InsightSnapshot>(
    "insights:polished",
    async (signal) => {
      const [history, drafts, saves, meetings] = await Promise.all([
        getHistorySessions(historyCutoff.toISOString(), signal),
        getDrafts(signal),
        getScreenSaves(signal),
        getMeetings(signal),
      ]);
      return { history, drafts, saves, meetings };
    },
  );

  useEffect(() => {
    let cancelled = false;
    void invoke<DictationUsageEntry[]>("dictation_usage_entries")
      .then((entries) => {
        if (!cancelled) setDictationUsage(entries);
      })
      .catch(() => {
        if (!cancelled) setDictationUsage([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    const allActivityDates = [
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

    const activityDetails = new Map<string, HeatmapDay["details"]>();
    const detailsFor = (key: string) => {
      const existing = activityDetails.get(key);
      if (existing) return existing;
      const created: HeatmapDay["details"] = {
        conversations: 0,
        drafts: 0,
        savedItems: 0,
        meetings: 0,
        toolCalls: 0,
        screenFrames: 0,
      };
      activityDetails.set(key, created);
      return created;
    };
    res.data.history.sessions.forEach((item) => {
      const details = detailsFor(localDateKey(item.started_at));
      details.conversations += 1;
      details.toolCalls += item.num_of_tool_calls;
      details.screenFrames += item.screen_sight_frame_count;
    });
    res.data.drafts.forEach((item) => {
      detailsFor(localDateKey(item.created_at)).drafts += 1;
    });
    res.data.saves.forEach((item) => {
      detailsFor(localDateKey(item.created_at)).savedItems += 1;
    });
    res.data.meetings.forEach((item) => {
      detailsFor(localDateKey(item.createdAt)).meetings += 1;
    });
    const activityCounts = new Map(
      [...activityDetails].map(([key, details]) => [
        key,
        details.conversations + details.drafts + details.savedItems + details.meetings,
      ]),
    );
    const streak = activeStreak(allActivityDates);
    const today = startOfLocalDay(new Date());
    const streakEnd = new Date(today);
    if (!activityCounts.has(localDateKey(streakEnd))) streakEnd.setDate(streakEnd.getDate() - 1);
    const streakStart = new Date(streakEnd);
    streakStart.setDate(streakStart.getDate() - Math.max(0, streak - 1));
    const heatmapStart = new Date(today);
    heatmapStart.setDate(heatmapStart.getDate() - heatmapStart.getDay() - ((HEATMAP_WEEKS - 1) * 7));
    const maxActivity = Math.max(1, ...activityCounts.values());
    const heatmap = Array.from({ length: HEATMAP_WEEKS * 7 }, (_, index): HeatmapDay => {
      const date = new Date(heatmapStart);
      date.setDate(date.getDate() + index);
      const key = localDateKey(date);
      const count = activityCounts.get(key) ?? 0;
      const details = activityDetails.get(key) ?? {
        conversations: 0,
        drafts: 0,
        savedItems: 0,
        meetings: 0,
        toolCalls: 0,
        screenFrames: 0,
      };
      return {
        key,
        fullLabel: date.toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        }),
        count,
        level: count === 0 ? 0 : Math.max(1, Math.ceil((count / maxActivity) * 4)),
        future: date.getTime() > today.getTime(),
        details,
        currentStreak:
          streak > 0 &&
          date.getTime() >= streakStart.getTime() &&
          date.getTime() <= streakEnd.getTime() &&
          count > 0,
      };
    });

    const activeDays = new Set(
      allActivityDates
        .filter(inCurrent)
        .map(localDateKey)
        .filter(Boolean),
    ).size;
    const actions = sessions.reduce(
      (sum, item) => sum + item.num_of_tool_calls + item.screen_sight_frame_count,
      0,
    );
    const wordsDictated = dictationUsage.reduce(
      (sum, entry) => sum + (entry.recordedAtMs >= currentMs ? entry.words : 0),
      0,
    );

    return {
      conversations: sessions.length,
      previousConversations: previousSessions.length,
      exchanges: sessions.reduce((sum, item) => sum + item.num_of_turns, 0),
      toolCalls: sessions.reduce((sum, item) => sum + item.num_of_tool_calls, 0),
      screenFrames: sessions.reduce((sum, item) => sum + item.screen_sight_frame_count, 0),
      actions,
      wordsDictated,
      voiceSeconds,
      previousVoiceSeconds,
      averageSeconds: sessions.length > 0 ? Math.round(voiceSeconds / sessions.length) : 0,
      drafts: drafts.length,
      saves: saves.length,
      meetings: meetings.length,
      streak,
      longestStreak: longestStreak(allActivityDates),
      activeDays,
      heatmap,
    };
  }, [res.data, currentCutoff, previousCutoff, rangeDays, dictationUsage]);

  const monthLabels = useMemo(() => {
    if (!metrics) return [];
    return [0, 5, 10, 15].map((week) => {
      const cell = metrics.heatmap[week * 7];
      return cell
        ? new Date(`${cell.key}T12:00:00`).toLocaleDateString(undefined, { month: "short" })
        : "";
    });
  }, [metrics]);

  async function shareInsights() {
    if (!metrics) return;
    const text = `Aura insights: ${metrics.conversations} conversations, ${formatDuration(
      metrics.voiceSeconds,
    )} of voice time, and a ${metrics.streak}-day streak.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "My Aura insights", text });
      } else {
        await navigator.clipboard.writeText(text);
      }
      setShareState("done");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareState("error");
    }
    window.setTimeout(() => setShareState("idle"), 2200);
  }

  function showHeatmapTooltip(target: HTMLElement, day: HeatmapDay) {
    const rect = target.getBoundingClientRect();
    setHeatmapTooltip({
      day,
      left: Math.min(Math.max(rect.left + (rect.width / 2), 132), window.innerWidth - 132),
      top: rect.top - 10,
    });
  }

  const tooltipRows = heatmapTooltip
    ? [
        ["Conversations", heatmapTooltip.day.details.conversations],
        ["Drafts created", heatmapTooltip.day.details.drafts],
        ["Items saved", heatmapTooltip.day.details.savedItems],
        ["Meetings captured", heatmapTooltip.day.details.meetings],
        ["Tool calls", heatmapTooltip.day.details.toolCalls],
        ["Screen frames", heatmapTooltip.day.details.screenFrames],
      ].filter(([, value]) => Number(value) > 0)
    : [];
  const tooltipRoot = typeof document === "undefined" ? null : document.querySelector(".db-app");

  const usageRows: UsageRow[] = metrics
    ? [
        {
          Icon: AudioLines,
          label: "conversations",
          value: metrics.conversations,
          displayValue: `${metrics.conversations} conversations`,
        },
        {
          Icon: FileText,
          label: "drafts",
          value: metrics.drafts,
          displayValue: `${metrics.drafts} drafts`,
        },
        {
          Icon: Save,
          label: "saved items",
          value: metrics.saves,
          displayValue: `${metrics.saves} saved items`,
        },
        {
          Icon: Video,
          label: "meetings",
          value: metrics.meetings,
          displayValue: `${metrics.meetings} meetings`,
        },
        {
          Icon: MousePointer2,
          label: "assisted actions",
          value: metrics.actions,
          displayValue: `${metrics.actions} assisted actions`,
        },
      ]
    : [];

  const voiceRows: UsageRow[] = metrics
    ? [
        {
          Icon: AudioLines,
          label: "conversations",
          value: metrics.conversations,
          displayValue: `${metrics.conversations} conversations`,
        },
        {
          Icon: Sparkles,
          label: "dialogue exchanges",
          value: metrics.exchanges,
          displayValue: `${metrics.exchanges} exchanges`,
        },
        {
          Icon: Bot,
          label: "tool calls",
          value: metrics.toolCalls,
          displayValue: `${metrics.toolCalls} tool calls`,
        },
        {
          Icon: Monitor,
          label: "screen context",
          value: metrics.screenFrames,
          displayValue: `${metrics.screenFrames} screen frames`,
        },
      ]
    : [];

  return (
    <div className="db-page db-page-full db-insights-page">
      <header className="db-insight-header">
        <div>
          <h2>Insights</h2>
          <div className="db-insight-tabs" role="tablist" aria-label="Insight type">
            {(["usage", "voice"] as const).map((item) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === item}
                className={tab === item ? "is-active" : ""}
                key={item}
                onClick={() => setTab(item)}
              >
                Your {item}
              </button>
            ))}
          </div>
        </div>
        <div className="db-insight-header-actions">
          <div className="db-insight-range" aria-label="Insights range">
            {(["7d", "30d"] as const).map((item) => (
              <button
                type="button"
                key={item}
                className={range === item ? "is-active" : ""}
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
          <button
            type="button"
            className={`db-insight-share${shareState === "done" ? " is-done" : ""}`}
            aria-label="Share insights"
            title={shareState === "done" ? "Copied" : "Share insights"}
            disabled={!metrics}
            onClick={() => void shareInsights()}
          >
            {shareState === "done" ? <Check size={21} aria-hidden /> : <Share2 size={21} aria-hidden />}
            <span>Share</span>
          </button>
          <span className="db-sr-only" aria-live="polite">
            {shareState === "done"
              ? "Insights ready to share"
              : shareState === "error"
                ? "Insights could not be shared"
                : ""}
          </span>
        </div>
      </header>

      {res.error ? (
        <PageError authExpired={res.authExpired} onRetry={res.reload} />
      ) : res.loading || !metrics ? (
        <div className="db-insight-loading-layout" aria-label="Loading insights">
          <div className="db-insight-summary-grid is-usage">
            <div className="db-insight-summary-card db-insight-skeleton" />
            <div className="db-insight-summary-card db-insight-skeleton" />
            <div className="db-insight-summary-card db-insight-skeleton" />
            <div className="db-insight-summary-card db-insight-skeleton" />
          </div>
          <div className="db-insight-lower-grid">
            <div className="db-insight-panel db-insight-skeleton" />
            <div className="db-insight-panel db-insight-skeleton" />
          </div>
        </div>
      ) : (
        <>
          <section
            className={`db-insight-summary-grid is-${tab}`}
            aria-label={`${tab} summary`}
            key={`summary-${tab}-${range}`}
          >
            {tab === "usage" ? (
              <>
                <SummaryCard
                  label="Conversations"
                  value={metrics.conversations}
                  detail="Completed Aura conversations in this period"
                  animateValue
                >
                  <Gauge
                    value={percentage(metrics.activeDays, rangeDays)}
                    label={`${metrics.activeDays} active day${metrics.activeDays === 1 ? "" : "s"}`}
                  />
                </SummaryCard>
                <SummaryCard
                  label="Things created"
                  value={metrics.drafts + metrics.saves + metrics.meetings}
                  detail="Drafts, saved context, and meetings"
                  animateValue
                >
                  <div className="db-insight-breakdown">
                    <span><strong>{metrics.drafts}</strong> drafts created</span>
                    <span><strong>{metrics.saves}</strong> items saved</span>
                    <span><strong>{metrics.meetings}</strong> meetings captured</span>
                  </div>
                </SummaryCard>
                <SummaryCard
                  label="Actions assisted"
                  value={metrics.actions}
                  detail="Tool calls and screen context used by Aura"
                  animateValue
                >
                  <div className="db-insight-device is-compact">
                    <span><Monitor size={19} aria-hidden /> Desktop</span>
                    <span className="db-insight-comparison">
                      {comparisonLabel(
                        metrics.conversations,
                        metrics.previousConversations,
                      )}
                    </span>
                  </div>
                </SummaryCard>
                <SummaryCard
                  label="Words dictated"
                  value={metrics.wordsDictated}
                  detail="Words successfully inserted with Aura Dictation in this period. The count stays local to this device."
                  animateValue
                >
                  <div className="db-insight-device is-compact">
                    <span><Keyboard size={19} aria-hidden /> Dictation</span>
                    <span className="db-insight-comparison">This device</span>
                  </div>
                </SummaryCard>
              </>
            ) : (
              <>
                <SummaryCard
                  label="Voice time"
                  value={formatDuration(metrics.voiceSeconds)}
                  detail="Total voice conversation time"
                >
                  <Gauge
                    value={Math.min(100, percentage(metrics.voiceSeconds, 60 * 60))}
                    label={comparisonLabel(metrics.voiceSeconds, metrics.previousVoiceSeconds)}
                  />
                </SummaryCard>
                <SummaryCard
                  label="Average conversation"
                  value={formatDuration(metrics.averageSeconds)}
                  detail="Average voice time per conversation"
                >
                  <div className="db-insight-breakdown">
                    <span><strong>{metrics.conversations}</strong> conversations</span>
                    <span><strong>{metrics.exchanges}</strong> dialogue exchanges</span>
                  </div>
                </SummaryCard>
                <SummaryCard
                  label="Dialogue exchanges"
                  value={metrics.exchanges}
                  detail="User and Aura turns in this period"
                  wide
                >
                  <div className="db-insight-device">
                    <span><Clock3 size={19} aria-hidden /> Voice activity</span>
                    <strong>{formatDuration(metrics.voiceSeconds)}</strong>
                    <span className="db-insight-comparison">
                      {comparisonLabel(metrics.voiceSeconds, metrics.previousVoiceSeconds)}
                    </span>
                  </div>
                </SummaryCard>
              </>
            )}
          </section>

          <section className="db-insight-lower-grid" key={`details-${tab}-${range}`}>
            <article className="db-insight-panel db-insight-usage">
              <div className="db-insight-panel-head">
                <h3>{tab === "usage" ? "Desktop usage" : "Voice activity"}</h3>
                <span>
                  {tab === "usage"
                    ? `${usageRows.filter((row) => row.value > 0).length} active categories`
                    : `${metrics.conversations} conversations`}
                </span>
              </div>
              <UsageBars rows={tab === "usage" ? usageRows : voiceRows} />
            </article>

            <article className="db-insight-panel db-insight-streak-panel">
              <div className="db-insight-panel-head">
                <h3>
                  {metrics.streak} day streak
                </h3>
                <span>Longest available streak | {metrics.longestStreak} days</span>
              </div>
              <div className="db-insight-heatmap-months" aria-hidden>
                {monthLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}
              </div>
              <div className="db-insight-heatmap-wrap">
                <div className="db-insight-heatmap-days" aria-hidden>
                  {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                    <span key={day}>{day}</span>
                  ))}
                </div>
                <div className="db-insight-heatmap" aria-label="Activity calendar">
                  {metrics.heatmap.map((day, index) => (
                    <span
                      key={day.key}
                      className={`db-insight-heatmap-cell is-level-${day.level}${
                        day.future ? " is-future" : ""
                      }${day.currentStreak ? " is-current-streak" : ""}`}
                      style={{ "--heatmap-delay": `${Math.min(index * 6, 520)}ms` } as CSSProperties}
                      tabIndex={!day.future && day.count > 0 ? 0 : -1}
                      aria-label={`${day.fullLabel}: ${day.count} activities`}
                      onMouseEnter={(event) => showHeatmapTooltip(event.currentTarget, day)}
                      onMouseLeave={() => setHeatmapTooltip(null)}
                      onFocus={(event) => showHeatmapTooltip(event.currentTarget, day)}
                      onBlur={() => setHeatmapTooltip(null)}
                    />
                  ))}
                </div>
              </div>
              <div className="db-insight-heatmap-legend">
                <span>More</span>
                {[4, 3, 2, 1, 0].map((level) => (
                  <i className={`is-level-${level}`} key={level} />
                ))}
                <span>Less</span>
                <span className="db-insight-current-key"><i /> Current streak</span>
              </div>
            </article>
          </section>

          <aside className="db-insight-note">
            <Info size={15} aria-hidden />
            <span>
              Insights use verified activity available across your Aura account. Some
              saved, draft, and meeting history may be capped.
            </span>
          </aside>
          {heatmapTooltip && tooltipRoot && createPortal(
            <div
              className="db-insight-heatmap-tooltip"
              role="tooltip"
              style={{
                left: heatmapTooltip.left,
                top: heatmapTooltip.top,
              }}
            >
              <strong>{heatmapTooltip.day.fullLabel}</strong>
              <span className="db-insight-heatmap-tooltip-total">
                {heatmapTooltip.day.count === 0
                  ? "No activity recorded"
                  : `${heatmapTooltip.day.count} ${
                      heatmapTooltip.day.count === 1 ? "activity" : "activities"
                    }`}
              </span>
              {tooltipRows.length > 0 && (
                <div>
                  {tooltipRows.map(([label, value]) => (
                    <span key={String(label)}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                    </span>
                  ))}
                </div>
              )}
            </div>,
            tooltipRoot,
          )}
        </>
      )}
    </div>
  );
}
