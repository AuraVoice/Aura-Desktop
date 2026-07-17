import type { ReactNode } from "react";
import type { AsyncState } from "./useAsyncData";

interface DataViewProps<T> {
  state: AsyncState<T>;
  /** True when the loaded data has nothing to show. */
  isEmpty: (data: T) => boolean;
  emptyLabel: string;
  children: (data: T) => ReactNode;
  loadingLabel?: string;
  errorLabel?: string;
  showRetry?: boolean;
}

/** Renders the four standard states for an async data page: loading, error
 * (with retry), empty, and ready. Keeps every page's state handling identical. */
export function DataView<T>({
  state,
  isEmpty,
  emptyLabel,
  children,
  loadingLabel = "Loading...",
  errorLabel = "Couldn't load this right now.",
  showRetry = true,
}: DataViewProps<T>) {
  if (state.loading) {
    return <div className="db-state db-muted">{loadingLabel}</div>;
  }
  if (state.error || state.data === null) {
    return (
      <div className="db-state">
        <span className="db-muted">{errorLabel}</span>
        {showRetry && (
          <button type="button" className="db-link" onClick={state.reload}>
            Try again
          </button>
        )}
      </div>
    );
  }
  if (isEmpty(state.data)) {
    return <div className="db-empty">{emptyLabel}</div>;
  }
  return <>{children(state.data)}</>;
}
