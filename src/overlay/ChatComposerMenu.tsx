import { useEffect, useRef, type RefObject } from "react";
import { Check, FileText, Gauge, Image, type LucideIcon } from "lucide-react";

export interface ChatComposerMenuItem {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Shown as a trailing check and an accent tint, for toggles. */
  checked?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface ChatComposerMenuProps {
  items: ChatComposerMenuItem[];
  onClose: () => void;
  /** The button that opened this. A press on it is its own toggle, so the
   * outside-click close must not fire first and hand the click a closed menu. */
  anchorRef?: RefObject<HTMLElement | null>;
}

export const CHAT_COMPOSER_MENU_ICONS = { photos: Image, files: FileText, think: Gauge } as const;

/** The "+" menu, the desktop twin of mobile's ComposerPlusMenu: a floating card
 * of rows that rises from the button. Rendered inside the chat card because
 * GlassSurface clips overflow. Closing runs before the row's action so the
 * native file dialog opens over a settled composer. */
export function ChatComposerMenu({ items, onClose, anchorRef }: ChatComposerMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = rootRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    first?.focus();
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
    <div ref={rootRef} className="chat-composer-popover chat-composer-menu" role="menu">
      {items.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="menuitemcheckbox"
            aria-checked={item.checked ?? false}
            className={`chat-composer-menu-item${item.checked ? " checked" : ""}`}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{item.label}</span>
            {item.checked && <Check size={14} className="chat-composer-menu-check" aria-hidden="true" />}
          </button>
        );
      })}
    </div>
  );
}
