import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { logError } from "../lib/log";
import "./PointingOverlay.css";

const FLIGHT_MS = 900;
const RING_MS = 500;
const LABEL_MS = 250;
const TOTAL_HOLD_MS = 3400;

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface Point {
  x: number;
  y: number;
}

interface PointingTargetPayload {
  x: number;
  y: number;
  label?: string;
}

/**
 * The PointerBuddy flight: a small orb arcs to the target (quadratic bezier,
 * easeInOutCubic, 900ms), then a landing ring pulses out (500ms) and a label
 * bubble fades in (250ms), holding ~3.4s before Rust restores whatever the
 * overlay showed before. Direct port of `pointer_buddy.dart` +
 * `pointing_overlay_service.dart`'s timing.
 */
export function PointingOverlay() {
  const [target, setTarget] = useState<Point | null>(null);
  const [label, setLabel] = useState("");
  const [orbPos, setOrbPos] = useState<Point>({ x: 0, y: 0 });
  const [landed, setLanded] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<PointingTargetPayload>("pointing-target", (event) => {
      setTarget({ x: event.payload.x, y: event.payload.y });
      setLabel(event.payload.label ?? "");
      setLanded(false);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => logError("PointingOverlay: listen pointing-target", err));
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (!target) return;

    const start: Point = { x: window.innerWidth / 2, y: 24 };
    const dx = target.x - start.x;
    const dy = target.y - start.y;
    const distance = Math.hypot(dx, dy) || 1;
    const offset = Math.min(160, distance * 0.25);
    const control: Point = {
      x: (start.x + target.x) / 2 - (dy / distance) * offset,
      y: (start.y + target.y) / 2 + (dx / distance) * offset,
    };

    let raf = 0;
    const startTime = performance.now();

    function tick(now: number) {
      const t = Math.min((now - startTime) / FLIGHT_MS, 1);
      const eased = easeInOutCubic(t);
      const inv = 1 - eased;
      setOrbPos({
        x: inv * inv * start.x + 2 * inv * eased * control.x + eased * eased * target!.x,
        y: inv * inv * start.y + 2 * inv * eased * control.y + eased * eased * target!.y,
      });
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        setLanded(true);
      }
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    const timeoutId = setTimeout(() => {
      invoke("cancel_pointing").catch((err) => logError("PointingOverlay: cancel_pointing", err));
    }, TOTAL_HOLD_MS);
    return () => clearTimeout(timeoutId);
  }, [target]);

  if (!target) return null;

  return (
    <div className="pointing-overlay">
      <div className="pointing-orb" style={{ left: orbPos.x - 9, top: orbPos.y - 9 }} />
      {landed && <LandingRing target={target} />}
      {landed && label && <LabelBubble target={target} label={label} />}
    </div>
  );
}

function LandingRing({ target }: { target: Point }) {
  const [t, setT] = useState(0.4);

  useEffect(() => {
    let raf = 0;
    const startTime = performance.now();
    function tick(now: number) {
      const progress = Math.min((now - startTime) / RING_MS, 1);
      const eased = 1 - Math.pow(1 - progress, 2);
      setT(0.4 + eased * 0.6);
      if (progress < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const size = 36 * t + 12;
  return (
    <div
      className="pointing-ring"
      style={{ left: target.x - size / 2, top: target.y - size / 2, width: size, height: size, opacity: 1 - t }}
    />
  );
}

function LabelBubble({ target, label }: { target: Point; label: string }) {
  const [opacity, setOpacity] = useState(0);

  useEffect(() => {
    let raf = 0;
    const startTime = performance.now();
    function tick(now: number) {
      const progress = Math.min((now - startTime) / LABEL_MS, 1);
      setOpacity(progress);
      if (progress < 1) raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const left = Math.min(Math.max(target.x - 80, 8), window.innerWidth - 168);
  const top = Math.min(Math.max(target.y - 56, 8), window.innerHeight);

  return (
    <div className="pointing-label" style={{ left, top, opacity }}>
      {label}
    </div>
  );
}
