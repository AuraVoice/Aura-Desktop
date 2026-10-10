import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ListChecks } from "lucide-react";
import {
  approvePendingAction,
  CONNECTOR_NAMES,
  pendingActionOutcomeCopy,
  rejectPendingAction,
  type PendingAction,
} from "../../lib/pendingActions";
import type { MeetingDoc } from "../../lib/meetings";
import { logError } from "../../lib/log";
import { relativeTime } from "../format";
import { HomeRow } from "./HomeRow";
import { meetingPath } from "../pages/MeetingsPage";
import type { ResourceHandle } from "../useDashboardResource";

const MAX_ROWS = 5;
const ACTION_ITEM_WINDOW_MS = 7 * 86_400_000;

type Row =
  | { kind: "approval"; at: string; action: PendingAction }
  | { kind: "followUp"; at: string; meeting: MeetingDoc; items: string[] };

/** Only things blocked on the user: connector writes waiting for approval and
 * the action items from this week's meetings. Notifications stay in the bell. */
export function NeedsYou({
  approvals,
  meetings,
}: {
  approvals: ResourceHandle<PendingAction[]>;
  meetings: ResourceHandle<MeetingDoc[]>;
}) {
  const navigate = useNavigate();
  const cutoff = Date.now() - ACTION_ITEM_WINDOW_MS;
  const rows: Row[] = [
    // A Swarm draft's approval lives in its report, same filter as the overlay card.
    ...(approvals.data ?? [])
      .filter((action) => action.status === "pending" && action.origin !== "swarm")
      .map((action): Row => ({ kind: "approval", at: action.createdAt, action })),
    ...(meetings.data ?? [])
      .filter((meeting) =>
        (meeting.note?.actionItems.length ?? 0) > 0 && new Date(meeting.createdAt).getTime() >= cutoff,
      )
      .map((meeting): Row => ({
        kind: "followUp",
        at: meeting.createdAt,
        meeting,
        items: meeting.note?.actionItems ?? [],
      })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const loading = (approvals.loading || meetings.loading) && rows.length === 0;

  return (
    <section className="db-home-panel" aria-labelledby="db-home-needs-title">
      <div className="db-home-panel-head">
        <h3 id="db-home-needs-title">
          Needs you
          {rows.length > 0 && <span className="db-home-count">{rows.length}</span>}
        </h3>
      </div>
      {loading ? (
        <div className="db-home-skeleton" aria-hidden>
          <span />
          <span />
        </div>
      ) : rows.length === 0 ? (
        <div className="db-home-empty">
          <strong>You're all caught up</strong>
          <span>Posts waiting for your OK and meeting action items land here.</span>
        </div>
      ) : (
        <div className="db-home-rows">
          {rows.slice(0, MAX_ROWS).map((row) =>
            row.kind === "approval" ? (
              <ApprovalRow key={row.action.approvalId} action={row.action} onSettled={approvals.reload} />
            ) : (
              <HomeRow
                key={row.meeting.meetingId}
                icon={<ListChecks size={16} />}
                tone="ember"
                title={row.items[0]}
                detail={`${row.items.length === 1 ? "Action item" : `${row.items.length} action items`} · ${row.meeting.title || "Meeting"}`}
                time={relativeTime(row.at)}
                onClick={() => navigate(meetingPath(row.meeting.meetingId))}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}

/** Same approve/reject calls as the overlay's approval card, against the
 * backend's stored preview, so what is shown here is what gets sent. */
function ApprovalRow({ action, onSettled }: { action: PendingAction; onSettled: () => void }) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const isPublic = action.connector === "x" || action.connector === "linkedin";
  const preview = action.preview.issueTitle || action.preview.eventTitle || action.preview.text;

  const run = async (call: () => Promise<PendingAction | null>) => {
    setBusy(true);
    try {
      const result = await call();
      setOutcome(result ? pendingActionOutcomeCopy(result) : "This request is no longer waiting.");
      // Leave the outcome readable before the refreshed list drops the row.
      setTimeout(onSettled, 4000);
    } catch (err) {
      logError("HomePage: settle approval", err);
      const reason = err instanceof Error ? err.message : String(err);
      setOutcome(`Aura couldn't send that: ${reason}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <HomeRow
      icon={<Check size={16} />}
      tone="violet"
      title={action.title || `Post to ${CONNECTOR_NAMES[action.connector]}`}
      detail={outcome ?? `${CONNECTOR_NAMES[action.connector]} · ${preview}`}
      time={relativeTime(action.createdAt)}
      trailing={outcome ? undefined : (
        <>
          <button
            type="button"
            className="db-home-pill"
            disabled={busy}
            onClick={() => void run(() => rejectPendingAction(action.approvalId))}
          >
            Not now
          </button>
          <button
            type="button"
            className="db-home-pill is-primary"
            disabled={busy}
            onClick={() => void run(() => approvePendingAction(action.approvalId))}
          >
            {busy ? "Working" : isPublic ? "Approve and post" : "Approve"}
          </button>
        </>
      )}
    />
  );
}
