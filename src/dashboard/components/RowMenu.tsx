import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import { useOutsideClick } from "./useOutsideClick";

/** Breathing room the menu needs below the trigger before it will drop down. */
const MENU_GAP_PX = 12;

export interface RowMenuItem {
  label: string;
  Icon: (props: { size?: number }) => ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Renders in the danger tone. Destructive items go last. */
  danger?: boolean;
}

/**
 * The overflow menu for a list row.
 *
 * `open` and `onOpenChange` are controlled by the list rather than held here,
 * because "only one menu is open at a time" is a property of the list, not of
 * any one row. Rendered inline rather than portalled: a portal to
 * document.body would fall outside `.db-app` and lose both the theme tokens
 * and the app-wide scrollbar rule.
 */
export function RowMenu({
  items,
  open,
  onOpenChange,
  label = "More actions",
}: {
  items: RowMenuItem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label?: string;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [dropUp, setDropUp] = useState(false);
  useOutsideClick(menuRef, () => onOpenChange(false), open, triggerRef);

  // Opens upward when there is not enough room below. The last row of the list
  // sits against the dashboard's scroll container, which clips just as the day
  // card used to, so a menu that only ever drops down is unreachable there.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const below = window.innerHeight - trigger.getBoundingClientRect().bottom;
    setDropUp(below < menu.offsetHeight + MENU_GAP_PX);
  }, [open]);

  return (
    <div className="db-row-menu">
      <button
        ref={triggerRef}
        type="button"
        className="db-row-action"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <MoreHorizontal size={17} />
      </button>
      {open && (
        <div
          className={dropUp ? "db-row-menu-panel is-up" : "db-row-menu-panel"}
          role="menu"
          ref={menuRef}
        >
          {items.map(({ label: itemLabel, Icon, onSelect, disabled, danger }) => (
            <button
              key={itemLabel}
              type="button"
              role="menuitem"
              className={danger ? "db-row-menu-item db-row-menu-danger" : "db-row-menu-item"}
              disabled={disabled}
              onClick={() => {
                onOpenChange(false);
                onSelect();
              }}
            >
              <Icon size={15} />
              {itemLabel}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
