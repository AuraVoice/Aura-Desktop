import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { DashboardCard, type CardModel } from "./DashboardCard";
import { CardSkeleton } from "./CardSkeleton";

const SKELETON_COUNT = 8;
const INITIAL_WINDOW = 12;
const WINDOW_STEP = 12;

/** Responsive card grid with client-side windowed pagination. Renders an
 * initial window and grows it as an IntersectionObserver sentinel scrolls into
 * view, so the DOM node count stays bounded no matter how large the dataset is.
 * The reused backend endpoints are un-paginated (full capped arrays), so this
 * is windowing over an in-memory set, not N+1 network calls.
 *
 * `loading` only shows skeletons when there is nothing cached to paint; once
 * `models` exist we render them and let any background refresh happen silently. */
export function CardGrid({
  models,
  loading,
  withMedia = false,
  tall = false,
  columns = "auto",
  onOpen,
  empty,
}: {
  models: CardModel[];
  loading: boolean;
  withMedia?: boolean;
  /** Email-like taller cards (Drafts). */
  tall?: boolean;
  /** "auto" fills by min column width; "three" pins to a 3-up responsive grid. */
  columns?: "auto" | "three";
  onOpen: (id: string) => void;
  empty: ReactNode;
}) {
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset the window whenever the underlying set identity changes (e.g. a range
  // switch on Conversations) so we never keep a huge window across datasets.
  // Keyed on the FIRST window only: a background revalidation that appends or
  // drops a row further down used to change the joined key and collapse the
  // window back to 12, unmounting everything the user had already scrolled to
  // and leaving the page blank until the sentinel refilled it batch by batch.
  const modelKey = useMemo(
    () => models.slice(0, INITIAL_WINDOW).map((m) => m.id).join("|"),
    [models],
  );
  useEffect(() => {
    setWindowSize(INITIAL_WINDOW);
  }, [modelKey]);

  const visible = models.slice(0, windowSize);
  const hasMore = windowSize < models.length;

  useEffect(() => {
    if (!hasMore) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setWindowSize((n) => Math.min(n + WINDOW_STEP, models.length));
        }
      },
      // The page scrolls in .db-content, not the window, so the default root
      // measured against the wrong box and fired late. A lead of roughly a
      // screen and a half renders the next batch well before it is reached.
      { root: node.closest(".db-content"), rootMargin: "1200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, models.length]);

  const gridClass = `db-card-grid${columns === "three" ? " db-card-grid-3" : ""}`;

  if (loading && models.length === 0) {
    return (
      <div className={gridClass}>
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <CardSkeleton key={i} withMedia={withMedia} tall={tall} />
        ))}
      </div>
    );
  }

  if (models.length === 0) {
    return <>{empty}</>;
  }

  return (
    <>
      <div className={gridClass}>
        {visible.map((model, i) => (
          <DashboardCard
            key={model.id}
            model={model}
            onOpen={onOpen}
            tall={tall}
            // Stagger the first screenful only. A card windowed in later starts
            // from the animation's invisible state, so a delay there reads as
            // the blank gap this grid is meant to avoid.
            style={i < INITIAL_WINDOW ? { animationDelay: `${Math.min(i, 8) * 24}ms` } : undefined}
          />
        ))}
      </div>
      {hasMore && <div ref={sentinelRef} className="db-card-sentinel" aria-hidden="true" />}
    </>
  );
}
