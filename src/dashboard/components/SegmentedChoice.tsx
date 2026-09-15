import { useLayoutEffect, useRef, useState } from "react";

// Ticker speed in px per second, plus the blank run between the end of the
// text and the start of its repeat.
const TICKER_SPEED = 36;
const TICKER_GAP = 28;

/**
 * Text that ellipsizes at rest and, only when it genuinely does not fit,
 * scrolls in a seamless loop while its segment is selected or hovered. The
 * second copy exists purely so the loop has no jump; it is hidden from
 * assistive tech, and CSS decides when it shows.
 */
function TickerText({ className, text }: { className: string; text: string }) {
  const boxRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const [duration, setDuration] = useState<number | null>(null);

  useLayoutEffect(() => {
    const box = boxRef.current;
    const inner = textRef.current;
    if (!box || !inner) return;
    const measure = () => {
      const textWidth = inner.getBoundingClientRect().width;
      const overflows = textWidth > box.clientWidth + 1;
      setDuration(overflows ? (textWidth + TICKER_GAP) / TICKER_SPEED : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [text]);

  const ticking = duration !== null;
  return (
    <span
      ref={boxRef}
      className={`${className}${ticking ? " db-ticker" : ""}`}
      style={ticking ? { ["--db-ticker-duration" as string]: `${duration}s` } : undefined}
    >
      <span className="db-ticker-track">
        <span className="db-ticker-copy">
          <span ref={textRef}>{text}</span>
        </span>
        {ticking && (
          <span className="db-ticker-copy db-ticker-repeat" aria-hidden="true">
            {text}
          </span>
        )}
      </span>
    </span>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  hint?: string;
}

/**
 * A single-choice segmented control for short option sets, used where a native
 * <select> would drop OS chrome into an otherwise custom layout.
 *
 * Implemented as a real radiogroup with roving focus: Tab reaches the group
 * once, then arrow keys move between options and select as they go, which is
 * what a keyboard user expects from a radio group.
 */
export function SegmentedChoice<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: Array<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);

  const move = (delta: number) => {
    const index = options.findIndex((option) => option.value === value);
    if (index < 0) return;
    const next = options[(index + delta + options.length) % options.length];
    onChange(next.value);
    const buttons = groupRef.current?.querySelectorAll<HTMLButtonElement>("button");
    buttons?.[options.indexOf(next)]?.focus();
  };

  return (
    <div className="db-segmented" role="radiogroup" aria-label={ariaLabel} ref={groupRef}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`db-segment${selected ? " db-segment-active" : ""}`}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              }
            }}
          >
            <TickerText className="db-segment-label" text={option.label} />
            {option.hint && <TickerText className="db-segment-hint" text={option.hint} />}
          </button>
        );
      })}
    </div>
  );
}
