import { BarChart3, Timer, type LucideIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { HomeStats } from "../../lib/dashboardApi";
import { count, duration } from "../format";

/** Filled streak flame in the Snapchat fire ramp (red base, amber tip, pale
 * core). The outer flame and the core flicker on their own clocks (home.css,
 * `db-flame-*`), so it reads as a live fire rather than a wobbling icon. Same
 * size contract as a lucide icon so the card treats them alike. */
function StreakFlameIcon({ size = 22 }: { size?: number }) {
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
        className="db-flame-outer"
        fill="url(#streak-flame-fill)"
        d="M12.9 2.4c.2-.3.6-.3.8 0 1.6 2.3 1.9 4.5 1.2 6.7 .5-.3 1-.8 1.4-1.5 .2-.3 .5-.3 .7 0 1.4 2 2.5 4.4 2.5 6.9 0 4.2-3.4 7.5-7.5 7.5S4.5 18.7 4.5 14.5c0-3.1 1.7-5.6 3.4-7.5 1.7-1.9 3.6-3.3 5-4.6Z"
      />
      <path
        className="db-flame-core"
        fill="#fff3c4"
        d="M12.2 12.1c.1-.2.4-.2.6 0 1.2 1.3 2.4 2.8 2.4 4.4 0 1.8-1.4 3.2-3.2 3.2s-3.2-1.4-3.2-3.2c0-1.7 1.2-3.1 2.4-4.4 .3-.4 .7-.7 1-1Z"
      />
    </svg>
  );
}

function InsightCard({
  Icon,
  tone,
  label,
  value,
  sub,
}: {
  Icon: LucideIcon | typeof StreakFlameIcon;
  tone: "ember" | "violet" | "cyan";
  label: string;
  value: string;
  sub: string;
}) {
  const navigate = useNavigate();
  return (
    <button type="button" className="db-card db-home-insight" onClick={() => navigate("/insights")}>
      <span className="db-card-head">
        <span className="db-card-label">{label}</span>
        <span className={`db-card-icon is-${tone}`}>
          <Icon size={22} aria-hidden />
        </span>
      </span>
      <span className="db-card-value">{value}</span>
      <span className="db-card-sub">{sub}</span>
    </button>
  );
}

/** The three numbers worth a glance, stacked beside Jump back in. Each card
 * opens Insights for the full picture. */
export function InsightsCards({ stats, streak }: { stats: HomeStats | null; streak: number }) {
  return (
    <section className="db-home-insights" aria-label="Insights">
      <InsightCard
        Icon={StreakFlameIcon}
        tone="ember"
        label="Active streak"
        value={`${streak} day${streak === 1 ? "" : "s"}`}
        sub="Consecutive days with Aura"
      />
      <InsightCard
        Icon={BarChart3}
        tone="violet"
        label="Conversations this week"
        value={count(stats?.sessionsThisWeek ?? null)}
        sub="Last 7 days"
      />
      <InsightCard
        Icon={Timer}
        tone="cyan"
        label="Last conversation"
        value={duration(stats?.lastSessionSeconds ?? null)}
        sub="Voice time"
      />
    </section>
  );
}
