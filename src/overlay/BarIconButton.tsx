import type { ReactNode } from "react";
import "./BarIconButton.css";

interface BarIconButtonProps {
  onClick: () => void;
  title: string;
  children: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  /** Appended to the tooltip in parentheses, e.g. ["Ctrl", "Alt", "S"] -> "(Ctrl+Alt+S)". */
  shortcut?: readonly string[];
  /** Extra class for button-specific styling (e.g. an icon animation) beyond active/danger. */
  className?: string;
}

export function BarIconButton({ onClick, title, children, active, danger, disabled, shortcut, className }: BarIconButtonProps) {
  const classNames = ["bar-icon-button"];
  if (active) classNames.push("bar-icon-button-active");
  if (danger) classNames.push("bar-icon-button-danger");
  if (className) classNames.push(className);

  // Native title/aria-label, not a custom popover: this bar's own window is
  // only 64px tall, so a CSS tooltip has nowhere to render above the icons
  // without being clipped by the window's own bounds. The OS renders a native
  // tooltip independently of that, so it isn't boxed in the same way.
  const fullTitle = shortcut && shortcut.length > 0 ? `${title} (${shortcut.join("+")})` : title;

  return (
    <button
      type="button"
      className={classNames.join(" ")}
      title={fullTitle}
      aria-label={fullTitle}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
