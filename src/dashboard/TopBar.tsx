import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, ChevronDown, LogOut, UserRound } from "lucide-react";
import { type User as FirebaseUser } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { logError } from "../lib/log";
import { signOutSession } from "../lib/signOutSession";
import { NotificationsPanel } from "./NotificationsPanel";
import type { DashboardNotificationsState } from "./useDashboardNotifications";
import type { StoredNotification } from "../lib/desktopNotifications";

interface TopBarProps {
  title: string;
  user: FirebaseUser | null;
  notifications?: DashboardNotificationsState;
}

/** Payload of a clicked Windows toast, forwarded by src-tauri/src/toast.rs
 *  either live (event) or via the pending-activation handoff when the click
 *  itself opened this window. */
interface ToastActivation {
  notificationId: string;
  action: string | null;
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

/** Close-on-outside-click / Escape for an anchored popover. */
function useDismissable(ref: React.RefObject<HTMLDivElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [ref, open, close]);
}

export function TopBar({ title, user, notifications }: TopBarProps) {
  const [open, setOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const name = user?.displayName || user?.email?.split("@")[0] || "Signed out";
  const email = user?.email ?? "";
  const unread = notifications?.unreadCount ?? 0;
  const markNotificationSeen = notifications?.markSeen;

  useDismissable(menuRef, open, () => setOpen(false));
  useDismissable(notifRef, notifOpen, () => setNotifOpen(false));

  // A clicked Windows toast routes here: mark the row seen and open the
  // responsible surface. Two delivery paths, same handler: a live event while
  // this window is open, and the pending handoff when the click itself opened
  // the window (the event would fire before this listener existed).
  useEffect(() => {
    if (!markNotificationSeen) return;
    const route = (activation: ToastActivation) => {
      markNotificationSeen(activation.notificationId);
      if (
        activation.action === "view_meeting" ||
        activation.action === "retry_meeting_upload"
      ) {
        setNotifOpen(false);
        navigate("/meetings");
      } else {
        setOpen(false);
        setNotifOpen(true);
      }
    };

    let disposed = false;
    let unlisten: (() => void) | undefined;
    const drainPending = async () => {
      try {
        while (!disposed) {
          const pending = await invoke<ToastActivation | null>(
            "take_pending_toast_activation",
            { notificationId: null },
          );
          if (!pending) break;
          route(pending);
        }
      } catch (err) {
        logError("TopBar: pending toast activation", err);
      }
    };
    listen<ToastActivation>("notification-toast-activated", (event) => {
      void invoke<ToastActivation | null>("take_pending_toast_activation", {
        notificationId: event.payload.notificationId,
      })
        .then((claimed) => {
          if (!disposed && claimed) route(claimed);
        })
        .catch((err) => logError("TopBar: claim live toast activation", err));
    })
      .then((fn) => {
        if (disposed) fn();
        else {
          unlisten = fn;
          void drainPending();
        }
      })
      .catch((err) => logError("TopBar: listen toast activation", err));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [markNotificationSeen, navigate]);

  function viewProfile() {
    setOpen(false);
    navigate("/account");
  }

  function handleSignOut() {
    setOpen(false);
    signOutSession().catch((err) => logError("TopBar: sign out", err));
  }

  function selectNotification(row: StoredNotification) {
    if (!row.seen) notifications?.markSeen(row.notificationId);
    if (row.action === "view_meeting" || row.action === "retry_meeting_upload") {
      setNotifOpen(false);
      navigate("/meetings");
    }
  }

  return (
    <header className="db-topbar">
      <h1 className="db-topbar-title">{title}</h1>
      <div className="db-topbar-actions">
        <div className="db-notif-menu" ref={notifRef}>
          <button
            type="button"
            className="db-icon-btn"
            aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
            aria-haspopup="true"
            aria-expanded={notifOpen}
            title="Notifications"
            onClick={() => {
              setOpen(false);
              setNotifOpen((v) => !v);
            }}
          >
            <Bell size={20} aria-hidden />
            {unread > 0 && (
              <span className="db-badge db-badge-count" aria-hidden>
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </button>

          {notifOpen && notifications && (
            <NotificationsPanel
              rows={notifications.inbox}
              onSelect={selectNotification}
              onDismiss={notifications.dismiss}
              onMarkAllRead={notifications.markAllSeen}
              hasUnread={unread > 0}
            />
          )}
        </div>

        <div className="db-account-menu" ref={menuRef}>
          <button
            type="button"
            className={`db-account-btn${open ? " db-account-btn-open" : ""}`}
            onClick={() => {
              setNotifOpen(false);
              setOpen((v) => !v);
            }}
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
