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

export interface ChatScreenState {
  /** Whether the next message carries the screen. */
  armed: boolean;
  /** Object URL for the chip's thumbnail, null while nothing is captured. */
  previewUrl: string | null;
  /** False when capture is unavailable (Guide Mode owns the screen, or the
   * chat was opened without a frame ever being taken). */
  available: boolean;
  toggle: () => void;
  remove: () => void;
}

/**
 * Owns the chat's screen attachment: the armed bit, the thumbnail the user
 * checks before sending, and the resolver that turns the pending frame into a
 * /chat attachment at send time.
 *
 * Rust captures the frame at summon (see overlay::summon_chat), so this hook
 * never triggers the first capture - it collects one that already exists. That
 * is what keeps the picture pointed at the app the user left rather than at the
 * overlay, and it means the capture cost overlaps with the user typing.
 */
export function useChatScreenCapture(open: boolean) {
  const [armed, setArmed] = useState(true);
  const [capture, setCapture] = useState<ChatScreenCapture | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const captureRef = useRef<ChatScreenCapture | null>(null);
  const armedRef = useRef(armed);
  captureRef.current = capture;
  armedRef.current = armed;

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
    // The frame is normally already waiting; if the capture is still running
    // this simply returns null and the chip stays hidden, which is the honest
    // answer rather than a spinner over an empty box.
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
    setArmed(true);
    discardChatCapture().catch((err) => logError("useChatScreenCapture: discard on close", err));
  }, [open, adoptCapture]);

  useEffect(() => {
    return () => {
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
    };
  }, []);

  const toggle = useCallback(() => {
    const next = !armedRef.current;
    setArmed(next);
    if (!next) return;
    // Re-arming asks for a fresh look rather than resurrecting whatever was
    // captured before the user turned it off.
    refreshChatCapture()
      .then(takeChatCapture)
      .then(adoptCapture)
      .catch((err) => logError("useChatScreenCapture: refresh", err));
  }, [adoptCapture]);

  const remove = useCallback(() => {
    setArmed(false);
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
  const resolveForSend = useCallback(async (): Promise<ChatAttachment[]> => {
    if (!armedRef.current) return [];
    try {
      let pending = captureRef.current;
      if (!pending || Date.now() - pending.capturedAtMs > STALE_AFTER_MS) {
        await refreshChatCapture();
        pending = await takeChatCapture();
      }
      if (!pending) return [];
      const data = await toBase64(pending.bytes);
      return [screenAttachment(data)];
    } catch (err) {
      logError("useChatScreenCapture: resolveForSend", err);
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
    previewUrl,
    available: capture !== null,
    toggle,
    remove,
  };

  return { state, resolveForSend };
}
