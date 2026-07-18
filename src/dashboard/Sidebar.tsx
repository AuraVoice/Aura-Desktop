import { NavLink } from "react-router-dom";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import iconUrl from "../assets/icons/Aura-Icon.png";
import { navSections } from "./navConfig";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <aside className={`db-sidebar${collapsed ? " db-sidebar-collapsed" : ""}`}>
      <div className="db-sidebar-top">
        <img src={iconUrl} className="db-logo" alt="" />
        {!collapsed && <span className="db-wordmark">Aura</span>}
      </div>

      <nav className="db-nav">
        {navSections.map((section, index) => (
          <div className="db-nav-section" key={section.heading ?? `section-${index}`}>
            {section.heading && !collapsed && (
              <div className="db-nav-heading">{section.heading}</div>
            )}
            {section.items.map(({ to, label, Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `db-nav-item${isActive ? " db-nav-item-active" : ""}`
                }
                title={collapsed ? label : undefined}
              >
                <Icon size={20} className="db-nav-icon" aria-hidden />
                {!collapsed && <span className="db-nav-label">{label}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="db-sidebar-foot">
        <button
          type="button"
          className="db-collapse"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
          {!collapsed && <span className="db-collapse-label">Collapse</span>}
        </button>
      </div>
    </aside>
  );
}
