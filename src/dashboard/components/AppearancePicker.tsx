import { useLayoutEffect, useRef } from "react";
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import type { ThemeSetting } from "../../lib/generalSettings";
import { osName } from "../../lib/platformKeys";
import { applyTheme, resolveTheme } from "../../theme/themeEngine";
import "./AppearancePicker.css";

interface AppearanceOption {
  value: ThemeSetting;
  label: string;
  hint: string;
  Icon: LucideIcon;
}

function appearanceOptions(): AppearanceOption[] {
  return [
    { value: "system", label: "System", hint: `Match ${osName()}`, Icon: Monitor },
    { value: "light", label: "Light", hint: "Bright glass", Icon: Sun },
    { value: "dark", label: "Dark", hint: "Deep green glass", Icon: Moon },
  ];
}

/** A miniature dashboard drawn in CSS: sidebar, title, two stat cards and a
 * wide card. Each scene paints its own theme regardless of the current one. */
function Scene({ tone }: { tone: "light" | "dark" }) {
  return (
    <span className={`db-ap-scene db-ap-scene-${tone}`}>
      <span className="db-ap-sidebar">
        <span className="db-ap-nav is-active" />
        <span className="db-ap-nav" />
        <span className="db-ap-nav" />
      </span>
      <span className="db-ap-title" />
      <span className="db-ap-card db-ap-card-a">
        <span className="db-ap-dot" />
      </span>
      <span className="db-ap-card db-ap-card-b" />
      <span className="db-ap-card db-ap-card-wide" />
    </span>
  );
}

/**
 * Settings > System > Appearance. A real radiogroup with roving focus, the same
 * contract as SegmentedChoice. The selection ring is one element that slides
 * between tiles; its position is measured onto CSS variables, like SlidingTabs.
 */
export function AppearancePicker({
  value,
  onChange,
}: {
  value: ThemeSetting;
  onChange: (value: ThemeSetting) => void;
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const options = appearanceOptions();

  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const measure = () => {
      const active = group.querySelector<HTMLElement>("button[aria-checked='true']");
      if (!active) return;
      group.style.setProperty("--ring-x", `${active.offsetLeft}px`);
      group.style.setProperty("--ring-y", `${active.offsetTop}px`);
      group.style.setProperty("--ring-w", `${active.offsetWidth}px`);
      group.style.setProperty("--ring-h", `${active.offsetHeight}px`);
      group.dataset.ready = "true";
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [value]);

  const choose = (next: ThemeSetting) => {
    if (next === value) return;
    applyTheme(resolveTheme(next), { animate: true });
    onChange(next);
  };

  const move = (delta: number) => {
    const index = options.findIndex((option) => option.value === value);
    const next = options[(index + delta + options.length) % options.length];
    choose(next.value);
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>("button")
      [options.indexOf(next)]?.focus();
  };

  return (
    <div className="db-appearance" role="radiogroup" aria-label="Appearance" ref={groupRef}>
      <span className="db-appearance-ring" aria-hidden />
      {options.map(({ value: optionValue, label, hint, Icon }) => {
        const selected = optionValue === value;
        return (
          <button
            key={optionValue}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`db-appearance-tile db-appearance-tile-${optionValue}${selected ? " is-active" : ""}`}
            onClick={() => choose(optionValue)}
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
            <span className="db-appearance-preview" aria-hidden>
              {optionValue !== "dark" && <Scene tone="light" />}
              {optionValue !== "light" && <Scene tone="dark" />}
            </span>
            <span className="db-appearance-meta">
              <Icon size={16} className="db-appearance-icon" aria-hidden />
              <span className="db-appearance-label">{label}</span>
              <span className="db-appearance-hint">{hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
