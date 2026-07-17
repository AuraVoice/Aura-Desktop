import { Bell, UserCircle2 } from "lucide-react";

interface TopBarProps {
  title: string;
  unread?: number;
}

export function TopBar({ title, unread = 0 }: TopBarProps) {
  return (
    <header className="db-topbar">
      <h1 className="db-topbar-title">{title}</h1>
      <div className="db-topbar-actions">
        <button
          type="button"
          className="db-icon-btn"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
          title="Notifications"
        >
          <Bell size={20} aria-hidden />
          {unread > 0 && <span className="db-badge" aria-hidden />}
        </button>
        <button type="button" className="db-icon-btn" aria-label="Account" title="Account">
          <UserCircle2 size={22} aria-hidden />
        </button>
      </div>
    </header>
  );
}
