import { useState, type ReactNode } from "react";
import type { IconComponent } from "./channelIcons";
import { RowMenu, type RowMenuItem } from "./RowMenu";

/** The single JSON/props model that drives every card. A page maps its raw
 * backend rows into this shape; the fixed visual shell below never changes.
 * `Icon` accepts any {size,className} component - a lucide glyph or a brand SVG. */
export interface CardModel {
  id: string;
  /** Optional leading image. `imageUrl` may be a short-lived signed URL that
   * is only ever passed from a live fetch, never from cache. */
  media?: { imageUrl: string | null; alt?: string };
  badge: { Icon: IconComponent; label: string };
  title: string;
  meta: string;
  preview?: string;
  /** Optional overflow actions, revealed as a kebab at the card's top right on
   * hover/focus. The card cannot host it inside its own <button>, so a card
   * with a menu gets a positioned wrapper shell around the button instead. */
  menu?: RowMenuItem[];
}

/** Fixed, presentational card shell. The whole card is the open target, so it
 * is a real <button> (an ARIA-role div would be swallowed by the overlay drag
 * region rules and by keyboard users). Media, badge, title, meta and preview
 * are all populated from the `model` prop - no per-kind branching here. */
export function DashboardCard({
  model,
  onOpen,
  style,
  tall = false,
}: {
  model: CardModel;
  onOpen: (id: string) => void;
  style?: React.CSSProperties;
  /** Email-like layout: more body, taller shell, timestamp in a bottom-right
   * footer instead of a prominent line under the title. */
  tall?: boolean;
}) {
  const { media, badge, title, meta, preview, menu } = model;
  const { Icon } = badge;
  // Only one menu per card, so "one open at a time" is per-card local state;
  // outside-click already closes a stray open menu when another one opens.
  const [menuOpen, setMenuOpen] = useState(false);
  const card = (
    <button
      type="button"
      className={`db-card2${tall ? " db-card2-tall" : ""}`}
      style={style}
      onClick={() => onOpen(model.id)}
    >
      {media && <CardMedia imageUrl={media.imageUrl} alt={media.alt} />}
      <div className="db-card2-badge">
        <Icon className="db-card2-badge-icon" size={14} />
        <span className="db-card2-badge-label">{badge.label}</span>
      </div>
      <p className="db-card2-title">{title}</p>
      {!tall && <p className="db-card2-meta">{meta}</p>}
      {preview && <p className="db-card2-preview">{preview}</p>}
      {tall && (
        <div className="db-card2-foot">
          <span className="db-card2-meta">{meta}</span>
        </div>
      )}
    </button>
  );
  if (!menu) return card;
  // The kebab is a SIBLING of the card button, never a child: a button inside
  // a button is invalid HTML and untabbable. The stagger style stays on the
  // button because that is the element `db-card-in` animates.
  return (
    <div className="db-card2-shell">
      {card}
      <div className={menuOpen ? "db-card2-actions is-open" : "db-card2-actions"}>
        <RowMenu open={menuOpen} onOpenChange={setMenuOpen} items={menu} />
      </div>
    </div>
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
