import { useMemo, useState } from "react";
import { Archive, AudioLines } from "lucide-react";
import {
  getHistorySessions,
  getSessionDetail,
  type HistoryArchive,
  type HistorySessions,
  type RawHistorySession,
} from "../../lib/dashboardApi";
import { useDashboardResource } from "../useDashboardResource";
import { useAsyncData } from "../useAsyncData";
import { CardGrid } from "../components/CardGrid";
import { DetailModal } from "../components/DetailModal";
import { EmptyState } from "../components/EmptyState";
import { PageError } from "../components/PageError";
import { RefreshIndicator } from "../components/RefreshIndicator";
import { RangeChips, sinceFromRange, type RangeKey } from "../components/RangeChips";
import type { CardModel } from "../components/DashboardCard";
import { deriveSessionTitle, shortDateTime } from "../format";

const ARCHIVE_ID = "__archive__";

function sessionToCard(session: RawHistorySession): CardModel {
  const turns = session.num_of_turns > 0 ? `${session.num_of_turns} turns` : "Voice";
  return {
    id: session.session_id,
    badge: { Icon: AudioLines, label: turns },
    title: deriveSessionTitle(session.summary),
    meta: shortDateTime(session.started_at),
  };
}

function archiveToCard(archive: HistoryArchive): CardModel {
  return {
    id: ARCHIVE_ID,
    badge: { Icon: Archive, label: "Archive" },
    title: "Earlier history",
    meta: `${archive.sessions_archived_count} earlier conversation${
      archive.sessions_archived_count === 1 ? "" : "s"
    }`,
  };
}

export function ConversationsPage() {
  const [range, setRange] = useState<RangeKey>("3d");
  const since = sinceFromRange(range);
  const res = useDashboardResource<HistorySessions>(
    `history:${range}`,
    (signal) => getHistorySessions(since, signal),
  );
  const [selected, setSelected] = useState<string | null>(null);

  const sessions = res.data?.sessions ?? [];
  const archive = res.data?.archive ?? null;

  const models = useMemo(() => {
    const list = sessions.map(sessionToCard);
    if (archive) list.push(archiveToCard(archive));
    return list;
  }, [sessions, archive]);

  const selectedSession =
    selected && selected !== ARCHIVE_ID
      ? sessions.find((s) => s.session_id === selected) ?? null
      : null;

  return (
    <div className="db-page db-page-wide">
      <div className="db-page-toolbar">
        <RangeChips value={range} onChange={setRange} />
        <RefreshIndicator
          refreshing={res.refreshing}
          stale={res.stale}
          cachedAt={res.cachedAt}
          onRetry={res.reload}
        />
      </div>

      {res.error ? (
        <PageError authExpired={res.authExpired} onRetry={res.reload} />
      ) : (
        <CardGrid
          models={models}
          loading={res.loading}
          onOpen={setSelected}
          empty={
            <EmptyState
              Icon={AudioLines}
              heading="No conversations in this range"
              copy="Use your voice shortcut to start one, or widen the range above."
            />
          }
        />
      )}

      <DetailModal
        open={selected != null}
        title={
          selected === ARCHIVE_ID
            ? "Earlier history"
            : selectedSession?.summary.trim() || undefined
        }
        centerTitle={selected !== ARCHIVE_ID}
        onClose={() => setSelected(null)}
      >
        {selected === ARCHIVE_ID && archive ? (
          <p className="db-detail-text">{archive.archive_summary}</p>
        ) : selectedSession ? (
          <ConversationDetail
            sessionId={selectedSession.session_id}
            startedAt={selectedSession.started_at}
          />
        ) : null}
      </DetailModal>
    </div>
  );
}

/** Lazily fetches the full transcript for one session when its card is opened.
 * Has its own loading/error state inside the modal so the grid never blocks. */
function ConversationDetail({
  sessionId,
  startedAt,
}: {
  sessionId: string;
  startedAt: string;
}) {
  const detail = useAsyncData(() => getSessionDetail(sessionId), `session:${sessionId}`);

  return (
    <div className="db-detail">
      <p className="db-detail-meta db-conversation-time">{shortDateTime(startedAt)}</p>
      <div className="db-detail-transcript">
        {detail.loading && <p className="db-muted">Loading transcript…</p>}
        {detail.error && <p className="db-muted">Transcript unavailable.</p>}
        {detail.data?.raw_turns?.length
          ? detail.data.raw_turns.map((turn, i) => (
              <div className={`db-turn db-turn-${turn.role}`} key={turn.message_id ?? i}>
                <p className="db-turn-text">{turn.text}</p>
              </div>
            ))
          : detail.loading || detail.error
            ? null
            : <p className="db-muted">No transcript for this conversation.</p>}
      </div>
    </div>
  );
}
