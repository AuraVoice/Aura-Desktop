import { useEffect, type RefObject } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  clamp,
  easeHeights,
  maxHalfHeightFor,
  paintBars,
  sizeCanvas,
} from "../overlay/waveform";

/// How long a level survives before the bars fall back to rest. The worker
/// publishes every 50ms while a hold is live, so anything older than this means
/// the hold ended or the worker stalled. Without it a stalled worker would
/// leave the waveform frozen mid-spike, which reads as "still listening" when
/// nothing is listening.
const LEVEL_TTL_MS = 200;
const DICTATION_BAR_COUNT = 31;
const DICTATION_SMOOTHING_FACTOR = 0.5;
const DICTATION_GAP_SCALE = 0.42;
const DICTATION_EDGE_INSET_BARS = 2;
const DICTATION_BASELINE = buildDictationBaseline();

function buildDictationBaseline() {
  const profile = new Float32Array(DICTATION_BAR_COUNT);
  for (let index = 0; index < DICTATION_BAR_COUNT; index += 1) {
    const position = index / Math.max(1, DICTATION_BAR_COUNT - 1);
    const centered = position * 2 - 1;
    const centerLift = 1 - Math.abs(centered) * 0.28;
    const detail =
      0.56 * Math.abs(Math.cos(position * Math.PI * 4.5)) +
      0.44 * Math.abs(Math.sin(position * Math.PI * 9.2));
    profile[index] = clamp(0.28 + centerLift * (0.22 + 0.72 * detail), 0.28, 1);
  }
  return profile;
}

function staticDictationTargets(maxHalfHeight: number, into: Float32Array) {
  for (let index = 0; index < DICTATION_BAR_COUNT; index += 1) {
    into[index] = DICTATION_BASELINE[index] * maxHalfHeight * 0.82;
  }
  return into;
}

function paintVerticalLevel(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number,
  now: number,
  staticFrame: boolean,
) {
  const count = Math.max(7, Math.min(27, Math.floor(height / 4) - DICTATION_EDGE_INSET_BARS * 2));
  const segmentHeight = clamp(
    height / ((count + DICTATION_EDGE_INSET_BARS * 2) * 1.42),
    1.8,
    2.8,
  );
  const gap = segmentHeight * 0.42;
  const edgeInset = segmentHeight * DICTATION_EDGE_INSET_BARS;
  const clusterHeight = count * segmentHeight + (count - 1) * gap;
  const startY = edgeInset + Math.max(0, (height - edgeInset * 2 - clusterHeight) / 2);
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, "rgba(104, 221, 205, 0.42)");
  gradient.addColorStop(0.5, "rgba(151, 240, 225, 0.96)");
  gradient.addColorStop(1, "rgba(104, 221, 205, 0.42)");
  context.fillStyle = gradient;
  context.shadowColor = "rgba(86, 214, 196, 0.42)";
  context.shadowBlur = 3;

  for (let index = 0; index < count; index += 1) {
    const position = index / Math.max(1, count - 1);
    const ripple = staticFrame ? 0.42 : (Math.sin(now / 40 + index * 1.72) + 1) / 2;
    const travel = staticFrame ? 0.5 : (Math.sin(now / 56 - index * 0.9) + 1) / 2;
    const envelope = 0.72 + 0.28 * Math.sin(position * Math.PI * 2.4 + 0.35);
    const energy = staticFrame
      ? 0.35
      : Math.min(1, 0.1 + ripple * 0.16 + level * envelope * (0.62 + travel * 0.34));
    const segmentWidth = 1.3 + energy * Math.max(1, width - 2.4);
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
/// The shared renderer still draws the bars; dictation uses a denser, faster
/// target profile because its HUD is much smaller than the voice bar.
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
    const heights = new Float32Array(DICTATION_BAR_COUNT);
    const targets = new Float32Array(DICTATION_BAR_COUNT);
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
        staticDictationTargets(maxHalfHeight, targets);
      } else {
        const energy = currentLevel(now);
        for (let index = 0; index < DICTATION_BAR_COUNT; index += 1) {
          // At rest the bars sit on the silhouette with a barely-there sway, so
          // the surface reads as awake but plainly not hearing anything. That
          // difference is the entire point: a muted mic must not look like a
          // working one.
          const baseline = DICTATION_BASELINE[index];
          const floor = baseline * maxHalfHeight * 0.34;
          const sway = 1 + 0.13 * Math.sin(now / 175 + index * 1.35);
          // Per-bar phase, so speech ripples across the cluster instead of
          // moving every bar as one block.
          const ripple = 0.48 + 0.52 * Math.sin(now / 42 + index * 1.75 + energy * 2.1);
          const travel = 0.55 + 0.45 * Math.sin(now / 60 - index * 0.85);
          const reach = baseline * (maxHalfHeight - floor);
          targets[index] = clamp(
            floor * sway + energy * (0.52 + ripple * travel) * reach,
            1,
            maxHalfHeight,
          );
        }
      }
      easeHeights(heights, targets, maxHalfHeight, staticFrame, DICTATION_SMOOTHING_FACTOR);
      paintBars(context, heights, width, height, {
        edgeInsetBars: DICTATION_EDGE_INSET_BARS,
        gapScale: DICTATION_GAP_SCALE,
        maxBarWidth: 2.4,
        minBarWidth: 1.1,
      });
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
