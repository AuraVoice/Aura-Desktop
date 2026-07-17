import { getUsage, type Usage } from "../../lib/dashboardApi";
import { useAsyncData } from "../useAsyncData";
import { DataView } from "../DataView";
import { shortDateTime } from "../format";

function meter(used: number, limit: number | null): { text: string; pct: number | null } {
  if (limit === null) return { text: `${used} · unlimited`, pct: null };
  return { text: `${used} / ${limit}`, pct: Math.min(100, Math.round((used / limit) * 100)) };
}

export function UsagePage() {
  const state = useAsyncData<Usage>(() => getUsage(), "usage");
  return (
    <div className="db-page">
      <DataView
        state={state}
        isEmpty={() => false}
        emptyLabel=""
        errorLabel="Usage will appear here once desktop history is available."
        showRetry={false}
      >
        {(u) => {
          const voice = meter(u.voiceMinutesUsed, u.voiceMinutesLimit);
          const drafts = meter(u.draftsUsed, u.draftsLimit);
          return (
            <div className="db-usage">
              <p className="db-muted db-usage-period">
                {shortDateTime(u.periodStart)} — {shortDateTime(u.periodEnd)}
              </p>
              <div className="db-usage-row">
                <div className="db-usage-head">
                  <span>Voice minutes</span>
                  <span className="db-muted">{voice.text}</span>
                </div>
                {voice.pct !== null && (
                  <div className="db-bar">
                    <div className="db-bar-fill" style={{ width: `${voice.pct}%` }} />
                  </div>
                )}
              </div>
              <div className="db-usage-row">
                <div className="db-usage-head">
                  <span>Drafts</span>
                  <span className="db-muted">{drafts.text}</span>
                </div>
                {drafts.pct !== null && (
                  <div className="db-bar">
                    <div className="db-bar-fill" style={{ width: `${drafts.pct}%` }} />
                  </div>
                )}
              </div>
            </div>
          );
        }}
      </DataView>
    </div>
  );
}
