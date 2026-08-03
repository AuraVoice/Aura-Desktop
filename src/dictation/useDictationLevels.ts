import { useEffect, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BAR_COUNT,
  ICON_BASELINE,
  clamp,
  easeHeights,
  maxHalfHeightFor,
  paintBars,
  restingTarget,
  sizeCanvas,
  staticTargets,
} from "../overlay/waveform";

/// How long a level survives before the bars fall back to rest. The worker
/// publishes every 50ms while a hold is live, so anything older than this means
/// the hold ended or the worker stalled. Without it a stalled worker would
/// leave the waveform frozen mid-spike, which reads as "still listening" when
/// nothing is listening.
const LEVEL_TTL_MS = 200;

function paintVerticalLevel(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number,
  now: number,
  staticFrame: boolean,
) {
  const count = 5;
  const segmentHeight = Math.min(3, height / 14);
  const gap = segmentHeight * 1.6;
  const clusterHeight = count * segmentHeight + (count - 1) * gap;
  const startY = (height - clusterHeight) / 2;
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "rgba(104, 221, 205, 0.42)");
  gradient.addColorStop(0.5, "rgba(151, 240, 225, 0.96)");
  gradient.addColorStop(1, "rgba(104, 221, 205, 0.42)");
  context.fillStyle = gradient;
  context.shadowColor = "rgba(86, 214, 196, 0.42)";
  context.shadowBlur = 3;

  for (let index = 0; index < count; index += 1) {
    const ripple = staticFrame ? 0.42 : (Math.sin(now / 105 + index * 1.15) + 1) / 2;
    const energy = staticFrame ? 0.35 : Math.min(1, 0.12 + ripple * 0.16 + level * (0.58 + ripple * 0.28));
    const segmentWidth = 1.5 + energy * Math.max(1, width - 2.5);
    const x = (width - segmentWidth) / 2;
    const y = startY + index * (segmentHeight + gap);
    context.beginPath();
    context.roundRect(x, y, segmentWidth, segmentHeight, segmentHeight / 2);
    context.fill();
  }
}

/// Paints the dictation waveform from levels streamed by the Rust capture loop.
///
/// The voice bar can analyse a LiveKit track directly in the webview; dictation
/// audio never leaves the Rust side, so the level arrives as a number instead.
/// Everything downstream of the target math is shared with the voice bar, so
/// the two waveforms are the same waveform.
///
/// Levels land in a ref, never in state: at 20 events a second, re-rendering
/// per event would cost far more than the canvas does.
export function useDictationLevels(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  active: boolean,
  vertical = false,
) {
  useEffect(() => {
    const canvasElement = canvasRef.current;
    if (!canvasElement) return;

    const drawingContext = canvasElement.getContext("2d");
    if (!drawingContext) return;

    const canvas: HTMLCanvasElement = canvasElement;
    const context: CanvasRenderingContext2D = drawingContext;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const heights = new Float32Array(BAR_COUNT);
    const targets = new Float32Array(BAR_COUNT);
    let level = 0;
    let levelAt = 0;
    let animationFrame = 0;
    let disposed = false;

    const pending = listen<number>("dictation-level", (event) => {
      level = clamp(event.payload, 0, 1);
      levelAt = performance.now();
    });

    function currentLevel(now: number) {
      if (!active) return 0;
      // A level that stopped arriving is not a level.
      return now - levelAt > LEVEL_TTL_MS ? 0 : level;
    }

    function draw(now: number, staticFrame = false) {
      const { width, height } = sizeCanvas(canvas, context);
      context.clearRect(0, 0, width, height);

      if (vertical) {
        paintVerticalLevel(context, width, height, currentLevel(now), now, staticFrame);
        return;
      }

      const maxHalfHeight = maxHalfHeightFor(height);
      if (staticFrame) {
        staticTargets(maxHalfHeight, targets);
      } else {
        const energy = currentLevel(now);
        for (let index = 0; index < BAR_COUNT; index += 1) {
          // At rest the bars sit on the silhouette with a barely-there sway, so
          // the surface reads as awake but plainly not hearing anything. That
          // difference is the entire point: a muted mic must not look like a
          // working one.
          const floor = restingTarget(index, maxHalfHeight) * 0.62;
          const sway = 1 + 0.05 * Math.sin(now / 900 + index * 0.8);
          // Per-bar phase, so speech ripples across the cluster instead of
          // moving every bar as one block.
          const ripple = 0.72 + 0.28 * Math.sin(now / 110 + index * 0.9);
          const reach = ICON_BASELINE[index] * (maxHalfHeight - floor);
          targets[index] = floor * sway + energy * ripple * reach;
        }
      }
      easeHeights(heights, targets, maxHalfHeight, staticFrame);
      paintBars(context, heights, width, height);
    }

    function animate(now: number) {
      if (disposed) return;
      draw(now);
      animationFrame = requestAnimationFrame(animate);
    }

    if (reducedMotion) {
      animationFrame = requestAnimationFrame((now) => draw(now, true));
    } else {
      animationFrame = requestAnimationFrame(animate);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      void pending.then((unlisten) => unlisten());
    };
  }, [canvasRef, active, vertical]);
}
