import { useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** The single JSON/props model that drives every card. A page maps its raw
 * backend rows into this shape; the fixed visual shell below never changes. */
export interface CardModel {
  id: string;
  /** Optional leading image. `imageUrl` may be a short-lived signed URL that
   * is only ever passed from a live fetch, never from cache. */
  media?: { imageUrl: string | null; alt?: string };
  badge: { Icon: LucideIcon; label: string };
  title: string;
  meta: string;
  preview?: string;
}

/** Fixed, presentational card shell. The whole card is the open target, so it
 * is a real <button> (an ARIA-role div would be swallowed by the overlay drag
 * region rules and by keyboard users). Media, badge, title, meta and preview
 * are all populated from the `model` prop - no per-kind branching here. */
export function DashboardCard({
  model,
  onOpen,
  style,
}: {
  model: CardModel;
  onOpen: (id: string) => void;
  style?: React.CSSProperties;
}) {
  const { media, badge, title, meta, preview } = model;
  const { Icon } = badge;
  return (
    <button
      type="button"
      className="db-card2"
      style={style}
      onClick={() => onOpen(model.id)}
    >
      {media && <CardMedia imageUrl={media.imageUrl} alt={media.alt} />}
      <div className="db-card2-badge">
        <Icon className="db-card2-badge-icon" size={14} />
        <span className="db-card2-badge-label">{badge.label}</span>
      </div>
      <p className="db-card2-title">{title}</p>
      <p className="db-card2-meta">{meta}</p>
      {preview && <p className="db-card2-preview">{preview}</p>}
    </button>
  );
}

/** Image with a fixed aspect ratio (no layout shift) that fades in on load and
 * shows a shimmer until it decodes. A null URL (e.g. a cache-seeded save before
 * revalidation) keeps the shimmer rather than flashing a broken image. */
function CardMedia({ imageUrl, alt }: { imageUrl: string | null; alt?: string }): ReactNode {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="db-card2-media">
      {imageUrl && (
        <img
          src={imageUrl}
          alt={alt ?? ""}
          loading="lazy"
          decoding="async"
          className={`db-card2-img${loaded ? " db-card2-img-in" : ""}`}
          onLoad={() => setLoaded(true)}
        />
      )}
      {!(imageUrl && loaded) && <div className="db-shimmer db-card2-media-ph" />}
    </div>
  );
}
