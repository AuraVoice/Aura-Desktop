import { BarChart3, Clock, Timer, type LucideIcon } from "lucide-react";
import {
  getHomeStats,
  getRecentActivity,
  type ActivityItem,
  type HomeStats,
} from "../../lib/dashboardApi";
import { useAsyncData } from "../useAsyncData";
import { DataView } from "../DataView";
import { count, duration, relativeTime } from "../format";
import { emitTo } from "@tauri-apps/api/event";
import { logError } from "../../lib/log";

const ACTIVITY_KIND_LABEL: Record<ActivityItem["kind"], string> = {
  voice: "Voice conversation",
  draft: "Draft",
  saved: "Saved item",
};

function AnalyticsCard({
  Icon,
  label,
  value,
  sub,
}: {
  Icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="db-card">
      <div className="db-card-head">
        <span className="db-card-label">{label}</span>
        <span className="db-card-icon">
          <Icon size={18} aria-hidden />
        </span>
      </div>
      <div className="db-card-value">{value}</div>
      <div className="db-card-sub">{sub}</div>
    </div>
  );
}

export function HomePage() {
  const stats = useAsyncData<HomeStats>(() => getHomeStats(), "home stats");
  const activity = useAsyncData<ActivityItem[]>(() => getRecentActivity(8), "recent activity");

  return (
    <div className="db-home">
      <section className="db-hero">
        <span className="db-hero-eyebrow">AURA DESKTOP</span>
        <h2 className="db-hero-title">Your personal assistant, ready when you are.</h2>
        <p className="db-hero-sub">
          Press Ctrl twice, talk naturally, and let Aura help with messages, notes, saved
          information, and everyday work.
        </p>
        <button type="button" className="db-hero-cta" onClick={startConversation}>
          Start a conversation
        </button>
      </section>

      <div className="db-home-grid">
        <section className="db-panel db-recent">
          <div className="db-panel-head">
            <h3 className="db-panel-title">Recent activity</h3>
            <button type="button" className="db-link">
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
                  <div className="db-list-item" key={item.id}>
                    <div className="db-list-meta">
                      {ACTIVITY_KIND_LABEL[item.kind]} · {relativeTime(item.timestamp)}
                    </div>
                    <div className="db-list-title">{item.title}</div>
                    {item.subtitle && <div className="db-list-sub">{item.subtitle}</div>}
                  </div>
                ))}
              </div>
            )}
          </DataView>
        </section>

        <aside className="db-analytics">
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
                  Icon={Clock}
                  label="Last used"
                  value={relativeTime(s.lastUsedAt)}
                  sub="Desktop voice session"
                />
                <AnalyticsCard
                  Icon={Timer}
                  label="Last session duration"
                  value={duration(s.lastSessionSeconds)}
                  sub="Most recent session"
                />
                <AnalyticsCard
                  Icon={BarChart3}
                  label="Sessions this week"
                  value={count(s.sessionsThisWeek)}
                  sub="Last 7 days"
                />
              </>
            )}
          </DataView>
        </aside>
      </div>
    </div>
  );
}
  function startConversation() {
    // Voice state belongs to the persistent main webview. Targeting its event
    // keeps the dashboard's separate demo hook from creating a second session.
    emitTo("main", "start-voice-requested").catch((err) =>
      logError("HomePage: start voice", err),
    );
  }
