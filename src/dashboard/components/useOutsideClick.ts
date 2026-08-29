import { useEffect, type RefObject } from "react";

/**
 * Closes a popover on a click outside it or on Escape, and hands focus back to
 * whatever opened it.
 *
 * `pointerdown` rather than `click`: it fires before focus moves, so a click on
 * another row's trigger closes this menu and opens that one in the same
 * gesture, instead of the close handler stealing the second half of it.
 *
 * The focus return is the part that is easy to skip and wrong to skip. Without
 * it, dismissing a menu with Escape drops focus onto <body> and a keyboard user
 * has to tab from the top of the page again.
 */
export function useOutsideClick(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
  triggerRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return;

    const closeAndRestore = (restoreFocus: boolean) => {
      if (restoreFocus) triggerRef?.current?.focus();
      onClose();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (ref.current && target && ref.current.contains(target)) return;
      if (triggerRef?.current && target && triggerRef.current.contains(target)) return;
      closeAndRestore(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeAndRestore(true);
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, triggerRef, onClose, active]);
}
