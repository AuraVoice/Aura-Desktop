import { useEffect, type RefObject } from "react";
import {
  createAudioAnalyser,
  RoomEvent,
  Track,
  type LocalAudioTrack,
  type RemoteAudioTrack,
  type Room,
} from "livekit-client";
import { logError } from "../lib/log";
import type { VoiceSessionStatus } from "./useVoiceBar";

const BAR_COUNT = 13;
const SMOOTHING_FACTOR = 0.24;
const NOISE_FLOOR = 0.06;
const SIGNAL_GAIN = 2.4;

// A fixed, symmetric sound-wave silhouette (fraction of the available
// half-height, 0..1). The recorder renders this even at rest so it always
// reads as a waveform icon instead of a flat row of dots; audio just adds
// energy on top of it.
const ICON_BASELINE = buildIconBaseline(BAR_COUNT);

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

type AnalyzableAudioTrack = LocalAudioTrack | RemoteAudioTrack;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function trackForStatus(
  room: Room | null,
  status: VoiceSessionStatus,
): AnalyzableAudioTrack | null {
  if (!room) return null;

  if (status === "listening") {
    return (
      room.localParticipant.getTrackPublication(Track.Source.Microphone)?.audioTrack ?? null
    );
  }

  if (status !== "speaking") return null;

  const agent = Array.from(room.remoteParticipants.values()).find(
    (participant) => participant.isAgent,
  );
  if (!agent) return null;

  const microphoneTrack = agent.getTrackPublication(Track.Source.Microphone)?.audioTrack;
  if (microphoneTrack) return microphoneTrack;

  for (const publication of agent.audioTrackPublications.values()) {
    if (publication.audioTrack) return publication.audioTrack;
  }
  return null;
}

export function useAudioLevels(
  room: Room | null,
  status: VoiceSessionStatus,
  canvasRef: RefObject<HTMLCanvasElement | null>,
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
    let frequencyData: Uint8Array<ArrayBuffer> | null = null;
    let activeTrack: AnalyzableAudioTrack | null = null;
    let analyserBundle: ReturnType<typeof createAudioAnalyser> | null = null;
    let animationFrame = 0;
    let disposed = false;

    function releaseAnalyser() {
      const cleanup = analyserBundle?.cleanup;
      analyserBundle = null;
      frequencyData = null;
      activeTrack = null;
      if (cleanup) {
        void cleanup().catch((err) => logError("useAudioLevels: cleanup", err));
      }
    }

    function refreshTrack() {
      const nextTrack = trackForStatus(room, status);
      if (nextTrack === activeTrack && analyserBundle) return;

      releaseAnalyser();
      if (!nextTrack || reducedMotion) return;

      try {
        analyserBundle = createAudioAnalyser(nextTrack, {
          fftSize: 256,
          smoothingTimeConstant: 0.86,
          minDecibels: -88,
          maxDecibels: -28,
        });
        activeTrack = nextTrack;
        frequencyData = new Uint8Array(analyserBundle.analyser.frequencyBinCount);
        const audioContext = analyserBundle.analyser.context as AudioContext;
        if (audioContext.state === "suspended") {
          void audioContext.resume().catch((err) =>
            logError("useAudioLevels: resume audio context", err),
          );
        }
      } catch (err) {
        releaseAnalyser();
        logError("useAudioLevels: create analyser", err);
      }
    }

    function canvasSize() {
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

    function idleTarget(index: number, maxHalfHeight: number, now: number) {
      // Each bar bobs on its own phase so the cluster visibly moves up and
      // down even with no audio, like a live equalizer.
      const bob = (Math.sin(now / 470 + index * 0.7) + 1) / 2;
      return ICON_BASELINE[index] * maxHalfHeight * (0.35 + 0.5 * bob);
    }

    function processingTarget(index: number, maxHalfHeight: number, now: number) {
      const pulse = (Math.sin(now / 320 - index * 0.42) + 1) / 2;
      return ICON_BASELINE[index] * maxHalfHeight * (0.7 + 0.55 * pulse);
    }

    function audioTargets(maxHalfHeight: number) {
      if (!analyserBundle || !frequencyData) return null;

      analyserBundle.analyser.getByteFrequencyData(frequencyData);
      const firstBin = 2;
      const lastBin = Math.min(frequencyData.length - 1, 72);
      let energySum = 0;
      let energySamples = 0;
      for (let bin = firstBin; bin <= lastBin; bin += 1) {
        const amplitude = frequencyData[bin] / 255;
        energySum += amplitude * amplitude;
        energySamples += 1;
      }
      const energy = Math.sqrt(energySum / Math.max(1, energySamples));
      const activity = clamp((energy - 0.025) * 7, 0, 1);
      if (activity < 0.04) return null;

      const targets = new Float32Array(BAR_COUNT);
      for (let index = 0; index < BAR_COUNT; index += 1) {
        const position = index / Math.max(1, BAR_COUNT - 1);
        const curvedPosition = Math.pow(position, 1.45);
        const centerBin = Math.round(firstBin + curvedPosition * (lastBin - firstBin));
        let bandSum = 0;
        let bandSamples = 0;
        for (let offset = -1; offset <= 1; offset += 1) {
          const bin = clamp(centerBin + offset, firstBin, lastBin);
          bandSum += frequencyData[bin] / 255;
          bandSamples += 1;
        }
        const bandLevel = bandSum / bandSamples;
        const normalized = clamp((bandLevel - NOISE_FLOOR) * SIGNAL_GAIN, 0, 1);
        const shaped = Math.pow(normalized, 0.72);
        // Keep the waveform silhouette as a floor so quiet bars never collapse
        // back into dots while the mic or agent is live.
        const floor = ICON_BASELINE[index] * maxHalfHeight * 0.5;
        const reactiveHeight = floor + shaped * activity * (maxHalfHeight - floor);
        targets[index] = clamp(reactiveHeight, floor, maxHalfHeight);
      }
      return targets;
    }

    function draw(now: number, staticFrame = false) {
      const { width, height } = canvasSize();
      context.clearRect(0, 0, width, height);

      const centerY = height / 2;
      const maxHalfHeight = Math.max(3, centerY - 2);
      const reactiveTargets =
        status === "listening" || status === "speaking"
          ? audioTargets(maxHalfHeight)
          : null;

      for (let index = 0; index < BAR_COUNT; index += 1) {
        let target: number;
        if (status === "processing") {
          target = processingTarget(index, maxHalfHeight, now);
        } else if (reactiveTargets) {
          target = reactiveTargets[index];
        } else {
          target = idleTarget(index, maxHalfHeight, now);
        }
        if (staticFrame) target = ICON_BASELINE[index] * maxHalfHeight * 0.82;
        target = clamp(target, 1, maxHalfHeight);
        heights[index] += (target - heights[index]) * (staticFrame ? 1 : SMOOTHING_FACTOR);
      }

      // Chunky bars kept as a compact cluster centered in the notch, not
      // spread edge to edge.
      const barWidth = clamp(width / 46, 4, 6);
      const gap = barWidth * 1.5;
      const clusterWidth = BAR_COUNT * barWidth + (BAR_COUNT - 1) * gap;
      const startX = (width - clusterWidth) / 2;
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, "rgba(104, 221, 205, 0.48)");
      gradient.addColorStop(0.5, "rgba(151, 240, 225, 0.96)");
      gradient.addColorStop(1, "rgba(104, 221, 205, 0.48)");
      context.fillStyle = gradient;
      context.shadowColor = "rgba(86, 214, 196, 0.38)";
      context.shadowBlur = 7;

      for (let index = 0; index < BAR_COUNT; index += 1) {
        const x = startX + index * (barWidth + gap);
        const halfHeight = heights[index];
        context.beginPath();
        context.roundRect(
          x,
          centerY - halfHeight,
          barWidth,
          halfHeight * 2,
          barWidth / 2,
        );
        context.fill();
      }
    }

    function animate(now: number) {
      if (disposed) return;
      draw(now);
      animationFrame = requestAnimationFrame(animate);
    }

    refreshTrack();
    room?.on(RoomEvent.LocalTrackPublished, refreshTrack);
    room?.on(RoomEvent.LocalTrackUnpublished, refreshTrack);
    room?.on(RoomEvent.TrackSubscribed, refreshTrack);
    room?.on(RoomEvent.TrackUnsubscribed, refreshTrack);

    if (reducedMotion) {
      animationFrame = requestAnimationFrame((now) => draw(now, true));
    } else {
      animationFrame = requestAnimationFrame(animate);
    }

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      room?.off(RoomEvent.LocalTrackPublished, refreshTrack);
      room?.off(RoomEvent.LocalTrackUnpublished, refreshTrack);
      room?.off(RoomEvent.TrackSubscribed, refreshTrack);
      room?.off(RoomEvent.TrackUnsubscribed, refreshTrack);
      releaseAnalyser();
    };
  }, [canvasRef, room, status]);
}
