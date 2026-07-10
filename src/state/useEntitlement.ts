import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import {
  fetchEntitlement,
  parseEntitlement,
  postCheckout,
  type CheckoutPeriod,
  type CheckoutTier,
  type Entitlement,
  type EntitlementStatus,
  type EntitlementTier,
} from "../lib/entitlement";
import { logError, logInfo } from "../lib/log";
import { trackEvent } from "../lib/analytics";

// The desktop has no push channel, so a periodic re-read (plus the next-launch
// read) is how renewals/downgrades land - SUBSCRIPTION_PLAN.md Flow 2's TTL
// channel. 12h matches the Rust cache's freshness window.
const REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000;

// Upgrade poll: the user pays in the system browser, so we re-read entitlement
// until the tier flips off "free". Bounded, so a closed/abandoned checkout
// stops polling on its own; a payment that lands later is still caught by the
// TTL refresh above.
const POLL_INITIAL_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_DEADLINE_MS = 10 * 60 * 1000;

/** Wire shape of the Rust `cached_entitlement` command: the stored JSON body
 * plus whether it is still < 12h old. */
interface CachedEntitlementResult {
  entitlement: unknown;
  fresh: boolean;
}

export type CheckoutPhase =
  | { phase: "idle" }
  | { phase: "opening" }
  | { phase: "polling" }
  | { phase: "upgraded" }
  | { phase: "error" };

export interface EntitlementState {
  loaded: boolean;
  tier: EntitlementTier;
  effectiveTier: EntitlementTier;
  status: EntitlementStatus | "unknown";
  trialDaysLeft: number;
  isTrialing: boolean;
  /** The purchased tier is paid (not merely trial-derived pro): drives the
   * "show Upgrade" vs "show plan only" split in the UI. */
  isPurchased: boolean;
  checkout: CheckoutPhase;
  startCheckout: (tier: CheckoutTier, period: CheckoutPeriod) => void;
  cancelCheckout: () => void;
  refresh: () => void;
}

function computeTrialDaysLeft(entitlement: Entitlement | null): number {
  if (!entitlement || entitlement.status !== "trialing" || !entitlement.trialEndDate) return 0;
  const end = Date.parse(entitlement.trialEndDate);
  if (Number.isNaN(end)) return 0;
  const ms = end - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

/**
 * Reads the account's entitlement on auth-ready and keeps it current. Seeds
 * instantly from the Rust offline cache (so the overlay never waits on the
 * network to show a plan), then fetches unless the cache is still fresh, and
 * writes the cache only after a successful fetch (the same "cache-after-success"
 * rule overlay.rs uses for its applied-presentation cache).
 *
 * Also owns the upgrade flow: create a checkout session, open it in the system
 * browser (mirroring useWebAuthSignIn), and poll entitlement until the tier
 * flips paid. The poll lives here (not in the menu component) so it survives the
 * kebab menu closing mid-checkout.
 */
export function useEntitlement({
  signedIn,
  uid,
}: {
  signedIn: boolean;
  uid: string | null;
}): EntitlementState {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [checkout, setCheckout] = useState<CheckoutPhase>({ phase: "idle" });

  const isMountedRef = useRef(true);
  const entitlementRef = useRef<Entitlement | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadlineRef = useRef<number | null>(null);

  const setEntitlementSafely = useCallback((next: Entitlement | null) => {
    entitlementRef.current = next;
    if (isMountedRef.current) setEntitlement(next);
  }, []);

  const setCheckoutSafely = useCallback((next: CheckoutPhase) => {
    if (isMountedRef.current) setCheckout(next);
  }, []);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  // The Rust cache is keyed by uid: a mismatch (previous account's leftover
  // entry) reads back as no-cache, so one machine's accounts can never see
  // each other's plan.
  const readCache = useCallback(async (): Promise<
    { entitlement: Entitlement; fresh: boolean } | null
  > => {
    if (!uid) return null;
    try {
      const cached = await invoke<CachedEntitlementResult | null>("cached_entitlement", { uid });
      if (!cached) return null;
      const parsed = parseEntitlement(cached.entitlement);
      if (!parsed) return null;
      return { entitlement: parsed, fresh: cached.fresh };
    } catch (err) {
      logError("useEntitlement: cached_entitlement", err);
      return null;
    }
  }, [uid]);

  // Fetch fresh + persist. Writes the Rust cache ONLY on success, so a failed
  // fetch never overwrites a good cached copy. Returns the fetched entitlement,
  // or null when the fetch failed or the session is gone.
  const fetchAndCache = useCallback(async (): Promise<Entitlement | null> => {
    let fetched: Entitlement;
    try {
      fetched = await fetchEntitlement();
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        // Session dead; the app's own auth flow handles routing. Leave the
        // last-known state rather than degrading noisily.
        logInfo("useEntitlement: fetch", "session expired, leaving entitlement state");
        return null;
      }
      logError("useEntitlement: fetch failed", err);
      return null;
    }
    setEntitlementSafely(fetched);
    setLoaded(true);
    if (uid) {
      invoke("cache_entitlement", { uid, entitlement: fetched.raw }).catch((err) =>
        logError("useEntitlement: cache_entitlement", err),
      );
    }
    return fetched;
  }, [setEntitlementSafely, uid]);

  const refresh = useCallback(async () => {
    const fetched = await fetchAndCache();
    if (fetched) return;
    // Fetch failed. Only fall back to the cache if nothing is shown yet - a
    // periodic-refresh blip must not wipe a good in-memory value.
    if (entitlementRef.current) return;
    const cached = await readCache();
    setEntitlementSafely(cached?.entitlement ?? null);
    setLoaded(true);
  }, [fetchAndCache, readCache, setEntitlementSafely]);

  // Cold start: show the cached copy immediately (even if stale, better than a
  // blank plan line), then fetch unless the cache is still fresh (< 12h) so a
  // relaunch within the TTL costs no backend read.
  const initialLoad = useCallback(async () => {
    const cached = await readCache();
    if (cached) {
      setEntitlementSafely(cached.entitlement);
      setLoaded(true);
      if (cached.fresh) return;
    }
    const fetched = await fetchAndCache();
    if (!fetched && !cached) {
      // No cache and the fetch failed: degrade to free, never blank/locked.
      setEntitlementSafely(null);
      setLoaded(true);
    }
  }, [readCache, fetchAndCache, setEntitlementSafely]);

  // ── Upgrade checkout + bounded poll ────────────────────────────────────────
  const pollUpgrade = useCallback(async () => {
    const deadline = deadlineRef.current;
    if (deadline !== null && Date.now() > deadline) {
      logInfo("useEntitlement: checkout", "poll deadline reached; a later payment is caught by the TTL refresh");
      trackEvent("desktop_checkout_deadline");
      setCheckoutSafely({ phase: "idle" });
      return;
    }
    const fetched = await fetchAndCache();
    if (fetched && fetched.tier !== "free") {
      logInfo("useEntitlement: checkout", `upgrade detected, tier=${fetched.tier}`);
      trackEvent("desktop_checkout_upgraded", { tier: fetched.tier });
      setCheckoutSafely({ phase: "upgraded" });
      return;
    }
    pollTimerRef.current = setTimeout(() => void pollUpgrade(), POLL_INTERVAL_MS);
  }, [fetchAndCache, setCheckoutSafely]);

  const startCheckout = useCallback(
    async (tier: CheckoutTier, period: CheckoutPeriod) => {
      clearPoll();
      setCheckoutSafely({ phase: "opening" });
      trackEvent("desktop_checkout_started", { tier, period });

      let url: string;
      try {
        url = await postCheckout(tier, period);
      } catch (err) {
        if (err instanceof AuthRequiredError) {
          await routeToDashboardForExpiredSession();
          setCheckoutSafely({ phase: "idle" });
          return;
        }
        logError("useEntitlement: postCheckout", err);
        setCheckoutSafely({ phase: "error" });
        return;
      }

      try {
        await openUrl(url);
      } catch (err) {
        logError("useEntitlement: openUrl checkout", err);
        setCheckoutSafely({ phase: "error" });
        return;
      }

      deadlineRef.current = Date.now() + POLL_DEADLINE_MS;
      setCheckoutSafely({ phase: "polling" });
      pollTimerRef.current = setTimeout(() => void pollUpgrade(), POLL_INITIAL_DELAY_MS);
    },
    [clearPoll, pollUpgrade, setCheckoutSafely],
  );

  const cancelCheckout = useCallback(() => {
    clearPoll();
    deadlineRef.current = null;
    setCheckoutSafely({ phase: "idle" });
  }, [clearPoll, setCheckoutSafely]);

  // Load on auth-ready; fully reset on sign-out, including the on-disk Rust
  // cache so the next account on this machine starts from nothing. A 12h
  // interval catches renewals/downgrades while the app stays open. `uid` is in
  // the deps so an account switch (sign-out then sign-in) re-runs initialLoad
  // against the new account's cache key.
  useEffect(() => {
    if (!signedIn) {
      clearPoll();
      deadlineRef.current = null;
      entitlementRef.current = null;
      setEntitlement(null);
      setLoaded(false);
      setCheckout({ phase: "idle" });
      void invoke("clear_entitlement_cache").catch((err) =>
        logError("useEntitlement: clear_entitlement_cache", err),
      );
      return;
    }
    void initialLoad();
    const id = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [signedIn, uid, initialLoad, refresh, clearPoll]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearPoll();
    };
  }, [clearPoll]);

  return {
    loaded,
    tier: entitlement?.tier ?? "free",
    effectiveTier: entitlement?.effectiveTier ?? "free",
    status: entitlement?.status ?? "unknown",
    trialDaysLeft: computeTrialDaysLeft(entitlement),
    isTrialing: entitlement?.status === "trialing",
    isPurchased: (entitlement?.tier ?? "free") !== "free",
    checkout,
    startCheckout: (tier, period) => void startCheckout(tier, period),
    cancelCheckout,
    refresh: () => void refresh(),
  };
}
