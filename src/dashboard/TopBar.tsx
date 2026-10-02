import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, LogOut, UserRound } from "lucide-react";
import { type User as FirebaseUser } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NOTIFICATION_TOAST_ACTIVATED } from "../lib/ipcEvents";
import { logError } from "../lib/log";
import { signOutSession } from "../lib/signOutSession";
import { NotificationsPanel } from "./NotificationsPanel";
import { agentsPath } from "./pages/AgentsPage";
import type { DashboardNotificationsState } from "./useDashboardNotifications";
import type { StoredNotification } from "../lib/desktopNotifications";

/** Payload of a clicked Windows toast, forwarded by src-tauri/src/toast.rs
 *  either live (event) or via the pending-activation handoff when the click
 *  itself opened this window. */
interface ToastActivation {
  notificationId: string;
  action: string | null;
}

function researchDestination(resourceId: string | null | undefined): string {
  return agentsPath("research", resourceId);
}

function browserTaskDestination(resourceId: string | null | undefined): string {
  return agentsPath("computer", resourceId);
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

/** The bell beside the window buttons. It also owns toast-click routing, so it must
 * mount with the shell: a click that opened the window is drained from here. */
export function NotificationBell({ notifications }: { notifications?: DashboardNotificationsState }) {
  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const unread = notifications?.unreadCount ?? 0;
  const markNotificationSeen = notifications?.markSeen;

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
      } else if (
        activation.action === "view_research" ||
        activation.action === "answer_research_question"
      ) {
        const row = notifications?.inbox.find((item) => item.notificationId === activation.notificationId);
        setNotifOpen(false);
        navigate(researchDestination(row?.resourceId));
      } else if (activation.action === "view_browser_task") {
        const row = notifications?.inbox.find((item) => item.notificationId === activation.notificationId);
        setNotifOpen(false);
        navigate(browserTaskDestination(row?.resourceId));
      } else {
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
    listen<ToastActivation>(NOTIFICATION_TOAST_ACTIVATED, (event) => {
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
  }, [markNotificationSeen, navigate, notifications?.inbox]);

  function selectNotification(row: StoredNotification) {
    if (!row.seen) notifications?.markSeen(row.notificationId);
    if (row.action === "view_meeting" || row.action === "retry_meeting_upload") {
      setNotifOpen(false);
      navigate("/meetings");
    } else if (row.action === "view_research" || row.action === "answer_research_question") {
      setNotifOpen(false);
      navigate(researchDestination(row.resourceId));
    } else if (row.action === "view_browser_task") {
      setNotifOpen(false);
      navigate(browserTaskDestination(row.resourceId));
    }
  }

  return (
    <div className="db-notif-menu" ref={notifRef}>
      <button
        type="button"
        className="db-window-bell"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-haspopup="true"
        aria-expanded={notifOpen}
        title="Notifications"
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={() => setNotifOpen((v) => !v)}
      >
        <Bell aria-hidden />
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
  );
}

/** The profile beside the collapse button: avatar and name, with the email,
 * View profile and Sign out in its menu. */
export function AccountMenu({ user }: { user: FirebaseUser | null }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const name = user?.displayName || user?.email?.split("@")[0] || "Signed out";
  const email = user?.email ?? "";

  useDismissable(menuRef, open, () => setOpen(false));

  function viewProfile() {
    setOpen(false);
    navigate("/account");
  }

  function handleSignOut() {
    setOpen(false);
    signOutSession().catch((err) => logError("TopBar: sign out", err));
  }

  return (
    <div className="db-account-menu" ref={menuRef}>
      <button
        type="button"
        className={`db-account-btn${open ? " db-account-btn-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${name}`}
        title={name}
      >
        <UserRound size={22} aria-hidden />
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
  );
}
