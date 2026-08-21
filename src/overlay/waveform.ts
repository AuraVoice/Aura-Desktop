// The notch's waveform, as pure drawing. No React, no LiveKit, no Tauri: this
// module has zero imports on purpose.
//
// Two surfaces paint these bars. The voice bar (useAudioLevels) derives its
// targets from a LiveKit AnalyserNode's frequency bins, and the dictation HUD
// (useDictationLevels) derives them from a single loudness number streamed out
// of the Rust capture loop. Only the target math differs; the silhouette, the
// smoothing, the geometry and the gradient live here so the two can never drift
// into looking like different products.
//
// It also keeps `livekit-client` out of the dictation window's module graph.
// That window is built the moment the chord completes and has to paint
// immediately, so it must not pay to parse an SDK it will never use.

export const BAR_COUNT = 13;
export const SMOOTHING_FACTOR = 0.24;
export const NOISE_FLOOR = 0.06;
export const SIGNAL_GAIN = 2.4;

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// A fixed, symmetric sound-wave silhouette (fraction of the available
// half-height, 0..1). The recorder renders this even at rest so it always
// reads as a waveform icon instead of a flat row of dots; audio just adds
// energy on top of it.
export const ICON_BASELINE = buildIconBaseline(BAR_COUNT);

function buildIconBaseline(count: number): Float32Array {
  const profile = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const centered = (index / Math.max(1, count - 1)) * 2 - 1;
    const envelope = 1 - Math.abs(centered) * 0.34;
    const detail =
      0.55 * Math.abs(Math.cos(centered * Math.PI * 2.3)) +
      0.45 * Math.abs(Math.cos(centered * Math.PI * 5.7));
    profile[index] = 0.3 + 0.7 * envelope * (0.28 + 0.72 * detail);
  }
  return profile;
}

/// Each bar bobs on its own phase so the cluster visibly moves up and down even
/// with no audio, like a live equalizer.
export function idleTarget(index: number, maxHalfHeight: number, now: number) {
  const bob = (Math.sin(now / 470 + index * 0.7) + 1) / 2;
  return ICON_BASELINE[index] * maxHalfHeight * (0.35 + 0.5 * bob);
}

export function processingTarget(index: number, maxHalfHeight: number, now: number) {
  const pulse = (Math.sin(now / 320 - index * 0.42) + 1) / 2;
  return ICON_BASELINE[index] * maxHalfHeight * (0.7 + 0.55 * pulse);
}

/// The height every bar collapses to when there is nothing to show. Used as the
/// floor for reactive targets so quiet bars never fall back into dots.
export function restingTarget(index: number, maxHalfHeight: number) {
  return ICON_BASELINE[index] * maxHalfHeight * 0.5;
}

/// Keeps the backing store in step with the CSS box and the device pixel ratio,
/// and returns the logical size to draw against.
export function sizeCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const scale = Math.max(1, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * scale);
  const pixelHeight = Math.round(height * scale);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(scale, 0, 0, scale, 0, 0);
  return { width, height };
}

/// Moves each bar a fraction of the way to its target. A static frame snaps
/// instead, which is what prefers-reduced-motion gets.
export function easeHeights(
  heights: Float32Array,
  targets: Float32Array,
  maxHalfHeight: number,
  staticFrame = false,
  smoothingFactor = SMOOTHING_FACTOR,
) {
  for (let index = 0; index < heights.length; index += 1) {
    const target = clamp(targets[index], 1, maxHalfHeight);
    heights[index] += (target - heights[index]) * (staticFrame ? 1 : smoothingFactor);
  }
}

/// The resting silhouette a static frame draws.
export function staticTargets(maxHalfHeight: number, into: Float32Array) {
  for (let index = 0; index < into.length; index += 1) {
    into[index] = ICON_BASELINE[index % BAR_COUNT] * maxHalfHeight * 0.82;
  }
  return into;
}

interface PaintBarsOptions {
  gapScale?: number;
  edgeInsetBars?: number;
  minBarWidth?: number;
  maxBarWidth?: number;
}

/// Thin bars kept as a compact cluster centered in the notch, not spread edge
/// to edge.
export function paintBars(
  context: CanvasRenderingContext2D,
  heights: Float32Array,
  width: number,
  height: number,
  options: PaintBarsOptions = {},
) {
  const centerY = height / 2;
  const count = heights.length;
  const gapScale = options.gapScale ?? 1.2;
  const edgeInsetBars = options.edgeInsetBars ?? 0;
  const barWidth = clamp(
    width / Math.max(1, count + (count - 1) * gapScale + edgeInsetBars * 2),
    options.minBarWidth ?? 2.5,
    options.maxBarWidth ?? 3,
  );
  const gap = barWidth * gapScale;
  const edgeInset = edgeInsetBars * barWidth;
  const clusterWidth = count * barWidth + (count - 1) * gap;
  const startX = edgeInset + Math.max(0, (width - edgeInset * 2 - clusterWidth) / 2);
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, "rgba(255, 255, 255, 0.48)");
  gradient.addColorStop(0.5, "rgba(255, 255, 255, 0.96)");
  gradient.addColorStop(1, "rgba(255, 255, 255, 0.48)");
  context.fillStyle = gradient;
  context.shadowColor = "rgba(255, 255, 255, 0.3)";
  context.shadowBlur = 7;

  for (let index = 0; index < count; index += 1) {
    const x = startX + index * (barWidth + gap);
    const halfHeight = heights[index];
    context.beginPath();
    context.roundRect(x, centerY - halfHeight, barWidth, halfHeight * 2, barWidth / 2);
    context.fill();
  }
}

/// The half-height a bar may reach in a canvas of this height.
export function maxHalfHeightFor(height: number) {
  return Math.max(3, height / 2 - 2);
}
