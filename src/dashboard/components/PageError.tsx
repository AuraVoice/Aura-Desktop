/** Cold-failure state for a data page: shown only when a fetch failed and there
 * is no cached data to fall back on. Auth-expired failures get their own copy
 * (the main window's AuthProvider drives re-auth; a retry is still offered). */
export function PageError({
  authExpired,
  onRetry,
}: {
  authExpired: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="db-state">
      <span className="db-muted">
        {authExpired
          ? "Your session expired. Sign in again to see this."
          : "Couldn't load this right now."}
      </span>
      <button type="button" className="db-link" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
