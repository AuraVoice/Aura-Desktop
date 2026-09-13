/**
 * The veil for the circle-to-ask gesture, rendered in its own fullscreen
 * click-through window ("region"): a frozen still of the display, a dim scrim,
 * the stroke trail, and the lock-in when the key comes up.
 *
 * Rust owns everything except the drawing. The window is built, sized, shown
 * and hidden by region/mod.rs, and the cursor path arrives as events, because
 * the window is click-through and therefore receives no mouse messages at all:
 * it physically cannot track the cursor itself.
 *
 * Sequence per gesture: started (display rect) -> freeze-ready (collect the
 * still, decode it, tell Rust the veil may show) -> points -> locked (crop
 * rect) -> capture-ready or cancelled (clear). Every step is keyed by
 * generation, so nothing from a superseded gesture is ever drawn.
 *
 * Coordinates arrive in the platform's own space (physical pixels on Windows,
 * points on macOS) and are plotted RAW inside an SVG viewBox set to the same
 * display rect. That is the whole reason this is SVG rather than the canvas
 * that overlay/waveform.ts established as the repo's per-frame drawing
 * precedent: the viewBox absorbs the DPI difference, so there is no
 * devicePixelRatio maths to get wrong on either platform. The still is
 * stretched to the window for the same reason.
 *
 * This window renders RegionOverlay, not App, so it loads none of App.css and
 * has to import its own tokens and reset.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTauriEvent } from "../lib/useTauriEvent";
import { logError } from "../lib/log";
import { asArrayBuffer } from "../lib/screenFrame";
import {
  REGION_CANCELLED,
  REGION_CAPTURE_READY,
  REGION_FREEZE_READY,
  REGION_SELECTION_LOCKED,
  REGION_SELECTION_POINTS,
  REGION_SELECTION_STARTED,
  type RegionFreezeReadyPayload,
  type RegionSelectionLockedPayload,
  type RegionSelectionPointsPayload,
  type RegionSelectionStartedPayload,
} from "../lib/ipcEvents";
import "../theme/theme.css";
import "./RegionOverlay.css";

/** width u32 | height u32 | generation u64, little-endian. Mirrors
 * REGION_FREEZE_HEADER_LEN in screenshot.rs. */
const FREEZE_HEADER_LEN = 4 + 4 + 8;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Gesture {
  generation: number;
  originX: number;
  originY: number;
  width: number;
  height: number;
  /** Flat [x, y, ...] already translated into viewBox space. */
  points: number[];
  /** Object URL of the frozen still, null until it has decoded. */
  stillUrl: string | null;
  /** The padded crop Rust will send, in viewBox space, once the key is up. */
  locked: Rect | null;
}

export function RegionOverlay() {
  const [gesture, setGesture] = useState<Gesture | null>(null);
  // The live generation, read inside handlers without making them depend on
  // `gesture` and resubscribe. A batch from a superseded gesture must never be
  // appended to the current one.
  const generationRef = useRef<number | null>(null);
  // One owner for the still's object URL, so every ending revokes it.
  const stillUrlRef = useRef<string | null>(null);

  const releaseStill = useCallback(() => {
    if (stillUrlRef.current) {
      URL.revokeObjectURL(stillUrlRef.current);
      stillUrlRef.current = null;
    }
  }, []);

  useEffect(() => releaseStill, [releaseStill]);

  useTauriEvent<RegionSelectionStartedPayload>(
    REGION_SELECTION_STARTED,
    (payload) => {
      releaseStill();
      generationRef.current = payload.generation;
      setGesture({
        generation: payload.generation,
        originX: payload.displayX,
        originY: payload.displayY,
        width: payload.displayWidth,
        height: payload.displayHeight,
        points: [],
        stillUrl: null,
        locked: null,
      });
    },
    "RegionOverlay: listen region-selection-started",
  );

  useTauriEvent<RegionFreezeReadyPayload>(
    REGION_FREEZE_READY,
    (payload) => {
      const generation = payload.generation;
      if (generation !== generationRef.current) return;
      void (async () => {
        try {
          const buffer = asArrayBuffer(await invoke("take_region_freeze"));
          // Empty means the gesture ended before this window asked.
          if (buffer.byteLength <= FREEZE_HEADER_LEN) return;
          const stillGeneration = Number(new DataView(buffer).getBigUint64(8, true));
          if (stillGeneration !== generation || generationRef.current !== generation) return;
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(buffer, FREEZE_HEADER_LEN)], { type: "image/jpeg" }),
          );
          // Decoded BEFORE the veil is allowed to show, so the window never
          // appears as a flash of live desktop that then snaps to the still.
          const image = new Image();
          image.src = url;
          await image.decode();
          if (generationRef.current !== generation) {
            URL.revokeObjectURL(url);
            return;
          }
          releaseStill();
          stillUrlRef.current = url;
          setGesture((current) =>
            current && current.generation === generation ? { ...current, stillUrl: url } : current,
          );
          // No requestAnimationFrame wait here: the window is still hidden, and
          // a hidden webview may not run animation frames at all, which would
          // turn every gesture into Rust's timeout path.
          await invoke("region_veil_ready", { generation });
        } catch (err) {
          logError("RegionOverlay: load frozen still", err);
        }
      })();
    },
    "RegionOverlay: listen region-freeze-ready",
  );

  useTauriEvent<RegionSelectionPointsPayload>(
    REGION_SELECTION_POINTS,
    (payload) => {
      if (payload.generation !== generationRef.current) return;
      setGesture((current) => {
        if (!current || current.generation !== payload.generation) return current;
        const translated: number[] = [];
        for (let i = 0; i + 1 < payload.points.length; i += 2) {
          translated.push(payload.points[i] - current.originX);
          translated.push(payload.points[i + 1] - current.originY);
        }
        return { ...current, points: current.points.concat(translated) };
      });
    },
    "RegionOverlay: listen region-selection-points",
  );

  useTauriEvent<RegionSelectionLockedPayload>(
    REGION_SELECTION_LOCKED,
    (payload) => {
      if (payload.generation !== generationRef.current) return;
      setGesture((current) => {
        if (!current || current.generation !== payload.generation) return current;
        return {
          ...current,
          locked: {
            x: payload.cropX - current.originX,
            y: payload.cropY - current.originY,
            width: payload.cropWidth,
            height: payload.cropHeight,
          },
        };
      });
    },
    "RegionOverlay: listen region-selection-locked",
  );

  // Both endings clear everything. Rust has already hidden the window by the
  // time either arrives, so this is about the next gesture starting clean and
  // the still's memory being released.
  const clear = useCallback(() => {
    generationRef.current = null;
    releaseStill();
    setGesture(null);
  }, [releaseStill]);
  useTauriEvent(REGION_CAPTURE_READY, clear, "RegionOverlay: listen region-capture-ready");
  useTauriEvent(REGION_CANCELLED, clear, "RegionOverlay: listen region-cancelled");

  if (!gesture) return null;
  const hasStroke = gesture.points.length >= 4;
  if (!gesture.stillUrl && !hasStroke) return null;

  // While drawing, the cutout follows what has been circled so far. Once the
  // key is up it snaps to the padded rect Rust is actually sending.
  const focus = gesture.locked ?? (hasStroke ? strokeBounds(gesture.points) : null);
  const points = hasStroke ? pointsAttribute(gesture.points) : "";
  const pointCount = gesture.points.length;

  return (
    <div className={`region-overlay${gesture.locked ? " region-overlay-locked" : ""}`}>
      {gesture.stillUrl && (
        <img className="region-still" src={gesture.stillUrl} alt="" draggable={false} />
      )}
      <svg
        className="region-overlay-canvas"
        viewBox={`0 0 ${gesture.width} ${gesture.height}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <defs>
          <filter id="region-stroke-blur" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="6" />
          </filter>
          <mask
            id="region-focus-mask"
            maskUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={gesture.width}
            height={gesture.height}
          >
            <rect x="0" y="0" width={gesture.width} height={gesture.height} fill="white" />
            {focus && (
              <rect
                x={focus.x}
                y={focus.y}
                width={focus.width}
                height={focus.height}
                rx="14"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          className="region-scrim"
          x="0"
          y="0"
          width={gesture.width}
          height={gesture.height}
          mask="url(#region-focus-mask)"
        />
        {focus && (
          <rect
            className="region-focus"
            x={focus.x}
            y={focus.y}
            width={focus.width}
            height={focus.height}
            rx="14"
          />
        )}
        {hasStroke && (
          <>
            <polyline className="region-stroke-glow" points={points} />
            <polyline className="region-stroke" points={points} />
            {/* The gap back to the start, so an open arc reads as a closed
                selection. Rust accepts open arcs; this only shows the box it
                will take. */}
            <line
              className="region-stroke-close"
              x1={gesture.points[pointCount - 2]}
              y1={gesture.points[pointCount - 1]}
              x2={gesture.points[0]}
              y2={gesture.points[1]}
            />
          </>
        )}
      </svg>
    </div>
  );
}

/** Flat [x, y, ...] to the "x,y x,y" form the points attribute wants. */
function pointsAttribute(flat: number[]): string {
  const pairs: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    pairs.push(`${flat[i]},${flat[i + 1]}`);
  }
  return pairs.join(" ");
}

/** The unpadded box around the stroke so far. Rust's padding is deliberately
 * not repeated here; the locked rect it sends replaces this on release. */
function strokeBounds(flat: number[]): Rect {
  let minX = flat[0];
  let maxX = flat[0];
  let minY = flat[1];
  let maxY = flat[1];
  for (let i = 2; i + 1 < flat.length; i += 2) {
    minX = Math.min(minX, flat[i]);
    maxX = Math.max(maxX, flat[i]);
    minY = Math.min(minY, flat[i + 1]);
    maxY = Math.max(maxY, flat[i + 1]);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
