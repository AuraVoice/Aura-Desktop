import { useEffect, useState } from "react";
import { Room, RoomEvent } from "livekit-client";
import { fetchVoiceToken } from "../lib/voice";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { logError } from "../lib/log";

export type VoiceStatus = "connecting" | "connected" | "error" | "disconnected";

const SILENCE_WATCHDOG_MS = 15000;

/**
 * Joins the user's LiveKit voice room for the lifetime of the mounted
 * component (avatar mode) and leaves on unmount. A 15s watchdog turns a
 * hung connection attempt into a visible error instead of a silent spinner.
 */
export function useVoiceSession() {
  const [status, setStatus] = useState<VoiceStatus>("connecting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const room = new Room();
    let watchdog: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      watchdog = null;
      logError("useVoiceSession", "connection timed out after 15s");
      if (!cancelled) {
        setStatus("error");
        setError("Connection timed out. Try again.");
      }
    }, SILENCE_WATCHDOG_MS);

    function clearWatchdog() {
      if (watchdog) {
        clearTimeout(watchdog);
        watchdog = null;
      }
    }

    room.on(RoomEvent.Disconnected, () => {
      clearWatchdog();
      if (!cancelled) setStatus("disconnected");
    });

    (async () => {
      try {
        const { token, url } = await fetchVoiceToken();
        if (cancelled) return;
        await room.connect(url, token);
        if (cancelled) return;
        await room.localParticipant.setMicrophoneEnabled(true);
        clearWatchdog();
        if (!cancelled) setStatus("connected");
      } catch (err) {
        clearWatchdog();
        if (err instanceof AuthRequiredError) {
          routeToDashboardForExpiredSession();
          return;
        }
        logError("useVoiceSession", err);
        if (!cancelled) {
          setStatus("error");
          setError("Couldn't start voice. Try again.");
        }
      }
    })();

    return () => {
      cancelled = true;
      clearWatchdog();
      room.disconnect();
    };
  }, []);

  return { status, error };
}
