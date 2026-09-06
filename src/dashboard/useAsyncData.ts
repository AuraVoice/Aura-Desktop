import { useCallback, useEffect, useState } from "react";
import { logError } from "../lib/log";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
  reload: () => void;
  /** Applies a local change without refetching. For mutations whose result is
   * already known - flipping one row's flag - where a reload would re-fetch and
   * re-decrypt the whole collection to learn something the caller just did.
   *
   * Optional because AsyncState is also satisfied structurally by hand-built
   * objects and by ResourceHandle, neither of which can apply a local edit. */
  mutate?: (update: (current: T | null) => T | null) => void;
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
  const mutate = useCallback(
    (update: (current: T | null) => T | null) => setData((current) => update(current)),
    [],
  );

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

  return { data, loading, error, reload, mutate };
}
