import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, ChevronDown, LogOut, UserRound } from "lucide-react";
import { signOut, type User as FirebaseUser } from "firebase/auth";
import { auth } from "../lib/firebase";
import { logError } from "../lib/log";

interface TopBarProps {
  title: string;
  user: FirebaseUser | null;
  unread?: number;
}

function initialsFor(user: FirebaseUser | null): string {
  const source = user?.displayName || user?.email || "";
  const parts = source.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Avatar that falls back to initials when there is no photo, or when a
 * provider photo URL fails to load (Google avatars are frequently rate-limited
 * inside the desktop webview, which otherwise leaves a broken-image glyph). */
function Avatar({ user, size }: { user: FirebaseUser | null; size: "sm" | "lg" }) {
  const [failed, setFailed] = useState(false);
  const photo = user?.photoURL;
  const showPhoto = photo && !failed;
  return (
    <span className={`db-avatar db-avatar-${size}`}>
      {showPhoto ? (
        <img
          src={photo}
          alt=""
          className="db-avatar-img"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="db-avatar-initials">{initialsFor(user)}</span>
      )}
    </span>
  );
}

export function TopBar({ title, user, unread = 0 }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const name = user?.displayName || user?.email?.split("@")[0] || "Signed out";
  const email = user?.email ?? "";

  // Close the account menu on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function viewProfile() {
    setOpen(false);
    navigate("/account");
  }

  function handleSignOut() {
    setOpen(false);
    // The main window's AuthProvider observes this shared Firebase session and
    // revokes native authorization when it goes null, so a plain signOut here
    // is enough - no direct native call from the dashboard window.
    signOut(auth).catch((err) => logError("TopBar: sign out", err));
  }

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

        <div className="db-account-menu" ref={menuRef}>
          <button
            type="button"
            className={`db-account-btn${open ? " db-account-btn-open" : ""}`}
            onClick={() => setOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Account"
          >
            <Avatar user={user} size="sm" />
            <span className="db-account-meta">
              <span className="db-account-name">{name}</span>
              {email && <span className="db-account-email">{email}</span>}
            </span>
            <ChevronDown size={16} className="db-account-chevron" aria-hidden />
          </button>

          {open && (
            <div className="db-popover" role="menu">
              <div className="db-popover-head">
                <Avatar user={user} size="lg" />
                <div className="db-popover-id">
                  <span className="db-popover-name">{name}</span>
                  {email && <span className="db-popover-email">{email}</span>}
                </div>
              </div>
              <div className="db-popover-sep" />
              <button type="button" className="db-popover-item" role="menuitem" onClick={viewProfile}>
                <UserRound size={17} aria-hidden />
                <span>View profile</span>
              </button>
              <button
                type="button"
                className="db-popover-item db-popover-item-danger"
                role="menuitem"
                onClick={handleSignOut}
              >
                <LogOut size={17} aria-hidden />
                <span>Sign out</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
