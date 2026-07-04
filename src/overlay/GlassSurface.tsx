import type { ReactNode } from "react";
import "./GlassSurface.css";

interface GlassSurfaceProps {
  children: ReactNode;
  className?: string;
  /** Whole surface (any non-interactive point in the subtree) is a drag handle by default - pass false to opt out entirely. Real inputs/buttons/links are never affected: Tauri's drag-region walk stops at any clickable tag that doesn't itself carry the attribute. */
  draggable?: boolean;
}

export function GlassSurface({ children, className, draggable = true }: GlassSurfaceProps) {
  return (
    <div
      className={`glass-surface${className ? ` ${className}` : ""}`}
      {...(draggable ? { "data-tauri-drag-region": "deep" } : {})}
    >
      {children}
    </div>
  );
}
