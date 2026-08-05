import { useEffect, useRef, type ReactElement } from "react";
import { NavLink } from "react-router-dom";
import {
  CreditCard,
  Monitor,
  SlidersHorizontal,
  UserRound,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { AccountPage } from "./pages/AccountPage";
import { BillingPage } from "./pages/BillingPage";
import { GeneralPage } from "./pages/GeneralPage";

interface SettingsItem {
  to: string;
  label: string;
  Icon: LucideIcon;
}

const SETTINGS_ITEMS: SettingsItem[] = [
  { to: "/general", label: "General", Icon: SlidersHorizontal },
  { to: "/system", label: "System", Icon: Monitor },
];

const ACCOUNT_ITEMS: SettingsItem[] = [
  { to: "/account", label: "Account", Icon: UserRound },
  { to: "/billing", label: "Plans and Billing", Icon: CreditCard },
  { to: "/privacy", label: "Data and Privacy", Icon: ShieldCheck },
];

const SETTINGS_PAGES: Record<string, ReactElement> = {
  "/general": <GeneralPage section="general" />,
  "/system": <GeneralPage section="system" />,
  "/account": <AccountPage />,
  "/billing": <BillingPage />,
  "/privacy": <GeneralPage section="privacy" />,
};

export const settingsRoutes = new Set(Object.keys(SETTINGS_PAGES));

export function SettingsDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="db-settings-scrim" onClick={onClose}>
      <div
        ref={panelRef}
        className="db-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <aside className="db-settings-dialog-sidebar">
          <SettingsGroup heading="Settings" items={SETTINGS_ITEMS} />
          <SettingsGroup heading="Account" items={ACCOUNT_ITEMS} />
        </aside>
        <main className="db-settings-dialog-content">
          {SETTINGS_PAGES[path] ?? SETTINGS_PAGES["/general"]}
        </main>
        <button
          type="button"
          className="db-settings-dialog-close"
          aria-label="Close settings"
          onClick={onClose}
        >
          <X size={20} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function SettingsGroup({ heading, items }: { heading: string; items: SettingsItem[] }) {
  return (
    <div className="db-settings-dialog-group">
      <div className="db-settings-dialog-heading">{heading}</div>
      <nav aria-label={`${heading} settings`}>
        {items.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `db-settings-dialog-item${isActive ? " is-active" : ""}`
            }
          >
            <Icon size={19} aria-hidden />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
