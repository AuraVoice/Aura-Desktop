import { NavLink } from "react-router-dom";
import { HelpCircle } from "lucide-react";

/** The sidebar's Help entry. It used to roll between "Get help" and "Join
 * Discord" every few seconds; the sidebar no longer moves at rest, and the
 * Discord invite lives on the Help page this links to. */
export function HelpDiscordNavLink({ collapsed }: { collapsed: boolean }) {
  return (
    <NavLink
      to="/help"
      className={({ isActive }) => `db-nav-item${isActive ? " db-nav-item-active" : ""}`}
      title={collapsed ? "Get help" : undefined}
    >
      <HelpCircle size={20} className="db-nav-icon" aria-hidden />
      <span className="db-nav-label">Get help</span>
    </NavLink>
  );
}
