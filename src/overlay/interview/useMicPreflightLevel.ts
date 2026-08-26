import { useEffect, useRef, useState } from "react";
import { clamp } from "../waveform";
import { logError } from "../../lib/log";

/**
 * A live microphone meter for the Interview Companion preflight, and only for
 * the preflight.
 *
 * Preflight is the one window where the webview may safely own the microphone:
 * the Rust capture loop has not started yet. The stream is torn down the moment
 * `enabled` goes false (which includes Start), so the two never hold the device
 * at the same time.
 *
 * The analyser settings match useAudioLevels' bare-MediaStreamTrack branch on
 * purpose - the notch and this meter should react to a voice identically.
 */

export type MicPreflightStatus = "idle" | "requesting" | "live" | "denied" | "no-device";

const BAR_COUNT = 5;
/** Frequency bins that carry speech. Skips the DC/rumble bins at the bottom. */
const FIRST_BIN = 2;
const LAST_BIN = 72;
const NOISE_FLOOR = 0.025;
const GAIN = 7;
/** Toward-target easing per frame. Fast enough to feel live, slow enough that a
 *  consonant does not read as a strobe. */
const SMOOTHING = 0.35;

export interface MicPreflightLevel {
  status: MicPreflightStatus;
  /** 0..1 overall activity, for the icon's own reaction. */
  level: number;
  /** BAR_COUNT heights in 0..1, already eased. */
  bars: number[];
}

const RESTING: number[] = Array.from({ length: BAR_COUNT }, () => 0);

export function useMicPreflightLevel(enabled: boolean): MicPreflightLevel {
  const [status, setStatus] = useState<MicPreflightStatus>("idle");
  const [bars, setBars] = useState<number[]>(RESTING);
  const [level, setLevel] = useState(0);
  // Held across frames so easing is continuous rather than re-derived from the
  // last committed React state, which lags by a frame.
  const easedRef = useRef<number[]>([...RESTING]);

  useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      setBars(RESTING);
      setLevel(0);
      easedRef.current = [...RESTING];
      return;
    }

    let cancelled = false;
    let stream: MediaStream | null = null;
    let audioContext: AudioContext | null = null;
    let frame: number | null = null;

    setStatus("requesting");

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((granted) => {
        if (cancelled) {
          granted.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = granted;
        const context = new AudioContext();
        audioContext = context;
        const source = context.createMediaStreamSource(granted);
        const analyser = context.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.86;
        analyser.minDecibels = -88;
        analyser.maxDecibels = -28;
        source.connect(analyser);
        const frequencies = new Uint8Array(analyser.frequencyBinCount);
        setStatus("live");

        const tick = () => {
          analyser.getByteFrequencyData(frequencies);
          const last = Math.min(LAST_BIN, frequencies.length - 1);
          const span = Math.max(1, last - FIRST_BIN + 1);
          const perBar = Math.max(1, Math.floor(span / BAR_COUNT));
          let energy = 0;
          const targets: number[] = [];
          for (let bar = 0; bar < BAR_COUNT; bar += 1) {
            let sum = 0;
            const start = FIRST_BIN + bar * perBar;
            for (let bin = start; bin < start + perBar; bin += 1) {
              const value = (frequencies[Math.min(bin, last)] ?? 0) / 255;
              sum += value;
              energy += value;
            }
            targets.push(clamp((sum / perBar - NOISE_FLOOR) * GAIN, 0, 1));
          }
          const activity = clamp((energy / span - NOISE_FLOOR) * GAIN, 0, 1);
          const eased = easedRef.current;
          for (let bar = 0; bar < BAR_COUNT; bar += 1) {
            eased[bar] += (targets[bar] - eased[bar]) * SMOOTHING;
          }
          easedRef.current = eased;
          setBars([...eased]);
          setLevel(activity);
          frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const name = error instanceof Error ? error.name : "";
        // NotFoundError means there is no capture device at all, which is a
        // different fix for the user than a permission they can grant.
        setStatus(name === "NotFoundError" || name === "OverconstrainedError" ? "no-device" : "denied");
        if (name !== "NotAllowedError" && name !== "NotFoundError") {
          logError("Interview Companion: mic preflight", error);
        }
      });

    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
      stream?.getTracks().forEach((track) => track.stop());
      void audioContext?.close().catch(() => {});
    };
  }, [enabled]);

  return { status, level, bars };
}
