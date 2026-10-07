import { useEffect, useRef, type RefObject } from "react";
import { BoltRig, type BoltMove, type BoltTone } from "./buddy/drawBolt";

// Buddy's face on a <canvas>, one requestAnimationFrame loop per mount. Props
// only start or stop the loop or update refs; nothing re-renders React per
// frame. The drawing and the motion model live in buddy/drawBolt.ts, a port of
// architectures/buddy-avatar-reference.html in the aura repo.

export type BuddyMove = Exclude<BoltMove, "wave" | "cheer">;

const MAX_DPR = 2;

interface BuddyAvatarProps {
  move: BuddyMove;
  /** Live voice level 0..1, read every frame. A ref, never state, so the
   * audio loop that writes it does not re-render React. */
  levelRef?: RefObject<number>;
  /** Bump to play the one-shot wave (about 1.6 s) over the current move. */
  waveCount?: number;
  /** Bump to play the one-shot cheer (two hops, about 1.7 s). */
  cheerCount?: number;
  /** CSS pixels. 24 and below draws the head only, as the reference does. */
  size: number;
  /** Eyes track the cursor while idle. */
  followPointer?: boolean;
  /** Shell colour. "auto" (the default) is the opposite of the window's
   * theme: graphite on the light theme, white metal on the dark one. */
  tone?: BoltTone | "auto";
  className?: string;
}

function toneForTheme(): BoltTone {
  return document.documentElement.dataset.theme === "dark" ? "light" : "dark";
}

function reducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return true;
  return document.querySelector(".db-reduce-motion") !== null;
}

export function BuddyAvatar({
  move,
  levelRef,
  waveCount = 0,
  cheerCount = 0,
  size,
  followPointer = false,
  tone = "auto",
  className,
}: BuddyAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rigRef = useRef<BoltRig | null>(null);
  const moveRef = useRef(move);
  moveRef.current = move;
  const toneRef = useRef(tone);
  toneRef.current = tone;

  const rig = () => (rigRef.current ??= new BoltRig(reducedMotion()));

  useEffect(() => {
    rig().setMove(move);
  }, [move]);

  const lastWave = useRef(waveCount);
  useEffect(() => {
    if (waveCount === lastWave.current) return;
    lastWave.current = waveCount;
    rig().playOneShot("wave");
  }, [waveCount]);

  const lastCheer = useRef(cheerCount);
  useEffect(() => {
    if (cheerCount === lastCheer.current) return;
    lastCheer.current = cheerCount;
    rig().playOneShot("cheer");
  }, [cheerCount]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !followPointer) return;
    const onMove = (event: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      rig().setPointer(
        ((event.clientX - r.left) / r.width - 0.5) * 2.4,
        ((event.clientY - r.top) / r.height - 0.38) * 2.4,
      );
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [followPointer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    const model = rig();
    model.setMove(moveRef.current);

    let frame = 0;
    let last = 0;
    let visible = !document.hidden;
    let onScreen = true;

    const tick = (ts: number) => {
      frame = 0;
      const dt = Math.min(0.05, (ts - last) / 1000);
      last = ts;
      model.now = ts / 1000;
      model.step(dt, levelRef?.current ?? 0);
      model.render(ctx, size, toneRef.current === "auto" ? toneForTheme() : toneRef.current);
      if (visible && onScreen) frame = requestAnimationFrame(tick);
    };
    const start = () => {
      if (frame || !visible || !onScreen) return;
      last = performance.now();
      frame = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const onVisibility = () => {
      visible = !document.hidden;
      if (visible) start();
      else stop();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting);
            if (onScreen) start();
            else stop();
          });
    observer?.observe(canvas);
    start();
    return () => {
      stop();
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [size, levelRef]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: size, height: size, display: "block" }}
      aria-hidden="true"
    />
  );
}
