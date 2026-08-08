import { useCallback, useEffect, useRef, useState } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";
import {
  desktopOnboardingSeenKey,
  desktopOnboardingSeenForUidKey,
  overlayStorePath,
} from "../lib/copy";
import { logError } from "../lib/log";

export type OnboardingTailStatus = "unknown" | "active" | "done";

const ONBOARDING_COMPLETED_EVENT = "desktop-onboarding-completed";

/** Decides whether the post-sign-in onboarding tail (hotkey tour + live demo)
 * should run. It's active only for desktop first-run: signed in and this UID
 * has not completed desktop onboarding on this install. Account profile
 * questions belong to mobile/account onboarding and must not block desktop
 * activation. A returning user resolves straight to "done". `complete()` writes the
 * onboarding_seen flag - the single point where first-run is marked finished,
 * moved here from the old sign-in step so an interrupted run resumes. */
export function useOnboardingTail(uid: string | null) {
  const [status, setStatus] = useState<OnboardingTailStatus>("unknown");
  const storeRef = useRef<Store | null>(null);

  useEffect(() => {
    if (!uid) {
      setStatus("unknown");
      return;
    }
    let cancelled = false;
    Store.load(overlayStorePath)
      .then(async (store) => {
        storeRef.current = store;
        const seen = await store.get<boolean>(desktopOnboardingSeenForUidKey(uid));
        if (cancelled) return;
        setStatus(!seen ? "active" : "done");
      })
      .catch((err) => {
        logError("useOnboardingTail: load store", err);
        if (!cancelled) setStatus("done");
      });
    return () => {
      cancelled = true;
    };
  }, [uid]);

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
    if (uid) {
      void (async () => {
        const store = storeRef.current ?? await Store.load(overlayStorePath);
        storeRef.current = store;
        await Promise.all([
          store.set(desktopOnboardingSeenForUidKey(uid), true),
          store.set(desktopOnboardingSeenKey, true),
        ]);
      })().catch((err) => logError("useOnboardingTail: persist onboarding_seen", err));
    }
    setStatus("done");
    void emit(ONBOARDING_COMPLETED_EVENT).catch((err) =>
      logError("useOnboardingTail: emit completion", err),
    );
  }, [uid]);

  const profileComplete = useCallback(() => {}, []);

  return { status, needsProfile: false, profileComplete, complete };
}
