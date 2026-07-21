import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logError } from "../lib/log";
import type { NotchDragHandlers } from "./NotchBar";

// Moving the pointer this far while pressed starts the move. Small enough that
// dragging the notch feels immediate, large enough that a plain click (the
// notch has no other click action today) never triggers it.
const DRAG_THRESHOLD_PX = 6;

export interface NotchMoveController {
  dragHandlers: NotchDragHandlers;
}

interface PressState {
  pointerId: number;
  startX: number;
  startY: number;
}

/**
 * Drag-to-move gesture for the notch. Pressing the pill and moving past
 * DRAG_THRESHOLD_PX asks Rust to take over the display (`begin_notch_move`);
 * the fullscreen NotchMoveOverlay then handles the drag + snap. Releasing
 * without moving is a no-op, so nothing changes on an ordinary click.
 * `enabled` gates the gesture off unless the notch is the resting bar.
 */
export function useNotchMove(enabled: boolean): NotchMoveController {
  const pressRef = useRef<PressState | null>(null);
  const begunRef = useRef(false);

  const clearPress = useCallback(() => {
    pressRef.current = null;
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.button !== 0) return;
      pressRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
      begunRef.current = false;
      // Capture so the drag keeps streaming moves to the shell even when the
      // cursor leaves the 29px pill before crossing the threshold. try/catch:
      // jsdom (tests) has no setPointerCapture.
      try {
        (event.currentTarget as Element).setPointerCapture(event.pointerId);
      } catch {
        // No pointer capture available; onPointerLeave clearing covers it.
      }
    },
    [enabled],
  );

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const press = pressRef.current;
    if (!press || begunRef.current || event.pointerId !== press.pointerId) return;
    const distance = Math.hypot(event.clientX - press.startX, event.clientY - press.startY);
    if (distance < DRAG_THRESHOLD_PX) return;
    begunRef.current = true;
    pressRef.current = null;
    // Release capture so the fullscreen NotchMoveOverlay's window listeners
    // own the rest of the drag.
    try {
      (event.currentTarget as Element).releasePointerCapture(event.pointerId);
    } catch {
      // Capture never took; nothing to release.
    }
    invoke("begin_notch_move").catch((err) => logError("useNotchMove: begin_notch_move", err));
  }, []);

  return {
    dragHandlers: {
      onPointerDown,
      onPointerMove,
      // Releasing, leaving (uncaptured fallback), or a cancelled pointer all
      // end a press that never crossed the threshold.
      onPointerUp: clearPress,
      onPointerLeave: clearPress,
      onPointerCancel: clearPress,
    },
  };
}
