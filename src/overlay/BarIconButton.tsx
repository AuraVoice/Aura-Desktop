import type { ReactNode } from "react";
import "./BarIconButton.css";

interface BarIconButtonProps {
  onClick: () => void;
  title: string;
  children: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}

export function BarIconButton({ onClick, title, children, active, danger, disabled }: BarIconButtonProps) {
  const classNames = ["bar-icon-button"];
  if (active) classNames.push("bar-icon-button-active");
  if (danger) classNames.push("bar-icon-button-danger");

  return (
    <button
      type="button"
      className={classNames.join(" ")}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
