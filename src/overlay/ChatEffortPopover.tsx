import { useEffect, useRef, type CSSProperties, type RefObject } from "react";

/**
 * How hard Aura should think about the next message, mirroring the mobile
 * app's `BuddyEffort` (lib/presentation/widgets/effort_selector.dart).
 *
 * Presentation only for now: the chat request carries no field for it yet, on
 * either platform. The state lives in ChatSlot for the life of the card and is
 * neither persisted nor sent. When the backend grows a field, wire it in
 * useChatSession's send path; nothing here needs to change.
 */
export type ChatEffort = "low" | "medium" | "high" | "ultra";

export interface ChatEffortLevel {
  id: ChatEffort;
  label: string;
  description: string;
}

export const CHAT_EFFORT_LEVELS: readonly ChatEffortLevel[] = [
  { id: "low", label: "Low", description: "Fastest. Quick answers." },
  { id: "medium", label: "Medium", description: "Balanced speed and care." },
  { id: "high", label: "High", description: "Deeper reasoning. Slower." },
  { id: "ultra", label: "Ultra", description: "Max effort. Slowest." },
];

export const DEFAULT_CHAT_EFFORT: ChatEffort = "medium";

export function effortIndex(effort: ChatEffort): number {
  return Math.max(0, CHAT_EFFORT_LEVELS.findIndex((level) => level.id === effort));
}

export function effortLevel(effort: ChatEffort): ChatEffortLevel {
  return CHAT_EFFORT_LEVELS[effortIndex(effort)];
}

interface ChatEffortPopoverProps {
  effort: ChatEffort;
  onChange: (effort: ChatEffort) => void;
  onClose: () => void;
  /** The button that opened this. A press on it is its own toggle, so the
   * outside-click close must not fire first and hand the click a closed menu. */
  anchorRef?: RefObject<HTMLElement | null>;
}

/** Floats above the composer inside the card (GlassSurface clips overflow, so
 * it cannot hang outside). Escape and an outside click close it; Escape is
 * stopped here so the overlay's window-level handler never sees it and closes
 * the whole chat. */
export function ChatEffortPopover({ effort, onChange, onClose, anchorRef }: ChatEffortPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);
  const level = effortLevel(effort);
  const index = effortIndex(effort);

  useEffect(() => {
    sliderRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchorRef?.current?.contains(target)) return;
      if (rootRef.current && !rootRef.current.contains(target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchorRef, onClose]);

  return (
    <div
      ref={rootRef}
      className="chat-composer-popover chat-effort-popover"
      role="dialog"
      aria-label="Effort"
    >
      <p className="chat-effort-summary">
        <strong>{level.label}.</strong> {level.description}
      </p>
      <div
        className="chat-effort-slider"
        style={{ "--effort-frac": index / (CHAT_EFFORT_LEVELS.length - 1) } as CSSProperties}
      >
        <span className="chat-effort-track" aria-hidden="true">
          <span className="chat-effort-fill" />
          <span className="chat-effort-stops">
            {CHAT_EFFORT_LEVELS.map((item, itemIndex) => (
              <i
                key={item.id}
                className={`chat-effort-stop${itemIndex <= index ? " reached" : ""}`}
                style={{ left: `${(itemIndex / (CHAT_EFFORT_LEVELS.length - 1)) * 100}%` }}
              />
            ))}
          </span>
        </span>
        <input
          ref={sliderRef}
          type="range"
          min={0}
          max={CHAT_EFFORT_LEVELS.length - 1}
          step={1}
          value={index}
          aria-label="Effort level"
          aria-valuetext={level.label}
          onChange={(event) => onChange(CHAT_EFFORT_LEVELS[Number(event.target.value)].id)}
        />
      </div>
    </div>
  );
}
