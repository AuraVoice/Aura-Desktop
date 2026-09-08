import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";

export interface SlidingTab<T extends string> {
  value: T;
  label: string;
  Icon?: LucideIcon;
  count?: number;
}

export type TabTransition = "idle" | "exiting" | "entering";

/**
 * The page-level pill strip with a sliding highlight, lifted out of the
 * Interview Companion so History and Interview share one implementation.
 *
 * Tab ids follow `${idPrefix}-${value}-tab` and each button controls
 * `${idPrefix}-${value}-panel`; the caller's panel wrapper must use those ids.
 */
export function SlidingTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  idPrefix,
}: {
  tabs: Array<SlidingTab<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  idPrefix: string;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Callers may pass a fresh array each render; only its contents change widths.
  const signature = tabs.map((tab) => `${tab.value}:${tab.label}:${tab.count ?? ""}`).join("|");

  // The pills size to their labels (and the optional count badge), so the
  // highlight's position and width have to be measured rather than derived from
  // an equal-track formula. Written straight onto the node so a resize or a font
  // swap never costs a React render.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      const active = strip.querySelector<HTMLElement>("button.is-active");
      if (!active) return;
      strip.style.setProperty("--tab-x", `${active.offsetLeft - strip.clientLeft}px`);
      strip.style.setProperty("--tab-w", `${active.offsetWidth}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [value, signature]);

  return (
    <div className="db-tab-strip" role="tablist" aria-label={ariaLabel} data-active={value} ref={stripRef}>
      {tabs.map(({ value: tabValue, label, Icon, count }) => (
        <button
          key={tabValue}
          type="button"
          id={`${idPrefix}-${tabValue}-tab`}
          role="tab"
          aria-controls={`${idPrefix}-${tabValue}-panel`}
          aria-selected={value === tabValue}
          className={value === tabValue ? "is-active" : ""}
          onClick={() => onChange(tabValue)}
        >
          {Icon && <Icon size={17} aria-hidden />}
          {label}
          {count !== undefined && <span>{count}</span>}
        </button>
      ))}
    </div>
  );
}

/**
 * Owns the exit/enter fade under a SlidingTabs strip: `tab` is what the strip
 * shows, `renderedTab` is what the stage below it is currently rendering, and
 * `transition` drives the `db-tab-stage` modifier class.
 */
export function useTabStage<T extends string>(initial: T) {
  const [tab, setTab] = useState<T>(initial);
  const [renderedTab, setRenderedTab] = useState<T>(initial);
  const [transition, setTransition] = useState<TabTransition>("idle");
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  function switchTab(nextTab: T) {
    if (nextTab === tab && transition === "idle") return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setTab(nextTab);
    const reduceMotion = document.querySelector(".db-app")?.classList.contains("db-reduce-motion")
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      setRenderedTab(nextTab);
      setTransition("idle");
      return;
    }
    setTransition("exiting");
    timer.current = window.setTimeout(() => {
      setRenderedTab(nextTab);
      setTransition("entering");
      timer.current = window.setTimeout(() => {
        setTransition("idle");
        timer.current = null;
      }, 24);
    }, 170);
  }

  /** Lands on a tab with no animation, for restores and resets. */
  function jumpTo(nextTab: T) {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setTab(nextTab);
    setRenderedTab(nextTab);
    setTransition("idle");
  }

  return { tab, renderedTab, transition, switchTab, jumpTo };
}
