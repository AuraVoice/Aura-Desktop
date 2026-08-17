import { useEffect, useRef, useState, type ReactElement } from "react";
import { NavLink } from "react-router-dom";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  CloudCheck,
  CreditCard,
  AudioLines,
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
import { VoicePage } from "./pages/VoicePage";

interface SettingsItem {
  to: string;
  label: string;
  Icon: LucideIcon;
}

const SETTINGS_ITEMS: SettingsItem[] = [
  { to: "/general", label: "General", Icon: SlidersHorizontal },
  { to: "/voice", label: "Voice", Icon: AudioLines },
  { to: "/system", label: "System", Icon: Monitor },
];

const ACCOUNT_ITEMS: SettingsItem[] = [
  { to: "/account", label: "Account", Icon: UserRound },
  { to: "/billing", label: "Plans and Billing", Icon: CreditCard },
  { to: "/privacy", label: "Data and Privacy", Icon: ShieldCheck },
];

const SETTINGS_PAGES: Record<string, ReactElement> = {
  "/general": <GeneralPage section="general" />,
  "/voice": <VoicePage />,
  "/system": <GeneralPage section="system" />,
  "/account": <AccountPage />,
  "/billing": <BillingPage />,
  "/privacy": <GeneralPage section="privacy" />,
};

export const settingsRoutes = new Set(Object.keys(SETTINGS_PAGES));

interface ManualUpdateCheckResult {
  status: "up_to_date" | "ready";
  version: string | null;
}

export function SettingsDialog({ path, onClose }: { path: string; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [version, setVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<"idle" | "checking" | "up_to_date" | "ready" | "error">("idle");
  const [showUpdateHint, setShowUpdateHint] = useState(false);
  const versionLabel = version ? `Aura v${version}` : "Aura";
  const updateHint = updateStatus === "idle" ? "Check for updates" : updateStatusLabel(updateStatus);
  const updateHintVisible = showUpdateHint || updateStatus !== "idle";

  useEffect(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    panelRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
      restoreRef.current?.focus?.();
    };
  }, [onClose]);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch(() => {
        setVersion("");
      });
  }, []);

  async function checkForUpdate() {
    if (updateStatus === "checking") return;
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setShowUpdateHint(true);
    setUpdateStatus("checking");
    try {
      const result = await invoke<ManualUpdateCheckResult>("check_for_update");
      showUpdateStatus(result.status);
    } catch {
      showUpdateStatus("error");
    }
  }

  function showUpdateStatus(status: "up_to_date" | "ready" | "error") {
    setUpdateStatus(status);
    setShowUpdateHint(true);
    statusTimerRef.current = setTimeout(() => {
      setShowUpdateHint(false);
      setUpdateStatus("idle");
    }, 3000);
  }

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
          <div className="db-settings-version">
            <div className="db-settings-version-row">
              <span>{versionLabel}</span>
              <div
                className="db-settings-update-wrap"
                onMouseEnter={() => setShowUpdateHint(true)}
                onMouseLeave={() => {
                  if (updateStatus === "idle") setShowUpdateHint(false);
                }}
              >
                {updateHintVisible && (
                  <span className="db-settings-update-hint" role="status">
                    {updateHint}
                  </span>
                )}
                <button
                  type="button"
                  className="db-settings-update-btn"
                  aria-label="Check for updates"
                  onClick={checkForUpdate}
                  disabled={updateStatus === "checking"}
                >
                  <CloudCheck size={22} aria-hidden />
                </button>
              </div>
            </div>
          </div>
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

function updateStatusLabel(status: "checking" | "up_to_date" | "ready" | "error" | "idle") {
  switch (status) {
    case "checking":
      return "Checking for updates...";
    case "up_to_date":
      return "Up-to-date";
    case "ready":
      return "Update ready";
    case "error":
      return "Update check failed.";
    default:
      return "";
  }
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
