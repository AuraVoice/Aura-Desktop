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
}: {
  collapsed: boolean;
  onToggle?: () => void;
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
            <PanelLeftClose size={18} className="db-collapse-icon" aria-hidden />
          </button>
        </div>
      )}
      <div
        className="db-window-drag-region"
        data-tauri-drag-region
        onDoubleClick={() => runWindowAction("maximize")}
      />
      <div className="db-window-controls">
        <button
          type="button"
          aria-label="Minimize"
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={() => runWindowAction("minimize")}
        >
          <Minus size={16} aria-hidden />
        </button>
        <button
          type="button"
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
