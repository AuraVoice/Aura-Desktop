import type { ReactNode } from "react";
import { Minus, PanelLeftClose, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { logError } from "../lib/log";

function runWindowAction(action: "minimize" | "maximize" | "close") {
  const window = getCurrentWindow();
  const pending = action === "minimize"
    ? window.minimize()
    : action === "maximize"
      ? window.toggleMaximize()
      : window.close();
  pending.catch((err) => logError(`DashboardTitleBar: ${action}`, err));
}

export function DashboardTitleBar({
  collapsed,
  onToggle,
  left,
  right,
}: {
  collapsed: boolean;
  onToggle?: () => void;
  /** Sits beside the collapse button (the profile). */
  left?: ReactNode;
  /** Sits before the minimize button (the bell). */
  right?: ReactNode;
}) {
  return (
    <header className="db-window-titlebar">
      {onToggle && (
        <div className={`db-window-sidebar-control${collapsed ? " is-collapsed" : ""}`}>
          <button
            type="button"
            className="db-collapse"
            onClick={onToggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
          >
            <PanelLeftClose size={20} className="db-collapse-icon" aria-hidden />
          </button>
          {left}
        </div>
      )}
      <div
        className="db-window-drag-region"
        data-tauri-drag-region
        onDoubleClick={() => runWindowAction("maximize")}
      />
      {right && <div className="db-window-extra">{right}</div>}
      <div className="db-window-controls">
        <button
          type="button"
          className="db-window-minimize"
          aria-label="Minimize"
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={() => runWindowAction("minimize")}
        >
          <Minus size={16} aria-hidden />
        </button>
        <button
          type="button"
          className="db-window-maximize"
          aria-label="Maximize"
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={() => runWindowAction("maximize")}
        >
          <Square size={13} aria-hidden />
        </button>
        <button
          type="button"
          className="db-window-close"
          aria-label="Close"
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={() => runWindowAction("close")}
        >
          <X size={17} aria-hidden />
        </button>
      </div>
    </header>
  );
}
