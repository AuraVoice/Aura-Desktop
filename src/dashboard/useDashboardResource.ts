import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AuthRequiredError } from "../lib/api";
import {
  dashboardCacheKey,
  readCache,
  writeCache,
  type CacheEntry,
} from "../lib/dashboardCache";
import { logError } from "../lib/log";

/**
 * Stale-while-revalidate data hook for the dashboard, built for a production
 * bar: two-tier cache (in-memory over disk), a freshness gate that avoids
 * redundant loads, single-flight de-duplication, a hard timeout so a request
 * can never hang, and an out-of-order guard so the newest fetch always wins.
 *
 * Lifecycle on mount / key change:
 *  1. Paint instantly from the in-memory tier if present (no skeleton flash on
 *     tab revisit), else fall back to disk, else show a cold skeleton.
 *  2. If the seeded snapshot is younger than `freshnessMs`, stop - no network.
 *  3. Otherwise revalidate in the background (single-flight, timed out) and
 *     reconcile; on failure keep the last-good data marked `stale`.
 *
 * The network request is driven by an internal AbortController + timeout, not
 * by the component, so unmount/key-change simply stop listening (the in-flight
 * result still lands in the cache for next time) and a slow endpoint always
 * settles instead of hanging.
 */

const DEFAULT_FRESHNESS_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

// Module-level tiers, shared across every mount in this window's JS context.
const memory = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const DashboardResourceScopeContext = createContext<string | null>(null);

export function DashboardResourceScope({
  uid,
  children,
}: {
  uid: string;
  children?: ReactNode;
}) {
  return createElement(DashboardResourceScopeContext.Provider, { value: uid }, children);
}

/** The authenticated uid the dashboard is scoped to, for hooks that manage
 * their own cache entries outside useDashboardResource. */
export function useDashboardScopeUid(): string {
  const uid = useContext(DashboardResourceScopeContext);
  if (!uid) throw new Error("useDashboardScopeUid requires an authenticated dashboard scope");
  return uid;
}

export interface ResourceState<T> {
  data: T | null;
  /** Cold load with nothing to show yet - render skeletons. */
  loading: boolean;
  /** Hard failure with no cached data to fall back on. */
  error: boolean;
  /** The failure was an expired/absent session (401/403). */
  authExpired: boolean;
  /** Showing cached data because the last revalidate failed. */
  stale: boolean;
  /** A background revalidate is in flight over existing data. */
  refreshing: boolean;
  cachedAt: number | null;
}

export interface ResourceHandle<T> extends ResourceState<T> {
  reload: () => void;
}

export interface ResourceOptions<T> {
  freshnessMs?: number;
  /** Transform applied to the payload before it is persisted to disk - used to
   * strip ephemeral fields (e.g. signed image URLs) that must never be cached. */
  toCache?: (data: T) => T;
}

function runSingleFlight<T>(
  key: string,
  factory: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("Request timed out", "TimeoutError")),
    REQUEST_TIMEOUT_MS,
  );
  const promise = factory(controller.signal).finally(() => {
    clearTimeout(timer);
    inflight.delete(key);
  });
  inflight.set(key, promise);
  return promise;
}

function seed<T>(key: string): ResourceState<T> {
  const mem = memory.get(key) as CacheEntry<T> | undefined;
  if (mem) {
    return {
      data: mem.data,
      loading: false,
      error: false,
      authExpired: false,
      stale: false,
      refreshing: false,
      cachedAt: mem.cachedAt,
    };
  }
  return {
    data: null,
    loading: true,
    error: false,
    authExpired: false,
    stale: false,
    refreshing: false,
    cachedAt: null,
  };
}

export function useDashboardResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: ResourceOptions<T>,
): ResourceHandle<T> {
  const uid = useContext(DashboardResourceScopeContext);
  if (!uid) throw new Error("useDashboardResource requires an authenticated dashboard scope");
  const scopedKey = useMemo(() => dashboardCacheKey(uid, key), [uid, key]);
  const freshnessMs = options?.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const [state, setState] = useState<ResourceState<T>>(() => seed<T>(scopedKey));

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const toCacheRef = useRef(options?.toCache);
  toCacheRef.current = options?.toCache;

  const forcedRef = useRef(false);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    forcedRef.current = true;
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const forced = forcedRef.current;
    forcedRef.current = false;

    // Re-seed synchronously for the current key (covers key switches).
    setState(seed<T>(scopedKey));

    (async () => {
      let entry = memory.get(scopedKey) as CacheEntry<T> | undefined;

      if (!entry) {
        const disk = await readCache<T>(scopedKey);
        if (cancelled) return;
        if (disk) {
          memory.set(scopedKey, disk);
          entry = disk;
          setState({
            data: disk.data,
            loading: false,
            error: false,
            authExpired: false,
            stale: false,
            refreshing: false,
            cachedAt: disk.cachedAt,
          });
        }
      }

      // Freshness gate: recent enough, and not an explicit reload -> no network.
      const isFresh = entry != null && Date.now() - entry.cachedAt < freshnessMs;
      if (isFresh && !forced) return;

      const hadData = entry != null;
      setState((s) => ({ ...s, refreshing: hadData, loading: !hadData }));

      try {
        const data = await runSingleFlight(scopedKey, (signal) => fetcherRef.current(signal));
        const cachedAt = Date.now();
        memory.set(scopedKey, { data, cachedAt });
        const persist = toCacheRef.current ? toCacheRef.current(data) : data;
        void writeCache(scopedKey, persist, cachedAt);
        if (cancelled) return;
        setState({
          data,
          loading: false,
          error: false,
          authExpired: false,
          stale: false,
          refreshing: false,
          cachedAt,
        });
      } catch (err) {
        if (cancelled) return;
        const authExpired = err instanceof AuthRequiredError;
        if (!authExpired) logError(`dashboard: ${key}`, err);
        setState((s) =>
          hadData
            ? { ...s, refreshing: false, stale: true, authExpired }
            : {
                data: null,
                loading: false,
                error: true,
                authExpired,
                stale: false,
                refreshing: false,
                cachedAt: null,
              },
        );
      }
    })();

    return () => {
      cancelled = true;
    };
    // fetcher/toCache are read through refs; key/tick/freshness drive re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, scopedKey, tick, freshnessMs]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const revalidateIfStale = () => {
      const entry = memory.get(scopedKey);
      if (entry && Date.now() - entry.cachedAt < freshnessMs) return;
      setTick((value) => value + 1);
    };
    window.addEventListener("focus", revalidateIfStale);
    return () => window.removeEventListener("focus", revalidateIfStale);
  }, [scopedKey, freshnessMs]);

  return { ...state, reload };
}
