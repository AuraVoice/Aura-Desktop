import type { ReactNode } from "react";
import "./PolishedPill.css";

interface PolishedPillProps {
  children: ReactNode;
  className?: string;
}

export function PolishedPill({ children, className }: PolishedPillProps) {
  return <span className={`aura-polished-pill${className ? ` ${className}` : ""}`}>{children}</span>;
}
