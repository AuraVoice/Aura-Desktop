import { useLayoutEffect, useRef } from "react";
import { CircleCheck } from "lucide-react";
import { BuddyAvatar } from "../../components/BuddyAvatar";
import { COMPANION_AVATARS, type CompanionAvatarId } from "../../components/buddy/avatars";
import "./CompanionAvatarPicker.css";

/**
 * Settings > Companion > Choose an avatar. A real radiogroup with roving focus,
 * the same contract as AppearancePicker, with one selection ring that slides
 * between tiles. Each tile holds a live avatar that waves once and then idles
 * with its eyes on the pointer.
 */
export function CompanionAvatarPicker({
  value,
  disabled = false,
  onChange,
}: {
  value: CompanionAvatarId;
  disabled?: boolean;
  onChange: (value: CompanionAvatarId) => void;
}) {
  const groupRef = useRef<HTMLDivElement | null>(null);
  const options = COMPANION_AVATARS;

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

  const choose = (next: CompanionAvatarId) => {
    if (disabled || next === value) return;
    onChange(next);
  };

  const move = (delta: number) => {
    const index = options.findIndex((option) => option.id === value);
    const next = options[(index + delta + options.length) % options.length];
    choose(next.id);
    groupRef.current
      ?.querySelectorAll<HTMLButtonElement>("button")
      [options.indexOf(next)]?.focus();
  };

  return (
    <div
      className={`db-companion${disabled ? " is-disabled" : ""}`}
      role="radiogroup"
      aria-label="Companion avatar"
      aria-disabled={disabled || undefined}
      ref={groupRef}
    >
      <span className="db-companion-ring" aria-hidden />
      {options.map(({ id, name, tagline }) => {
        const selected = id === value;
        return (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`db-companion-tile${selected ? " is-active" : ""}`}
            onClick={() => choose(id)}
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
            <span className="db-companion-stage" aria-hidden>
              <BuddyAvatar move="idle" size={96} waveCount={1} followPointer />
            </span>
            <span className="db-companion-meta">
              <span className="db-companion-name">{name}</span>
              <span className="db-companion-tagline">{tagline}</span>
            </span>
            {selected && <CircleCheck size={20} className="db-companion-check" aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
