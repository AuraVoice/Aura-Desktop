import { useLayoutEffect, useRef } from "react";

/** Time-range filter for Conversations, mirroring the web dashboard's chips.
 * The selected range maps to the `?since=` query on GET /history/sessions
 * ("all" omits it). */

export type RangeKey = "today" | "3d" | "7d" | "30d" | "all";

const RANGE_DAYS: Record<RangeKey, number | null> = {
  today: 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
  all: null,
};

const RANGE_LABEL: Record<RangeKey, string> = {
  today: "Today",
  "3d": "3 days",
  "7d": "7 days",
  "30d": "30 days",
  all: "All",
};

export const RANGE_ORDER: RangeKey[] = ["today", "3d", "7d", "30d", "all"];

/** ISO `since` for a range, or undefined for "all". */
export function sinceFromRange(range: RangeKey): string | undefined {
  const days = RANGE_DAYS[range];
  if (days == null) return undefined;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function RangeChips({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (range: RangeKey) => void;
}) {
  const stripRef = useRef<HTMLDivElement | null>(null);

  // The active fill is one sliding bar behind the chips; measure the selected
  // chip so the bar glides between labels of different widths.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => {
      const active = strip.querySelector<HTMLElement>(".db-chip-active");
      if (!active) return;
      strip.style.setProperty("--chip-x", `${active.offsetLeft - strip.clientLeft}px`);
      strip.style.setProperty("--chip-w", `${active.offsetWidth}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [value]);

  return (
    <div className="db-chips" role="tablist" aria-label="Time range" ref={stripRef}>
      {RANGE_ORDER.map((range) => (
        <button
          key={range}
          type="button"
          role="tab"
          aria-selected={range === value}
          className={`db-chip${range === value ? " db-chip-active" : ""}`}
          onClick={() => onChange(range)}
        >
          {RANGE_LABEL[range]}
        </button>
      ))}
    </div>
  );
}
