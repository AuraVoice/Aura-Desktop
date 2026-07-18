import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { getDrafts, type RawDraft } from "../../lib/dashboardApi";
import type { DraftChannel } from "../../lib/draft";
import { useDashboardResource } from "../useDashboardResource";
import { CardGrid } from "../components/CardGrid";
import { DetailModal } from "../components/DetailModal";
import { EmptyState } from "../components/EmptyState";
import { PageError } from "../components/PageError";
import { RefreshIndicator } from "../components/RefreshIndicator";
import type { CardModel } from "../components/DashboardCard";
import { deriveDraftTitle, shortDateTime } from "../format";

const CHANNEL_LABEL: Record<DraftChannel, string> = {
  email_reply: "Email reply",
  cold_dm: "Cold DM",
  snippet: "Snippet",
};

function draftToCard(draft: RawDraft): CardModel {
  const recipient = draft.recipient_hint.trim();
  const badgeLabel = [CHANNEL_LABEL[draft.channel] ?? draft.channel, recipient]
    .filter(Boolean)
    .join(" · ");
  return {
    id: draft.draft_id,
    badge: { Icon: FileText, label: badgeLabel },
    title: deriveDraftTitle(draft.text),
    meta: shortDateTime(draft.updated_at || draft.created_at),
    preview: draft.context_summary || undefined,
  };
}

export function DraftsPage() {
  const res = useDashboardResource<RawDraft[]>("drafts", (signal) => getDrafts(signal));
  const [selected, setSelected] = useState<string | null>(null);

  const drafts = useMemo(() => res.data ?? [], [res.data]);
  const models = useMemo(() => drafts.map(draftToCard), [drafts]);
  const selectedDraft = selected ? drafts.find((d) => d.draft_id === selected) ?? null : null;

  return (
    <div className="db-page db-page-wide">
      <div className="db-page-toolbar db-page-toolbar-end">
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
              Icon={FileText}
              heading="No drafts yet"
              copy="Drafts you create in a conversation show up here for 7 days."
            />
          }
        />
      )}

      <DetailModal
        open={selectedDraft != null}
        title={selectedDraft ? CHANNEL_LABEL[selectedDraft.channel] ?? "Draft" : "Draft"}
        onClose={() => setSelected(null)}
      >
        {selectedDraft && (
          <div className="db-detail">
            <div className="db-detail-tags">
              <span className="db-tag">{CHANNEL_LABEL[selectedDraft.channel] ?? selectedDraft.channel}</span>
              <span className="db-tag">{selectedDraft.length}</span>
              {selectedDraft.recipient_hint.trim() && (
                <span className="db-tag">{selectedDraft.recipient_hint.trim()}</span>
              )}
            </div>
            <p className="db-detail-meta">
              Updated {shortDateTime(selectedDraft.updated_at || selectedDraft.created_at)}
              {selectedDraft.revision > 0 ? ` · revision ${selectedDraft.revision}` : ""}
            </p>
            <p className="db-detail-text db-detail-text-body">{selectedDraft.text}</p>
            {selectedDraft.context_summary && (
              <p className="db-detail-context">{selectedDraft.context_summary}</p>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
