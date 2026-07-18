import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Bookmark, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getScreenSaves, type RawScreenSave } from "../../lib/dashboardApi";
import { logError } from "../../lib/log";
import { useDashboardResource } from "../useDashboardResource";
import { CardGrid } from "../components/CardGrid";
import { DetailModal } from "../components/DetailModal";
import { EmptyState } from "../components/EmptyState";
import { PageError } from "../components/PageError";
import { RefreshIndicator } from "../components/RefreshIndicator";
import type { CardModel } from "../components/DashboardCard";
import { shortDateTime } from "../format";

function saveToCard(save: RawScreenSave): CardModel {
  return {
    id: save.item_id,
    media: { imageUrl: save.image_url, alt: save.title },
    badge: { Icon: Bookmark, label: save.collection_name || "Saved" },
    title: save.title || "Saved item",
    meta: save.note?.trim() || shortDateTime(save.created_at),
  };
}

/** image_url is a short-lived signed GCS URL; it must never touch disk. Cache a
 * copy with it nulled - the live revalidate always refills fresh URLs. */
function stripImageUrls(saves: RawScreenSave[]): RawScreenSave[] {
  return saves.map((s) => ({ ...s, image_url: null }));
}

export function SavedPage() {
  const res = useDashboardResource<RawScreenSave[]>(
    "screen-saves",
    (signal) => getScreenSaves(signal),
    { toCache: stripImageUrls },
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const saves = useMemo(() => res.data ?? [], [res.data]);
  const models = useMemo(() => saves.map(saveToCard), [saves]);
  const selectedSave = selected ? saves.find((s) => s.item_id === selected) ?? null : null;

  const closeDetail = () => {
    setSelected(null);
    setZoomed(false);
  };
  const zoomTarget =
    (typeof document !== "undefined" && document.querySelector(".db-app")) || document.body;

  return (
    <div className="db-page db-page-full">
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
          withMedia
          columns="three"
          onOpen={setSelected}
          empty={
            <EmptyState
              Icon={Bookmark}
              heading="Nothing saved yet"
              copy="Ask Aura to remember something on your screen and it lands here."
            />
          }
        />
      )}

      <DetailModal
        open={selectedSave != null}
        title={selectedSave?.title || "Saved item"}
        onClose={closeDetail}
      >
        {selectedSave && (
          <div className="db-detail">
            {selectedSave.image_url && (
              // Signed URL from the live fetch only - not persisted. Click to
              // zoom into a full-viewport lightbox.
              <button
                type="button"
                className="db-detail-img-btn"
                onClick={() => setZoomed(true)}
                aria-label="Expand image"
              >
                <img
                  src={selectedSave.image_url}
                  alt={selectedSave.title}
                  className="db-detail-img"
                  decoding="async"
                />
                <span className="db-detail-img-hint">Click to expand</span>
              </button>
            )}
            <div className="db-detail-tags">
              <span className="db-tag">{selectedSave.collection_name || "Saved"}</span>
              <span className="db-tag">{shortDateTime(selectedSave.created_at)}</span>
            </div>
            {selectedSave.description && (
              <p className="db-detail-text">{selectedSave.description}</p>
            )}
            {selectedSave.note?.trim() && (
              <p className="db-detail-context">{selectedSave.note}</p>
            )}
            {selectedSave.source_url && (
              <button
                type="button"
                className="db-detail-link"
                onClick={() =>
                  void openUrl(selectedSave.source_url!).catch((err) =>
                    logError("SavedPage: open source", err),
                  )
                }
              >
                <ExternalLink size={14} /> Open source
              </button>
            )}
          </div>
        )}
      </DetailModal>

      {zoomed &&
        selectedSave?.image_url &&
        createPortal(
          <div className="db-lightbox" onClick={() => setZoomed(false)}>
            <img
              src={selectedSave.image_url}
              alt={selectedSave.title}
              className="db-lightbox-img"
              decoding="async"
            />
          </div>,
          zoomTarget,
        )}
    </div>
  );
}
