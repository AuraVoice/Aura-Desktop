import { relativeTime } from "../format";

/** Small, non-blocking header affordance: a live "Refreshing…" while a
 * background revalidate runs, a quiet "Couldn't refresh" when the last one
 * failed but cached data is still shown, or "Updated <relative>" otherwise. */
export function RefreshIndicator({
  refreshing,
  stale,
  cachedAt,
  onRetry,
}: {
  refreshing: boolean;
  stale: boolean;
  cachedAt: number | null;
  onRetry: () => void;
}) {
  if (refreshing) {
    return (
      <span className="db-refresh">
        <span className="db-refresh-dot" /> Refreshing…
      </span>
    );
  }
  if (stale) {
    return (
      <span className="db-refresh db-refresh-stale">
        Couldn&apos;t refresh
        <button type="button" className="db-link" onClick={onRetry}>
          Retry
        </button>
      </span>
    );
  }
  if (cachedAt != null) {
    return <span className="db-refresh db-refresh-muted">Updated {relativeTime(new Date(cachedAt).toISOString())}</span>;
  }
  return null;
}
