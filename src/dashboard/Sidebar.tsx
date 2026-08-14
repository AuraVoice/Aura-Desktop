import { NavLink, useLocation } from "react-router-dom";
import iconUrl from "../assets/icons/Aura-Icon.png";
import { PolishedPill } from "../components/PolishedPill";
import {
  footerNavItems,
  primaryNavItems,
  settingsNavItem,
  type NavItem,
} from "./navConfig";

const SETTINGS_ROUTES = new Set(["/general", "/system", "/account", "/billing", "/privacy"]);

interface SidebarProps {
  collapsed: boolean;
}

export function Sidebar({ collapsed }: SidebarProps) {
  const location = useLocation();
  const settingsActive = SETTINGS_ROUTES.has(location.pathname);
  const SettingsIcon = settingsNavItem.Icon;

  return (
    <aside className={`db-sidebar${collapsed ? " db-sidebar-collapsed" : ""}`}>
      <div className="db-sidebar-top">
        <div className="db-sidebar-brand">
          <img src={iconUrl} className="db-logo" alt="" />
          <span className="db-wordmark">Aura</span>
        </div>
      </div>

      <nav className="db-nav">
        {primaryNavItems.map((item) => <SidebarLink key={item.to} item={item} collapsed={collapsed} />)}
      </nav>

      <div className="db-sidebar-foot">
        <NavLink
          to={settingsNavItem.to}
          className={`db-nav-item${settingsActive ? " db-nav-item-active" : ""}`}
          title={collapsed ? settingsNavItem.label : undefined}
          aria-current={settingsActive ? "page" : undefined}
        >
          <SettingsIcon size={20} className="db-nav-icon" aria-hidden />
          <span className="db-nav-label">{settingsNavItem.label}</span>
        </NavLink>
        {footerNavItems.map((item) => <SidebarLink key={item.to} item={item} collapsed={collapsed} />)}
      </div>
    </aside>
  );
}

function SidebarLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { to, label, Icon } = item;
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `db-nav-item${isActive ? " db-nav-item-active" : ""}`}
      title={collapsed ? `${label}${item.beta ? " (Beta)" : ""}` : undefined}
    >
      <Icon size={20} className="db-nav-icon" aria-hidden />
      <span className="db-nav-label">{label}</span>
      {item.beta && <PolishedPill className="db-nav-beta">Beta</PolishedPill>}
    </NavLink>
  );
}
