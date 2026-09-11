import { useEffect, useState } from "react";

/**
 * Keeps a surface mounted for `exitMs` after `show` turns false, so it can
 * play an exit animation before it unmounts (and before the notch slot that
 * holds it shrinks). `leaving` is true only for that window. A show during an
 * exit cancels it. Reduced motion skips the wait entirely.
 */
export function usePresence(show: boolean, exitMs: number): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(show);

  useEffect(() => {
    if (show) {
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const reducedMotion =
      typeof window !== "undefined"
      && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    if (reducedMotion || exitMs <= 0) {
      setMounted(false);
      return;
    }
    const id = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(id);
  }, [show, mounted, exitMs]);

  return { mounted: show || mounted, leaving: !show && mounted };
}
