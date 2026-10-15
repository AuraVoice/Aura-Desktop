import { useCallback, useEffect, useRef, useState } from "react";
import { Store } from "@tauri-apps/plugin-store";
import { emit, listen } from "@tauri-apps/api/event";
import {
  desktopOnboardingSeenKey,
  desktopOnboardingSeenForUidKey,
  overlayStorePath,
} from "../lib/copy";
import {
  trackOnboardingCompleted,
  trackOnboardingStepCompleted,
} from "../lib/acquisitionAnalytics";
import { logError } from "../lib/log";
import { syncProfileOnSignIn } from "../lib/profile";
import {
  DESKTOP_ONBOARDING_COMPLETED as ONBOARDING_COMPLETED_EVENT,
  DESKTOP_ONBOARDING_REPLAY as ONBOARDING_REPLAY_EVENT,
  DESKTOP_ONBOARDING_TOUR_ON_SCREEN as TOUR_ON_SCREEN_EVENT,
} from "../lib/ipcEvents";

export type OnboardingTailStatus = "unknown" | "active" | "done";

/** How often the dashboard says its tour is on screen, and how long the overlay
 * believes it. A heartbeat rather than a flag: a dashboard that is closed, hidden
 * or crashed simply stops sending, so the voice shortcut is back within seconds.
 * A flag that only cleared when the tour finished left the shortcut dead on every
 * launch for anyone who closed the window partway through. */
const TOUR_HEARTBEAT_MS = 2_000;
const TOUR_ON_SCREEN_TTL_MS = 5_000;

/** Dashboard side: send the heartbeat while this component is mounted and its
 * window is visible. */
export function useAnnounceTourOnScreen() {
  useEffect(() => {
    const beat = () => {
      if (document.visibilityState !== "visible") return;
      emit(TOUR_ON_SCREEN_EVENT).catch((err) => logError("useAnnounceTourOnScreen: emit", err));
    };
    beat();
    const timer = window.setInterval(beat, TOUR_HEARTBEAT_MS);
    return () => window.clearInterval(timer);
  }, []);
}

/** Overlay side: true while a heartbeat arrived within the last few seconds. */
export function useDashboardTourOnScreen(): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    let expiry: number | undefined;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen(TOUR_ON_SCREEN_EVENT, () => {
      setOnScreen(true);
      window.clearTimeout(expiry);
      expiry = window.setTimeout(() => setOnScreen(false), TOUR_ON_SCREEN_TTL_MS);
    })
      .then((fn) => {
        if (disposed) fn(); else unlisten = fn;
      })
      .catch((err) => logError("useDashboardTourOnScreen: listen", err));
    return () => {
      disposed = true;
      unlisten?.();
      window.clearTimeout(expiry);
    };
  }, []);
  return onScreen;
}

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
    let unlistenReplay: (() => void) | undefined;
    listen(ONBOARDING_REPLAY_EVENT, () => {
      if (uid) setStatus("active");
    })
      .then((fn) => {
        if (disposed) fn(); else unlistenReplay = fn;
      })
      .catch((err) => logError("useOnboardingTail: listen replay", err));
    return () => {
      disposed = true;
      unlisten?.();
      unlistenReplay?.();
    };
  }, [uid]);

  const complete = useCallback(() => {
    void (async () => {
      if (uid) {
        try {
          const store = storeRef.current ?? await Store.load(overlayStorePath);
          storeRef.current = store;
          await Promise.all([
            store.set(desktopOnboardingSeenForUidKey(uid), true),
            store.set(desktopOnboardingSeenKey, true),
          ]);
        } catch (err) {
          logError("useOnboardingTail: persist onboarding_seen", err);
        }
      }

      setStatus("done");
      await emit(ONBOARDING_COMPLETED_EVENT).catch((err) =>
        logError("useOnboardingTail: emit completion", err),
      );

      if (uid) {
        await trackOnboardingStepCompleted("agent_demo");
        await trackOnboardingCompleted();
        await syncProfileOnSignIn(uid);
      }
    })().catch((err) => logError("useOnboardingTail: complete", err));
  }, [uid]);

  const profileComplete = useCallback(() => {}, []);

  return { status, needsProfile: false, profileComplete, complete };
}
