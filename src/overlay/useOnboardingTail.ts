import { useCallback, useEffect, useRef, useState } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";
import {
  desktopOnboardingSeenKey,
  desktopRoleKey,
  desktopWhereHeardKey,
  overlayStorePath,
} from "../lib/copy";
import { logError } from "../lib/log";
import type { StoredAnswer } from "../lib/profile";

export type OnboardingTailStatus = "unknown" | "active" | "done";

const ONBOARDING_COMPLETED_EVENT = "desktop-onboarding-completed";

/** Decides whether the post-sign-in onboarding tail (hotkey tour + live demo)
 * should run. It's active only for a genuine first-run: signed in, onboarding
 * not yet marked complete, and the questions already answered (role present).
 * A returning user resolves straight to "done". `complete()` writes the
 * onboarding_seen flag - the single point where first-run is marked finished,
 * moved here from the old sign-in step so an interrupted run resumes. */
export function useOnboardingTail(signedIn: boolean) {
  const [status, setStatus] = useState<OnboardingTailStatus>("unknown");
  const [needsProfile, setNeedsProfile] = useState(false);
  const storeRef = useRef<Store | null>(null);

  useEffect(() => {
    if (!signedIn) {
      setStatus("unknown");
      setNeedsProfile(false);
      return;
    }
    let cancelled = false;
    Store.load(overlayStorePath)
      .then(async (store) => {
        storeRef.current = store;
        const seen = await store.get<boolean>(desktopOnboardingSeenKey);
        const whereHeard = await store.get<StoredAnswer>(desktopWhereHeardKey);
        const role = await store.get<StoredAnswer>(desktopRoleKey);
        if (cancelled) return;
        setNeedsProfile(!whereHeard || !role);
        setStatus(!seen ? "active" : "done");
      })
      .catch((err) => {
        logError("useOnboardingTail: load store", err);
        if (!cancelled) setStatus("done");
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen(ONBOARDING_COMPLETED_EVENT, () => setStatus("done"))
      .then((fn) => {
        if (disposed) fn(); else unlisten = fn;
      })
      .catch((err) => logError("useOnboardingTail: listen completion", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const complete = useCallback(() => {
    storeRef.current?.set(desktopOnboardingSeenKey, true).catch((err) =>
      logError("useOnboardingTail: persist onboarding_seen", err),
    );
    setStatus("done");
    void emit(ONBOARDING_COMPLETED_EVENT).catch((err) =>
      logError("useOnboardingTail: emit completion", err),
    );
  }, []);

  const profileComplete = useCallback(() => {
    setNeedsProfile(false);
  }, []);

  return { status, needsProfile, profileComplete, complete };
}
