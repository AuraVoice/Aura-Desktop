import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "../lib/firebase";
import { startWebAuth, pollWebAuthStatusOnce } from "../lib/api";
import { webAuthUrl } from "../lib/copy";
import { logError, logInfo } from "../lib/log";
import { trackEvent } from "../lib/analytics";

// An OAuth round trip in a real browser realistically takes several seconds
// minimum (choosing an account, maybe 2FA) - polling immediately would just
// waste a round trip.
const INITIAL_POLL_DELAY_MS = 3_000;
const POLL_INTERVAL_MS = 2_000;
// Independent client-side budget on top of the server's own TTL, so a clock
// skew or a slow last poll never leaves the UI waiting forever.
const DEADLINE_BUFFER_SECONDS = 20;

export type WebAuthState =
  | { phase: "idle" }
  | { phase: "opening" }
  | { phase: "waiting" }
  | { phase: "signing_in" }
  | { phase: "expired" }
  | { phase: "failed"; reason: string }
  | { phase: "error" };

/**
 * Desktop-initiated browser sign-up handshake: request a session code, open
 * the system browser to it, then poll until Aura-Web reports the browser leg
 * done - a self-rescheduling setTimeout loop (not setInterval, matching
 * useVoiceBar's watchdog idiom), so one slow tick never overlaps the next.
 *
 * On completion, signInWithCustomToken alone is enough - AuthProvider's
 * existing onAuthStateChanged listener takes it from there, and the
 * component using this hook unmounts on its own once useAuth().user flips.
 * Deliberately never force-focuses the window (no invoke("summon")): the
 * confirmation lives in the browser tab, and the user returns manually.
 */
export function useWebAuthSignIn() {
  const [state, setState] = useState<WebAuthState>({ phase: "idle" });
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const codeRef = useRef<string | null>(null);
  const deadlineMsRef = useRef<number | null>(null);
  const isMountedRef = useRef(true);

  const clearPollTimer = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const safeSetState = useCallback((next: WebAuthState) => {
    if (isMountedRef.current) setState(next);
  }, []);

  const poll = useCallback(async () => {
    const code = codeRef.current;
    const deadline = deadlineMsRef.current;
    if (!code || deadline === null) return;

    if (Date.now() > deadline) {
      logInfo("useWebAuthSignIn: poll", "client-side deadline exceeded, showing expired");
      trackEvent("web_auth_expired", { reason: "client_deadline" });
      safeSetState({ phase: "expired" });
      return;
    }

    let result;
    try {
      result = await pollWebAuthStatusOnce(code);
    } catch (err) {
      // Transport blip (network/timeout): swallow and reschedule. Only the
      // overall deadline above ends the flow, never a single failed tick.
      logError("useWebAuthSignIn: poll transport error", err);
      pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    if (result.status === "pending") {
      pollTimerRef.current = setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    if (result.status === "completed") {
      safeSetState({ phase: "signing_in" });
      try {
        await signInWithCustomToken(auth, result.customToken);
        logInfo("useWebAuthSignIn: poll", "signed in via web-auth handshake");
        trackEvent("web_auth_completed");
      } catch (err) {
        logError("useWebAuthSignIn: signInWithCustomToken failed", err);
        trackEvent("web_auth_failed", { reason: "custom_token_exchange" });
        safeSetState({ phase: "error" });
      }
      return;
    }

    if (result.status === "failed") {
      logInfo("useWebAuthSignIn: poll", `session failed, reason=${result.reason}`);
      trackEvent("web_auth_failed", { reason: result.reason });
      safeSetState({ phase: "failed", reason: result.reason });
      return;
    }

    // expired | not_found: both read as "this link is no longer good".
    logInfo("useWebAuthSignIn: poll", `session ${result.status}, showing expired`);
    trackEvent("web_auth_expired", { reason: result.status });
    safeSetState({ phase: "expired" });
  }, [safeSetState]);

  const start = useCallback(async () => {
    clearPollTimer();
    safeSetState({ phase: "opening" });
    try {
      const { code, expiresInSeconds } = await startWebAuth();
      codeRef.current = code;
      deadlineMsRef.current = Date.now() + (expiresInSeconds + DEADLINE_BUFFER_SECONDS) * 1000;

      await openUrl(`${webAuthUrl}?session=${encodeURIComponent(code)}`);

      logInfo("useWebAuthSignIn: start", `browser opened, session expires in ${expiresInSeconds}s`);
      trackEvent("web_auth_started", { expiresInSeconds });

      safeSetState({ phase: "waiting" });
      pollTimerRef.current = setTimeout(poll, INITIAL_POLL_DELAY_MS);
    } catch (err) {
      logError("useWebAuthSignIn: start failed", err);
      trackEvent("web_auth_failed", { reason: "start_or_open_browser" });
      safeSetState({ phase: "error" });
    }
  }, [clearPollTimer, poll, safeSetState]);

  const cancel = useCallback(() => {
    if (codeRef.current) {
      logInfo("useWebAuthSignIn: cancel", "user cancelled an in-flight web-auth session");
      trackEvent("web_auth_cancelled");
    }
    clearPollTimer();
    codeRef.current = null;
    deadlineMsRef.current = null;
    safeSetState({ phase: "idle" });
  }, [clearPollTimer, safeSetState]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      clearPollTimer();
    };
  }, [clearPollTimer]);

  return { state, start, cancel };
}
