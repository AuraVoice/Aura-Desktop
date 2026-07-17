import { useCallback, useEffect, useState } from "react";
import { logError } from "../lib/log";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
}

/** Runs an async fetcher on mount, exposing loading/error/data plus a reload.
 * Failures are logged and surfaced as `error` so pages render an error state
 * rather than throwing. `label` only names the log line. */
export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  label: string,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetcher()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        logError(`dashboard: ${label}`, err);
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // fetcher is intentionally not a dep: pages pass an inline closure that is
    // stable in intent; `nonce` drives explicit reloads and `label` is static.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, label]);

  return { data, loading, error, reload };
}
