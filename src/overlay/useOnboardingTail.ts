import { useCallback, useEffect, useRef, useState } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { desktopOnboardingSeenKey, desktopRoleKey, overlayStorePath } from "../lib/copy";
import { logError } from "../lib/log";
import type { StoredAnswer } from "../lib/profile";

export type OnboardingTailStatus = "unknown" | "active" | "done";

/** Decides whether the post-sign-in onboarding tail (hotkey tour + live demo)
 * should run. It's active only for a genuine first-run: signed in, onboarding
 * not yet marked complete, and the questions already answered (role present).
 * A returning user resolves straight to "done". `complete()` writes the
 * onboarding_seen flag - the single point where first-run is marked finished,
 * moved here from the old sign-in step so an interrupted run resumes. */
export function useOnboardingTail(signedIn: boolean) {
  const [status, setStatus] = useState<OnboardingTailStatus>("unknown");
  const storeRef = useRef<Store | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setStatus("unknown");
      return;
    }
    let cancelled = false;
    Store.load(overlayStorePath)
      .then(async (store) => {
        storeRef.current = store;
        const seen = await store.get<boolean>(desktopOnboardingSeenKey);
        const role = await store.get<StoredAnswer>(desktopRoleKey);
        if (cancelled) return;
        setStatus(!seen && role ? "active" : "done");
      })
      .catch((err) => {
        logError("useOnboardingTail: load store", err);
        if (!cancelled) setStatus("done");
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  const complete = useCallback(() => {
    storeRef.current?.set(desktopOnboardingSeenKey, true).catch((err) =>
      logError("useOnboardingTail: persist onboarding_seen", err),
    );
    setStatus("done");
  }, []);

  return { status, complete };
}
