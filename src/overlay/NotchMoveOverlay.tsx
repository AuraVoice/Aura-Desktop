import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logError } from "../lib/log";
import { nearestEdge, NOTCH_EDGES, type NotchEdge } from "./notchEdge";
import "./NotchMoveOverlay.css";

/**
 * The fullscreen edge-picker shown while the notch is being moved. Rust has
 * taken the display over (presentation "movingnotch", cursor-live), so this
 * covers the whole webview. As the cursor moves, the nearest of the four edge
 * drop-zones highlights and a ghost pill follows; releasing the pointer docks
 * the notch there (commit_notch_move), while Escape cancels it back in place.
 *
 * Both a held drag (pointer stays down from the long-press) and a fresh
 * move-then-click resolve the same way, so it works even if the pointer capture
 * did not survive the native fullscreen resize.
 */
export function NotchMoveOverlay() {
  const [target, setTarget] = useState<NotchEdge | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const targetRef = useRef<NotchEdge | null>(null);
  targetRef.current = target;

  useEffect(() => {
    function updateFromPointer(clientX: number, clientY: number) {
      const width = window.innerWidth || 1;
      const height = window.innerHeight || 1;
      setTarget(nearestEdge(clientX / width, clientY / height));
      setGhost({ x: clientX, y: clientY });
    }

    function onMove(event: PointerEvent) {
      updateFromPointer(event.clientX, event.clientY);
    }

    function commit() {
      const edge = targetRef.current;
      if (edge) {
        invoke("commit_notch_move", { edge }).catch((err) =>
          logError("NotchMoveOverlay: commit_notch_move", err),
        );
      } else {
        invoke("cancel_notch_move").catch((err) =>
          logError("NotchMoveOverlay: cancel_notch_move", err),
        );
      }
    }

    function cancel() {
      invoke("cancel_notch_move").catch((err) =>
        logError("NotchMoveOverlay: cancel_notch_move", err),
      );
    }

    function onPointerUp() {
      commit();
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    }

    // Right-click is a fast cancel gesture.
    function onContextMenu(event: MouseEvent) {
      event.preventDefault();
      cancel();
    }

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  return (
    <div className="notch-move-overlay" role="dialog" aria-label="Move the notch to a screen edge">
      {NOTCH_EDGES.map((edge) => (
        <div
          key={edge}
          className={`notch-move-zone notch-move-zone-${edge}${
            target === edge ? " notch-move-zone-active" : ""
          }`}
          aria-hidden="true"
        />
      ))}

      {ghost && (
        <div
          className="notch-move-ghost"
          style={{ left: ghost.x, top: ghost.y }}
          aria-hidden="true"
        />
      )}

      <p className="notch-move-hint">Drag to an edge to dock. Esc to cancel.</p>
    </div>
  );
}
