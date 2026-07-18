import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

/** Centered detail overlay. Closes on scrim click, the top-right ✕, or Esc.
 * Rendered through a portal so it escapes the scrolling content and any stacking
 * context. The panel itself stops click propagation so an inside click never
 * dismisses. Restores focus to whatever was focused before it opened. */
export function DetailModal({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Focus the panel so Esc and screen readers land on the dialog.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      restoreRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="db-modal-scrim" onClick={onClose}>
      <div
        ref={panelRef}
        className="db-modal-panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="db-modal-head">
          {title && <h2 className="db-modal-title">{title}</h2>}
          <button type="button" className="db-modal-close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="db-modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
