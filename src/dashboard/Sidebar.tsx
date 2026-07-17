import { NavLink } from "react-router-dom";
import { PanelLeft, PanelLeftClose } from "lucide-react";
import type { User as FirebaseUser } from "firebase/auth";
import iconUrl from "../assets/icons/Aura-Icon.png";
import { navSections } from "./navConfig";

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
  user: FirebaseUser | null;
}

function initialsFor(user: FirebaseUser | null): string {
  const source = user?.displayName || user?.email || "";
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function Sidebar({ collapsed, onToggle, user }: SidebarProps) {
  const name = user?.displayName || user?.email?.split("@")[0] || "Signed out";
  const email = user?.email ?? "";

  return (
    <aside className={`db-sidebar${collapsed ? " db-sidebar-collapsed" : ""}`}>
      <div className="db-sidebar-top">
        <img src={iconUrl} className="db-logo" alt="" />
        {!collapsed && <span className="db-wordmark">Aura</span>}
        <button
          type="button"
          className="db-collapse"
          onClick={onToggle}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <PanelLeft size={18} /> : <PanelLeftClose size={18} />}
        </button>
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

      <div className="db-user" title={collapsed ? `${name}${email ? ` · ${email}` : ""}` : undefined}>
        <div className="db-avatar">
          {user?.photoURL ? (
            <img src={user.photoURL} alt="" className="db-avatar-img" />
          ) : (
            <span className="db-avatar-initials">{initialsFor(user)}</span>
          )}
        </div>
        {!collapsed && (
          <div className="db-user-meta">
            <span className="db-user-name">{name}</span>
            {email && <span className="db-user-email">{email}</span>}
          </div>
        )}
      </div>
    </aside>
  );
}
