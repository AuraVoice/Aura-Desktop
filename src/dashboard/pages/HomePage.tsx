import {
  BarChart3,
  CalendarClock,
  Clock,
  FileText,
  ListChecks,
  Sparkles,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { START_VOICE_REQUESTED } from "../../lib/ipcEvents";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "react-router-dom";
import {
  getHistorySessions,
  getHomeStats,
  getMeetings,
  getRecentActivity,
  type ActivityItem,
  type HomeStats,
} from "../../lib/dashboardApi";
import { fetchUpcomingMeetings, type UpcomingMeetings } from "../../lib/calendar";
import { logError } from "../../lib/log";
import type { MeetingDoc } from "../../lib/meetings";
import { useGeneralSettings } from "../../state/useGeneralSettings";
import { AnimatedHotkeyGuide } from "../AnimatedHotkeyGuide";
import { DataView } from "../DataView";
import { count, duration, relativeTime } from "../format";
import { useAsyncData } from "../useAsyncData";
import { useDashboardResource, type ResourceHandle } from "../useDashboardResource";

const ACTIVITY_KIND_LABEL: Record<ActivityItem["kind"], string> = {
  voice: "Voice conversation",
  draft: "Draft",
  saved: "Saved item",
};

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

/// Per-card icon color. Each stat gets its own hue and a matching idle
/// animation in dashboard.css, so the four cards read apart at a glance
/// instead of being one wall of teal chips. Reduce motion stills all of them
/// via the existing `.db-reduce-motion` rule.
type CardTone = "ember" | "violet" | "cyan" | "slate";

/// Filled streak flame in the Snapchat fire ramp (red base, amber tip, pale
/// core). Lucide's Flame is a single-color stroke; a streak flame only reads
/// as "fire" with the gradient fill, so this one is hand-rolled. Same size
/// contract as a lucide icon so AnalyticsCard treats them alike.
function StreakFlameIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="4 1.9 16 20.6" fill="none" aria-hidden>
      <defs>
        <linearGradient id="streak-flame-fill" x1="12" y1="2" x2="12" y2="22" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffdf5e" />
          <stop offset="0.5" stopColor="#ff8a3c" />
          <stop offset="1" stopColor="#f13c1f" />
        </linearGradient>
      </defs>
      <path
        fill="url(#streak-flame-fill)"
        d="M12.9 2.4c.2-.3.6-.3.8 0 1.6 2.3 1.9 4.5 1.2 6.7 .5-.3 1-.8 1.4-1.5 .2-.3 .5-.3 .7 0 1.4 2 2.5 4.4 2.5 6.9 0 4.2-3.4 7.5-7.5 7.5S4.5 18.7 4.5 14.5c0-3.1 1.7-5.6 3.4-7.5 1.7-1.9 3.6-3.3 5-4.6Z"
      />
      <path
        fill="#fff3c4"
        d="M12.2 12.1c.1-.2.4-.2.6 0 1.2 1.3 2.4 2.8 2.4 4.4 0 1.8-1.4 3.2-3.2 3.2s-3.2-1.4-3.2-3.2c0-1.7 1.2-3.1 2.4-4.4 .3-.4 .7-.7 1-1Z"
      />
    </svg>
  );
}

function AnalyticsCard({
  Icon,
  label,
  value,
  sub,
  accent = false,
  tone,
}: {
  Icon: LucideIcon | typeof StreakFlameIcon;
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
  tone?: CardTone;
}) {
  return (
    <div className={`db-card${accent ? " db-card-accent" : ""}`}>
      <div className="db-card-head">
        <span className="db-card-label">{label}</span>
        <span className={`db-card-icon${tone ? ` is-${tone}` : ""}`}>
          <Icon size={22} aria-hidden />
        </span>
      </div>
      <div className="db-card-value">{value}</div>
      <div className="db-card-sub">{sub}</div>
    </div>
  );
}

function UpNext({
  state,
  activity,
  meetings,
  showCalendar,
}: {
  state: ReturnType<typeof useAsyncData<UpcomingMeetings | null>>;
  activity: ResourceHandle<ActivityItem[]>;
  meetings: ResourceHandle<MeetingDoc[]>;
  showCalendar: boolean;
}) {
  const [slideIndex, setSlideIndex] = useState(0);
  const slides = useMemo(
    () => [
      ...(showCalendar ? state.data?.events ?? [] : [])
        .map((event) => ({ kind: "event" as const, event })),
      ...(activity.data ?? [])
        .filter((item) => item.kind === "saved")
        .slice(0, 3)
        .map((item) => ({ kind: "saved" as const, item })),
      ...(meetings.data ?? [])
        .flatMap((meeting) =>
          (meeting.note?.actionItems ?? []).map((action, index) => ({
            kind: "action" as const,
            id: `${meeting.meetingId}:${index}`,
            meetingTitle: meeting.title || "Meeting follow-up",
            action,
          })),
        )
        .slice(0, 3),
    ],
    [state.data, activity.data, meetings.data, showCalendar],
  );

  useEffect(() => {
    setSlideIndex(0);
  }, [slides.length]);

  useEffect(() => {
    if (slides.length <= 1) return;
    const timer = setInterval(
      () => setSlideIndex((value) => (value + 1) % slides.length),
      5000,
    );
    return () => clearInterval(timer);
  }, [slides.length]);

  const slide = slides[slideIndex];
  return (
    <aside className="db-hero-up-next">
      <div className="db-hero-up-next-heading">
        <span>UP NEXT</span>
        {slide?.kind === "event" && <CalendarClock size={17} aria-hidden />}
      </div>
      {state.loading && !slide ? (
        <div className="db-hero-up-next-loading">
          <span />
          <span />
          <span />
        </div>
      ) : slide?.kind === "event" ? (
        <div className="db-hero-up-next-slide" key={`event:${slide.event.id}`}>
          <div className="db-hero-up-next-time">
            {slide.event.startLocal || relativeTime(slide.event.startTime)}
          </div>
          <h3>{slide.event.title}</h3>
          <p>
            {slide.event.location ||
              (slide.event.meetingLink ? "Online meeting" : "Calendar event")}
          </p>
          {(() => {
            const minutesUntil = Math.ceil(
              (new Date(slide.event.startTime).getTime() - Date.now()) / 60_000,
            );
            const canJoin = minutesUntil >= 0 && minutesUntil <= 60;
            const eventUrl = slide.event.meetingLink || slide.event.htmlLink;
            return canJoin && eventUrl ? (
              <button
                type="button"
                onClick={() =>
                  void openUrl(eventUrl).catch((err) =>
                    logError("HomePage: open upcoming event", err),
                  )
                }
              >
                {slide.event.meetingLink ? "Join meeting" : "Open event"}
              </button>
            ) : (
              <div className="db-hero-up-next-actions">
                <button
                  type="button"
                  onClick={() => {
                    // TODO: persist a reminder request for this calendar event.
                  }}
                >
                  Remind me
                </button>
                <button
                  type="button"
                  className="db-hero-up-next-secondary"
                  onClick={() => {
                    // TODO: start meeting preparation with this event as context.
                  }}
                >
                  Help me prepare
                </button>
              </div>
            );
          })()}
        </div>
      ) : slide?.kind === "saved" ? (
        <div className="db-hero-up-next-slide" key={`saved:${slide.item.id}`}>
          <div className="db-hero-up-next-time">SAVED FOR LATER</div>
          <h3>{slide.item.title}</h3>
          <p>{slide.item.subtitle || "A recent item you asked Aura to keep."}</p>
          <button type="button" onClick={() => { window.location.hash = "/saved"; }}>
            View saved item
          </button>
        </div>
      ) : slide?.kind === "action" ? (
        <div className="db-hero-up-next-slide" key={`action:${slide.id}`}>
          <div className="db-hero-up-next-time">ACTION ITEM</div>
          <h3>{slide.action}</h3>
          <p>From {slide.meetingTitle}</p>
          <button type="button" onClick={() => { window.location.hash = "/meetings"; }}>
            View meeting
          </button>
        </div>
      ) : (
        <div className="db-hero-up-next-slide" key="empty">
          <div className="db-hero-up-next-empty-mark">✓</div>
          <h3>{state.data?.connected ? "Your calendar is clear" : "Connect your calendar"}</h3>
          <p>
            {state.data?.connected
              ? "No more scheduled events today."
              : "See meetings and upcoming work here."}
          </p>
        </div>
      )}
    </aside>
  );
}

function TodayBriefing({
  calendar,
  activity,
  meetings,
  showCalendar,
}: {
  calendar: ReturnType<typeof useAsyncData<UpcomingMeetings | null>>;
  activity: ResourceHandle<ActivityItem[]>;
  meetings: ResourceHandle<MeetingDoc[]>;
  showCalendar: boolean;
}) {
  const navigate = useNavigate();
  const events = showCalendar ? calendar.data?.events ?? [] : [];
  const resumeItem = activity.data?.find((item) => item.kind !== "voice") ?? null;
  const actionItems = (meetings.data ?? []).flatMap((meeting) =>
    (meeting.note?.actionItems ?? []).map((action) => ({
      action,
      meeting: meeting.title || "Recent meeting",
    })),
  );

  return (
    <section className="db-today-briefing">
      <div className="db-today-briefing-head">
        <div>
          <span>DAILY BRIEFING</span>
          <h3>Today, at a glance</h3>
        </div>
        <Sparkles size={18} aria-hidden />
      </div>
      <div className="db-today-briefing-grid">
        <button type="button" onClick={() => navigate("/connectors")}>
          <span className="db-today-briefing-icon"><CalendarClock size={20} aria-hidden /></span>
          <span>
            <small>Schedule</small>
            <strong>
              {!showCalendar
                ? "Calendar hidden"
                : events.length > 0
                  ? `${events.length} event${events.length === 1 ? "" : "s"} remaining`
                  : calendar.data?.connected
                    ? "Calendar is clear"
                    : "Connect Calendar"}
            </strong>
            <em>{events[0]?.title || "Manage calendar preferences"}</em>
          </span>
        </button>
        <button
          type="button"
          onClick={() =>
            navigate(
              resumeItem?.kind === "draft"
                ? "/drafts"
                : resumeItem?.kind === "saved"
                  ? "/saved"
                  : "/conversations",
            )
          }
        >
          <span className="db-today-briefing-icon"><FileText size={20} aria-hidden /></span>
          <span>
            <small>Continue</small>
            <strong>{resumeItem?.title || "Nothing waiting"}</strong>
            <em>{resumeItem?.subtitle || "Your recent work will appear here"}</em>
          </span>
        </button>
        <button type="button" onClick={() => navigate("/meetings")}>
          <span className="db-today-briefing-icon"><ListChecks size={20} aria-hidden /></span>
          <span>
            <small>Follow-ups</small>
            <strong>
              {actionItems.length > 0
                ? `${actionItems.length} action item${actionItems.length === 1 ? "" : "s"}`
                : "Nothing pending"}
            </strong>
            <em>
              {actionItems[0]
                ? `${actionItems[0].action} · ${actionItems[0].meeting}`
                : "Meeting actions will collect here"}
            </em>
          </span>
        </button>
      </div>
    </section>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const generalSettings = useGeneralSettings();
  const stats = useDashboardResource<HomeStats>(
    "home:stats",
    (signal) => getHomeStats(signal),
    { freshnessMs: 10 * 60_000 },
  );
  const activity = useDashboardResource<ActivityItem[]>(
    "home:activity:8",
    (signal) => getRecentActivity(8, signal),
    { freshnessMs: 5 * 60_000 },
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
  const streak = activeStreak(history.data?.sessions.map((session) => session.started_at) ?? []);

  function startConversation() {
    emitTo("main", START_VOICE_REQUESTED).catch((err) =>
      logError("HomePage: start voice", err),
    );
  }

  return (
    <div className="db-home">
      <section className="db-hero">
        <div className="db-hero-layout">
          <div className="db-hero-main">
            <span className="db-hero-eyebrow">AURA DESKTOP</span>
            <h2 className="db-hero-title">Your personal assistant, ready when you are.</h2>
            <AnimatedHotkeyGuide onTryVoice={startConversation} />
          </div>
          <UpNext
            state={calendar}
            activity={activity}
            meetings={meetings}
            showCalendar={generalSettings.calendarInBriefing}
          />
        </div>
      </section>

      <div className="db-home-grid">
        <section className="db-panel db-recent">
          <div className="db-panel-head">
            <h3 className="db-panel-title">Recent activity</h3>
            <button type="button" className="db-link" onClick={() => navigate("/conversations")}>
              View all
            </button>
          </div>
          <DataView
            state={activity}
            isEmpty={(items) => items.length === 0}
            emptyLabel="No activity yet. Start a conversation and it will show up here."
            errorLabel="Activity will appear here once desktop history is available."
            showRetry={false}
          >
            {(items) => (
              <div className="db-list">
                {items.slice(0, 5).map((item) => (
                  <button
                    type="button"
                    className="db-list-item db-list-item-button"
                    key={item.id}
                    onClick={() =>
                      navigate(item.kind === "voice"
                        ? "/conversations"
                        : item.kind === "draft"
                          ? "/drafts"
                          : "/saved")
                    }
                  >
                    <div className="db-list-meta">
                      {ACTIVITY_KIND_LABEL[item.kind]} · {relativeTime(item.timestamp)}
                    </div>
                    <div className="db-list-title">{item.title}</div>
                    {item.subtitle && <div className="db-list-sub">{item.subtitle}</div>}
                  </button>
                ))}
              </div>
            )}
          </DataView>
        </section>

        <aside className="db-analytics">
          <AnalyticsCard
            Icon={StreakFlameIcon}
            label="Active streak"
            value={`${streak} day${streak === 1 ? "" : "s"}`}
            sub="Consecutive days with Aura"
            accent
            tone="ember"
          />
          <DataView
            state={stats}
            isEmpty={() => false}
            emptyLabel=""
            errorLabel="Analytics will appear here once desktop history is available."
            showRetry={false}
          >
            {(s) => (
              <>
                <AnalyticsCard
                  Icon={BarChart3}
                  label="Conversations this week"
                  value={count(s.sessionsThisWeek)}
                  sub="Last 7 days"
                  tone="violet"
                />
                <AnalyticsCard
                  Icon={Timer}
                  label="Last conversation"
                  value={duration(s.lastSessionSeconds)}
                  sub="Voice time"
                  tone="cyan"
                />
                <AnalyticsCard
                  Icon={Clock}
                  label="Last used"
                  value={relativeTime(s.lastUsedAt)}
                  sub="Desktop voice session"
                  tone="slate"
                />
              </>
            )}
          </DataView>
        </aside>
      </div>

      {generalSettings.dailyBriefing && (
        <TodayBriefing
          calendar={calendar}
          activity={activity}
          meetings={meetings}
          showCalendar={generalSettings.calendarInBriefing}
        />
      )}
    </div>
  );
}
