import { useEffect, useId, useRef, useState } from "react";
import { Search, X } from "lucide-react";

/**
 * A search icon that expands leftward into a fixed-width input.
 *
 * The leftward motion falls out of layout rather than a transform: the toggle
 * sits at the right end of a `flex-end` cluster, so growing the field's width
 * can only push its LEFT edge outward and the icon never moves. The field is a
 * fixed 260px, deliberately not a percentage, so it never spans the column.
 *
 * Blur behaviour is asymmetric on purpose. Blurring with an empty query closes,
 * because an empty field is just clutter. Blurring with a query keeps it open,
 * because collapsing it would leave the list filtered with nothing on screen
 * explaining why.
 */
export function ExpandingSearch({
  value,
  onChange,
  placeholder,
  label = "Search",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const inputId = useId();

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    onChange("");
    // Focus must land somewhere deliberate; letting it fall to <body> makes a
    // keyboard user tab from the top of the page again.
    if (restoreFocus) toggleRef.current?.focus();
  };

  return (
    <div className={open ? "db-expanding-search is-open" : "db-expanding-search"}>
      <div className="db-expanding-search-field">
        <input
          ref={inputRef}
          id={inputId}
          type="search"
          value={value}
          placeholder={placeholder}
          tabIndex={open ? 0 : -1}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            }
          }}
          onBlur={() => {
            if (value.trim() === "") setOpen(false);
          }}
        />
      </div>
      <button
        ref={toggleRef}
        type="button"
        className="db-expanding-search-toggle"
        aria-label={open ? "Close search" : label}
        aria-expanded={open}
        aria-controls={inputId}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        {open ? <X size={17} /> : <Search size={17} />}
      </button>
    </div>
  );
}
