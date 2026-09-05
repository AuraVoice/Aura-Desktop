import { useCallback, useEffect, useRef, useState } from "react";
import {
  discardChatCapture,
  refreshChatCapture,
  screenAttachment,
  takeChatCapture,
  toBase64,
  type ChatAttachment,
  type ChatScreenCapture,
} from "../lib/chatScreenCapture";
import { logError } from "../lib/log";

/**
 * Past this age the frame under the composer no longer describes what the user
 * is looking at, so send re-captures first. Long enough that reading a reply and
 * typing a follow-up does not trigger it, short enough that a message left
 * half-typed while the user works elsewhere does not ship a stale screen.
 */
const STALE_AFTER_MS = 60_000;

const EXPLICIT_SCREEN_SAVE_REQUEST =
  /\b(?:save|capture|keep|remember)\s+(?:(?:this|the|my|current)\s+)?(?:screen|screenshot)\b|\b(?:take|save)\s+(?:a\s+)?screenshot\b|\bscreenshot\s+(?:this|that|it)\b/i;

export interface ChatScreenState {
  /** Whether the next message carries the screen. */
  armed: boolean;
  /** The user's standing choice (GeneralSettings.chatScreenshots). False means
   * the composer must not offer the attachment at all. */
  enabled: boolean;
  /** Object URL for the chip's thumbnail, null while nothing is captured. */
  previewUrl: string | null;
  /** False when capture is unavailable (Guide Mode owns the screen, or the
   * chat was opened without a frame ever being taken). */
  available: boolean;
  /** Why the last arm produced no picture, or null. Arming used to fail
   * silently: the eye lit up, no thumbnail appeared, and the message went out
   * with no attachment and no warning, which is how a completely broken macOS
   * capture path went unnoticed. */
  error: string | null;
  toggle: () => void;
  remove: () => void;
}

/**
 * Owns the chat's screen attachment: the armed bit, the thumbnail the user
 * checks before sending, and the resolver that turns the pending frame into a
 * /chat attachment at send time.
 *
 * Rust remembers the monitor at summon (see overlay::summon_chat), but no
 * pixels are captured until the user turns the attachment on.
 *
 * `enabled` is the standing preference above that per-message arm. Off means no
 * path in here captures anything, including the explicit-request phrase, which
 * is what lets the settings switch be described as a real off.
 */
export function useChatScreenCapture(open: boolean, enabled: boolean) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [capture, setCapture] = useState<ChatScreenCapture | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const captureRef = useRef<ChatScreenCapture | null>(null);
  const armedRef = useRef(armed);
  const enabledRef = useRef(enabled);
  captureRef.current = capture;
  armedRef.current = armed;
  enabledRef.current = enabled;

  // One owner for the object URL: whatever replaces the capture revokes the URL
  // it is replacing, so a session of re-arms cannot leak blobs.
  const adoptCapture = useCallback((next: ChatScreenCapture | null) => {
    setCapture(next);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      if (!next) return null;
      return URL.createObjectURL(new Blob([next.bytes as BlobPart], { type: "image/jpeg" }));
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Normally empty because chat screenshots start off. Collecting here also
    // handles a capture that completed just before this surface remounted.
    takeChatCapture()
      .then((next) => {
        if (!cancelled) adoptCapture(next);
      })
      .catch((err) => logError("useChatScreenCapture: take", err));
    return () => {
      cancelled = true;
    };
  }, [open, adoptCapture]);

  // Closing the slot drops both the preview and Rust's copy: a frame nobody is
  // looking at any more must not sit in memory waiting for the next summon.
  // Skipped until the slot has actually been open once, so mounting the overlay
  // does not fire a discard for a capture that was never taken.
  const openedOnceRef = useRef(false);
  if (open) openedOnceRef.current = true;
  useEffect(() => {
    if (open || !openedOnceRef.current) return;
    adoptCapture(null);
    setArmed(false);
    discardChatCapture().catch((err) => logError("useChatScreenCapture: discard on close", err));
  }, [open, adoptCapture]);

  // Turning the preference off mid-compose has to drop whatever is already
  // pending, not just stop the next arm: a frame captured a second before the
  // switch moved must never ride the next message. Same three steps as the
  // close path above.
  useEffect(() => {
    if (enabled) return;
    adoptCapture(null);
    setArmed(false);
    setError(null);
    discardChatCapture().catch((err) => logError("useChatScreenCapture: discard on disable", err));
  }, [enabled, adoptCapture]);

  useEffect(() => {
    return () => {
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    };
  }, []);

  const toggle = useCallback(() => {
    if (!enabledRef.current) return;
    const next = !armedRef.current;
    setArmed(next);
    setError(null);
    if (!next) return;
    // Re-arming asks for a fresh look rather than resurrecting whatever was
    // captured before the user turned it off.
    refreshChatCapture()
      .then(takeChatCapture)
      .then(adoptCapture)
      .catch((err) => {
        logError("useChatScreenCapture: refresh", err);
        // Disarm too: leaving the eye lit while nothing was captured is what
        // made this look like it had worked.
        setArmed(false);
        armedRef.current = false;
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [adoptCapture]);

  const remove = useCallback(() => {
    setArmed(false);
    setError(null);
    adoptCapture(null);
    discardChatCapture().catch((err) => logError("useChatScreenCapture: discard", err));
  }, [adoptCapture]);

  /**
   * The attachment for the message being sent, or an empty list. Never throws:
   * a message must still go out when the screen cannot be captured, just
   * without the picture.
   *
   * One-shot by design - the attachment clears itself after a send, so a
   * follow-up like "make that shorter" does not silently ship a second
   * screenshot the user never asked for.
   */
  const resolveForSend = useCallback(async (message: string): Promise<ChatAttachment[]> => {
    // Before the explicit-request test on purpose: a phrase that can walk around
    // the preference would make the settings switch a lie.
    if (!enabledRef.current) return [];
    const explicitlyRequested = EXPLICIT_SCREEN_SAVE_REQUEST.test(message);
    if (!armedRef.current && !explicitlyRequested) return [];
    try {
      let pending = captureRef.current;
      if (explicitlyRequested || !pending || Date.now() - pending.capturedAtMs > STALE_AFTER_MS) {
        await refreshChatCapture();
        pending = await takeChatCapture();
      }
      if (!pending) {
        if (explicitlyRequested) throw new Error("Aura could not capture the current screen");
        return [];
      }
      const data = await toBase64(pending.bytes);
      return [screenAttachment(data)];
    } catch (err) {
      logError("useChatScreenCapture: resolveForSend", err);
      if (explicitlyRequested) throw err;
      return [];
    } finally {
      setArmed(false);
      armedRef.current = false;
      adoptCapture(null);
      discardChatCapture().catch((err) => logError("useChatScreenCapture: discard after send", err));
    }
  }, [adoptCapture]);

  const state: ChatScreenState = {
    armed,
    enabled,
    previewUrl,
    error,
    available: capture !== null,
    toggle,
    remove,
  };

  return { state, resolveForSend };
}
