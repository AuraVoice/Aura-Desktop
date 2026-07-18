/** Placeholder that matches the DashboardCard footprint so the grid does not
 * reflow when real cards replace it. `withMedia` mirrors the image-forward Saved
 * cards; the text-only variant matches Conversations and Drafts. */
export function CardSkeleton({
  withMedia = false,
  tall = false,
}: {
  withMedia?: boolean;
  tall?: boolean;
}) {
  return (
    <div className={`db-card2 db-card2-skeleton${tall ? " db-card2-tall" : ""}`} aria-hidden="true">
      {withMedia && <div className="db-shimmer db-card2-media-ph" />}
      <div className="db-shimmer db-skel-line db-skel-badge" />
      <div className="db-shimmer db-skel-line db-skel-title" />
      <div className="db-shimmer db-skel-line db-skel-meta" />
    </div>
  );
}
