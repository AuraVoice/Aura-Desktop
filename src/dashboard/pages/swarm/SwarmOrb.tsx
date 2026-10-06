import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useResolvedTheme } from "../../../theme/useResolvedTheme";
import { sigilParams } from "./SwarmGlyphs";
import { setOrbPalette, subscribeOrb, type OrbState, type OrbStatus, type OrbSubscription, type OrbTone } from "./swarmOrbRenderer";

/** A manager's sigil turning in three dimensions, the size of an avatar. One inline 2D
 * canvas fed by the shared renderer in swarmOrbRenderer.ts, with a breathing dot in its
 * place until three.js has loaded, or for good when WebGL is not available. Colours come
 * from the --sw-* tokens on this element, so light and dark need no code here. */
export function SwarmOrb({ id, state, tone = "accent", size = 36, className = "" }: { id: string; state: OrbState; tone?: OrbTone; size?: number; className?: string }) {
  const theme = useResolvedTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const subRef = useRef<OrbSubscription | null>(null);
  const [status, setStatus] = useState<OrbStatus>("pending");
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    readPalette(canvas, theme === "dark");
    const sub = subscribeOrb(canvas, { id, params: sigilParams(id), state, tone }, setStatus);
    subRef.current = sub;
    return () => {
      sub.dispose();
      subRef.current = null;
    };
    // state and tone follow through update() below; only a new id rebuilds the subscription.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    subRef.current?.update({ state, tone });
  }, [state, tone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) readPalette(canvas, theme === "dark");
  }, [theme]);

  return (
    <span className={`db-swarm-orb is-${status}${className ? ` ${className}` : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <canvas ref={canvasRef} width={Math.round(size * dpr)} height={Math.round(size * dpr)} />
      <i className="db-swarm-orb-dot" />
    </span>
  );
}

function readPalette(el: HTMLElement, dark: boolean) {
  const cs = getComputedStyle(el);
  const read = (name: string) => cs.getPropertyValue(name).trim();
  setOrbPalette({ accent: read("--sw-accent"), sup: read("--sw-boss"), warn: read("--sw-warn"), dark });
}
