import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

const EXIT_MS = 170;

/** Centered detail overlay. Closes on scrim click, the top-right ✕, or Esc, and
 * animates both in and out (it stays mounted for the exit animation). Rendered
 * through a portal into .db-app so it inherits the dashboard tokens and styled
 * scrollbar. The panel stops click propagation so an inside click never
 * dismisses. Restores focus to whatever was focused before it opened.
 *
 * `headerAction` renders to the left of the close button (e.g. a Copy button).
 * `panelClassName` adds to the panel's classes for callers that need a
 * different surface treatment while keeping this component's focus, escape,
 * click-outside, portal, and exit-animation behavior. */
export function DetailModal({
  open,
  title,
  centerTitle = false,
  onClose,
  headerAction,
  panelClassName = "",
  children,
}: {
  open: boolean;
  title?: string;
  centerTitle?: boolean;
  onClose: () => void;
  headerAction?: ReactNode;
  panelClassName?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);

  // Keep the node mounted through the exit animation.
  useEffect(() => {
    if (open) {
      setMounted(true);
      setClosing(false);
      return;
    }
    if (!mounted) return;
    setClosing(true);
    const timer = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, EXIT_MS);
    return () => clearTimeout(timer);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!mounted) return null;

  const target =
    (typeof document !== "undefined" && document.querySelector(".db-app")) || document.body;

  return createPortal(
    <div
      className={`db-modal-scrim${closing ? " db-modal-scrim-out" : ""}`}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className={`db-modal-panel${closing ? " db-modal-panel-out" : ""}${panelClassName ? ` ${panelClassName}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`db-modal-head${centerTitle ? " db-modal-head-centered" : ""}`}>
          {title && <h2 className="db-modal-title" title={title}>{title}</h2>}
          <div className="db-modal-head-actions">
            {headerAction}
            <button type="button" className="db-modal-close" aria-label="Close" onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="db-modal-body">{children}</div>
      </div>
    </div>,
    target,
  );
}
