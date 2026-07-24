import {
  BarChart3,
  CalendarClock,
  Clock,
  Flame,
  Timer,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useNavigate } from "react-router-dom";
import {
  getHistorySessions,
  getHomeStats,
  getRecentActivity,
  type ActivityItem,
  type HomeStats,
} from "../../lib/dashboardApi";
import { fetchUpcomingMeetings, type UpcomingMeetings } from "../../lib/calendar";
import { logError } from "../../lib/log";
import { AnimatedHotkeyGuide } from "../AnimatedHotkeyGuide";
import { DataView } from "../DataView";
import { count, duration, relativeTime } from "../format";
import { useAsyncData } from "../useAsyncData";

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

function AnalyticsCard({
  Icon,
  label,
  value,
  sub,
  accent = false,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  accent?: boolean;
}) {
  return (
    <div className={`db-card${accent ? " db-card-accent" : ""}`}>
      <div className="db-card-head">
        <span className="db-card-label">{label}</span>
        <span className="db-card-icon"><Icon size={18} aria-hidden /></span>
      </div>
      <div className="db-card-value">{value}</div>
      <div className="db-card-sub">{sub}</div>
    </div>
  );
}

function UpNext({
  state,
  activity,
}: {
  state: ReturnType<typeof useAsyncData<UpcomingMeetings | null>>;
  activity: ReturnType<typeof useAsyncData<ActivityItem[]>>;
}) {
  const [slideIndex, setSlideIndex] = useState(0);
  const slides = useMemo(
    () => [
      ...(state.data?.events ?? []).map((event) => ({ kind: "event" as const, event })),
      ...(activity.data ?? [])
        .filter((item) => item.kind === "saved")
        .slice(0, 3)
        .map((item) => ({ kind: "saved" as const, item })),
    ],
    [state.data, activity.data],
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
            return canJoin && (slide.event.meetingLink || slide.event.htmlLink) ? (
              <button
                type="button"
                onClick={() =>
                  void openUrl(slide.event.meetingLink || slide.event.htmlLink!).catch((err) =>
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

export function HomePage() {
  const navigate = useNavigate();
  const stats = useAsyncData<HomeStats>(() => getHomeStats(), "home stats");
  const activity = useAsyncData<ActivityItem[]>(() => getRecentActivity(8), "recent activity");
  const calendar = useAsyncData<UpcomingMeetings | null>(
    () => fetchUpcomingMeetings(10_000),
    "home calendar",
  );
  const history = useAsyncData(
    () => getHistorySessions(new Date(Date.now() - 31 * 86_400_000).toISOString()),
    "home streak",
  );
  const streak = activeStreak(history.data?.sessions.map((session) => session.started_at) ?? []);

  function startConversation() {
    emitTo("main", "start-voice-requested").catch((err) =>
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
          <UpNext state={calendar} activity={activity} />
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
                {items.map((item) => (
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
            Icon={Flame}
            label="Active streak"
            value={`${streak} day${streak === 1 ? "" : "s"}`}
            sub="Consecutive days with Aura"
            accent
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
                />
                <AnalyticsCard
                  Icon={Timer}
                  label="Last conversation"
                  value={duration(s.lastSessionSeconds)}
                  sub="Voice time"
                />
                <AnalyticsCard
                  Icon={Clock}
                  label="Last used"
                  value={relativeTime(s.lastUsedAt)}
                  sub="Desktop voice session"
                />
              </>
            )}
          </DataView>
        </aside>
      </div>
    </div>
  );
}
