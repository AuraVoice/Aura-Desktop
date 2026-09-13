import { X } from "lucide-react";
import { GlassSurface } from "../GlassSurface";
import { regionPreview as copy } from "../../lib/copy";
import type { RegionPreview } from "./useRegionCapture";
import "./RegionPreviewCard.css";

/** Must fit the rendered CSS (Rust grows the window by exactly this many
 * logical px): the 11px inset that leaves room for the corner X, 10px padding,
 * the 52px thumbnail, 10px padding. */
export const REGION_PREVIEW_CARD_HEIGHT = 83;

/**
 * What the user just circled, in the below-bar slot. Same dark card family as
 * MeetingPromptCard, since both sit over whatever app the user is in. Real
 * <button>s only, per the drag-region rule.
 */
export function RegionPreviewCard({
  preview,
  onDismiss,
}: {
  preview: RegionPreview;
  onDismiss: () => void;
}) {
  return (
    <GlassSurface className="region-preview-card" draggable={false}>
      <div className="region-preview-inner">
        <img className="region-preview-thumb" src={preview.url} alt="" draggable={false} />
        <div className="region-preview-text">
          <span className="region-preview-title">
            {preview.wholeDisplay ? copy.wholeScreen : copy.title}
          </span>
          <span className="region-preview-meta">{copy.size(preview.widthPx, preview.heightPx)}</span>
        </div>
      </div>
      <button
        type="button"
        className="region-preview-close"
        onClick={onDismiss}
        aria-label={copy.dismiss}
      >
        <X size={12} strokeWidth={2.5} aria-hidden="true" />
      </button>
    </GlassSurface>
  );
}
