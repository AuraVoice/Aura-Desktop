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
// The silhouette, smoothing, geometry and gradient are shared with the
// dictation HUD's waveform. Only the target math below is LiveKit's.
import {
  BAR_COUNT,
  NOISE_FLOOR,
  SIGNAL_GAIN,
  clamp,
  easeHeights,
  idleTarget,
  maxHalfHeightFor,
  paintBars,
  processingTarget,
  restingTarget,
  sizeCanvas,
  staticTargets,
} from "./waveform";

type AnalyzableAudioTrack = LocalAudioTrack | RemoteAudioTrack;

function isMediaStreamTrack(
  track: AnalyzableAudioTrack | MediaStreamTrack,
): track is MediaStreamTrack {
  return typeof MediaStreamTrack !== "undefined" && track instanceof MediaStreamTrack;
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
  mediaTrack: MediaStreamTrack | null = null,
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
    let frequencyData: Uint8Array<ArrayBuffer> | null = null;
    let activeTrack: AnalyzableAudioTrack | MediaStreamTrack | null = null;
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
      const nextTrack = mediaTrack ?? trackForStatus(room, status);
      if (nextTrack === activeTrack && analyserBundle) return;

      releaseAnalyser();
      if (!nextTrack || reducedMotion) return;

      try {
        if (isMediaStreamTrack(nextTrack)) {
          const audioContext = new AudioContext();
          const source = audioContext.createMediaStreamSource(new MediaStream([nextTrack]));
          const analyser = audioContext.createAnalyser();
          analyser.fftSize = 256;
          analyser.smoothingTimeConstant = 0.86;
          analyser.minDecibels = -88;
          analyser.maxDecibels = -28;
          source.connect(analyser);
          analyserBundle = {
            analyser,
            cleanup: async () => {
              source.disconnect();
              analyser.disconnect();
              await audioContext.close();
            },
          } as ReturnType<typeof createAudioAnalyser>;
        } else {
          analyserBundle = createAudioAnalyser(nextTrack, {
            fftSize: 256,
            smoothingTimeConstant: 0.86,
            minDecibels: -88,
            maxDecibels: -28,
          });
        }
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
        const floor = restingTarget(index, maxHalfHeight);
        const reactiveHeight = floor + shaped * activity * (maxHalfHeight - floor);
        targets[index] = clamp(reactiveHeight, floor, maxHalfHeight);
      }
      return targets;
    }

    function draw(now: number, staticFrame = false) {
      const { width, height } = sizeCanvas(canvas, context);
      context.clearRect(0, 0, width, height);

      const maxHalfHeight = maxHalfHeightFor(height);
      const reactiveTargets =
        status === "listening" || status === "speaking"
          ? audioTargets(maxHalfHeight)
          : null;

      if (staticFrame) {
        staticTargets(maxHalfHeight, targets);
      } else {
        for (let index = 0; index < BAR_COUNT; index += 1) {
          if (status === "processing") {
            targets[index] = processingTarget(index, maxHalfHeight, now);
          } else if (reactiveTargets) {
            targets[index] = reactiveTargets[index];
          } else {
            targets[index] = idleTarget(index, maxHalfHeight, now);
          }
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
  }, [canvasRef, mediaTrack, room, status]);
}
