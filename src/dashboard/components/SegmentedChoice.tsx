import { useRef } from "react";

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
            <span className="db-segment-label">{option.label}</span>
            {option.hint && <span className="db-segment-hint">{option.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
