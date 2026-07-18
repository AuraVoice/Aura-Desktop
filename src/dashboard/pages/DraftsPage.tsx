import { useMemo, useState } from "react";
import { FileText } from "lucide-react";
import { getDrafts, type RawDraft } from "../../lib/dashboardApi";
import { useDashboardResource } from "../useDashboardResource";
import { CardGrid } from "../components/CardGrid";
import { DetailModal } from "../components/DetailModal";
import { EmptyState } from "../components/EmptyState";
import { PageError } from "../components/PageError";
import { RefreshIndicator } from "../components/RefreshIndicator";
import { channelVisual } from "../components/channelIcons";
import { CopyButton } from "../components/CopyButton";
import type { CardModel } from "../components/DashboardCard";
import { bodyAfterTitle, deriveDraftTitle, shortDateTime } from "../format";

function draftToCard(draft: RawDraft): CardModel {
  const { Icon, label } = channelVisual(draft.channel);
  const recipient = draft.recipient_hint.trim();
  const badgeLabel = [label, recipient].filter(Boolean).join(" · ");
  return {
    id: draft.draft_id,
    badge: { Icon, label: badgeLabel },
    title: deriveDraftTitle(draft.text),
    meta: shortDateTime(draft.updated_at || draft.created_at),
    // Show the actual email body, not the AI context summary (that stays in the
    // detail view). deriveDraftTitle already used the opening line as the title.
    preview: bodyAfterTitle(draft.text) || undefined,
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
          tall
          columns="three"
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
        title={selectedDraft ? channelVisual(selectedDraft.channel).label : "Draft"}
        onClose={() => setSelected(null)}
      >
        {selectedDraft && (
          <div className="db-detail">
            <div className="db-detail-tags">
              <span className="db-tag">{channelVisual(selectedDraft.channel).label}</span>
              <span className="db-tag">{selectedDraft.length}</span>
              {selectedDraft.recipient_hint.trim() && (
                <span className="db-tag">{selectedDraft.recipient_hint.trim()}</span>
              )}
            </div>
            <p className="db-detail-meta">
              Updated {shortDateTime(selectedDraft.updated_at || selectedDraft.created_at)}
              {selectedDraft.revision > 0 ? ` · revision ${selectedDraft.revision}` : ""}
            </p>
            <div className="db-detail-text-body db-draft-body">
              <CopyButton text={selectedDraft.text} compact />
              <p className="db-detail-text">{selectedDraft.text}</p>
            </div>
            {selectedDraft.context_summary && (
              <p className="db-detail-context">{selectedDraft.context_summary}</p>
            )}
          </div>
        )}
      </DetailModal>
    </div>
  );
}
