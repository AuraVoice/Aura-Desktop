import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useOutsideClick } from "./useOutsideClick";

/** Breathing room the menu needs below the trigger before it will drop down. */
const MENU_GAP_PX = 12;
/** Gap between the trigger and the panel, matching the old `top: calc(100% + 4px)`. */
const MENU_OFFSET_PX = 4;

/** Viewport-relative placement, anchored by `right` so the panel width never
 *  has to be measured and the old right-edge alignment is preserved exactly. */
interface MenuPosition {
  right: number;
  top?: number;
  bottom?: number;
}

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
 * any one row.
 *
 * The panel is portalled into `.db-app` and positioned from the trigger's
 * rect. It cannot stay inline: the virtualized list wraps every row in a
 * `transform`ed element and paints a `backdrop-filter` inside it, and each of
 * those is a stacking context, so an inline panel is trapped behind the rows
 * that follow it no matter how high its z-index. `position: fixed` alone does
 * not help either, because both of those ancestors are also containing blocks
 * for fixed children. `.db-app` rather than document.body so the panel keeps
 * the theme tokens and the app-wide scrollbar rule.
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
  const [position, setPosition] = useState<MenuPosition | null>(null);
  useOutsideClick(menuRef, () => onOpenChange(false), open, triggerRef);

  // Opens upward when there is not enough room below. The last row of the list
  // sits against the dashboard's scroll container, which clips just as the day
  // card used to, so a menu that only ever drops down is unreachable there.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    const below = window.innerHeight - rect.bottom;
    setPosition(
      below < menu.offsetHeight + MENU_GAP_PX
        ? { right, bottom: window.innerHeight - rect.top + MENU_OFFSET_PX }
        : { right, top: rect.bottom + MENU_OFFSET_PX },
    );
  }, [open]);

  // A fixed panel no longer travels with its row, so anything that moves the
  // row underneath it has to dismiss it rather than leave it stranded.
  useEffect(() => {
    if (!open) return;
    const close = () => onOpenChange(false);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open, onOpenChange]);

  const host =
    typeof document === "undefined" ? null : document.querySelector(".db-app") ?? document.body;

  // Rendered before it is measured, so it is laid out (offsetHeight is needed
  // to decide the flip) but not painted until it has somewhere to be.
  const panel = open ? (
    <div
      className="db-row-menu-panel"
      role="menu"
      ref={menuRef}
      style={
        position
          ? { right: position.right, top: position.top, bottom: position.bottom }
          : { right: 0, top: 0, visibility: "hidden" }
      }
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
  ) : null;

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
      {panel && host ? createPortal(panel, host) : panel}
    </div>
  );
}
