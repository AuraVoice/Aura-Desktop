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
  onOpen,
  empty,
}: {
  models: CardModel[];
  loading: boolean;
  withMedia?: boolean;
  onOpen: (id: string) => void;
  empty: ReactNode;
}) {
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Reset the window whenever the underlying set identity changes (e.g. a range
  // switch on Conversations) so we never keep a huge window across datasets.
  const modelKey = useMemo(() => models.map((m) => m.id).join("|"), [models]);
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
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, models.length]);

  if (loading && models.length === 0) {
    return (
      <div className="db-card-grid">
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <CardSkeleton key={i} withMedia={withMedia} />
        ))}
      </div>
    );
  }

  if (models.length === 0) {
    return <>{empty}</>;
  }

  return (
    <>
      <div className="db-card-grid">
        {visible.map((model, i) => (
          <DashboardCard
            key={model.id}
            model={model}
            onOpen={onOpen}
            // Stagger the entrance a touch, but cap the delay so late items in a
            // freshly grown window don't wait noticeably.
            style={{ animationDelay: `${Math.min(i, 8) * 24}ms` }}
          />
        ))}
      </div>
      {hasMore && <div ref={sentinelRef} className="db-card-sentinel" aria-hidden="true" />}
    </>
  );
}
