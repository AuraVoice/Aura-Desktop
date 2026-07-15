import { BarIconButton } from "./BarIconButton";
import { GlassSurface } from "./GlassSurface";
import { BellIcon, CloseIcon, TrashIcon } from "./icons";
import type { StoredNotification } from "../lib/desktopNotifications";
import { notifications as copy } from "../lib/notificationCopy";
import type { DesktopNotificationsState } from "../state/useDesktopNotifications";
import "./NotificationInboxCard.css";

/**
 * The durable notification inbox, delivered into the below-bar slot (opened
 * from the kebab "Notifications" row or the tray). Toasts stay informational;
 * the inbox owns the real actions (View insights / Retry upload). Every
 * interactive element is a real <button> per the drag-region rule.
 */
export function NotificationInboxCard({
  notifications,
  onClose,
  onAction,
}: {
  notifications: DesktopNotificationsState;
  onClose: () => void;
  onAction: (notification: StoredNotification) => void;
}) {
  const {
    inbox,
    unreadCount,
    markAllSeen,
    dismiss,
    permissionPromptVisible,
    enablePermission,
    dismissPermissionPrompt,
  } = notifications;

  return (
    <GlassSurface className="notification-inbox-card" draggable={false}>
      <div className="notification-inbox-card-inner">
        <div className="notification-inbox-card-header">
          <span className="notification-inbox-card-title">{copy.inboxTitle}</span>
          {unreadCount > 0 && (
            <button
              type="button"
              className="notification-inbox-card-mark-all"
              onClick={markAllSeen}
            >
              {copy.markAllRead}
            </button>
          )}
          <BarIconButton title={copy.closeTooltip} onClick={onClose}>
            <CloseIcon />
          </BarIconButton>
        </div>

        {permissionPromptVisible && (
          <div className="notification-permission-explainer">
            <p>{copy.permissionExplainer}</p>
            <div className="notification-permission-actions">
              <button type="button" onClick={enablePermission}>
                {copy.permissionEnable}
              </button>
              <button type="button" onClick={dismissPermissionPrompt}>
                {copy.permissionDismiss}
              </button>
            </div>
          </div>
        )}

        {inbox.length === 0 ? (
          <div className="notification-inbox-card-empty">
            <BellIcon />
            <span>{copy.empty}</span>
          </div>
        ) : (
          <ul className="notification-inbox-card-list">
            {inbox.map((notification) => (
              <NotificationRow
                key={notification.notificationId}
                notification={notification}
                onAction={onAction}
                onDismiss={dismiss}
              />
            ))}
          </ul>
        )}
      </div>
    </GlassSurface>
  );
}

function actionLabel(action: StoredNotification["action"]): string | null {
  switch (action) {
    case "view_meeting":
      return copy.viewMeeting;
    case "retry_meeting_upload":
      return copy.retryUpload;
    default:
      return null; // open_notifications / null: the inbox itself, no inline action
  }
}

function NotificationRow({
  notification,
  onAction,
  onDismiss,
}: {
  notification: StoredNotification;
  onAction: (notification: StoredNotification) => void;
  onDismiss: (id: string) => void;
}) {
  const label = actionLabel(notification.action);
  return (
    <li
      className={`notification-inbox-row notification-inbox-row-${notification.severity}${
        notification.seen ? "" : " notification-inbox-row-unread"
      }`}
    >
      <span className="notification-inbox-row-dot" aria-hidden="true" />
      <div className="notification-inbox-row-body">
        <div className="notification-inbox-row-line">
          <span className="notification-inbox-row-title">{notification.title}</span>
          <span className="notification-inbox-row-time">
            {copy.relativeTime(notification.receivedAt)}
          </span>
        </div>
        {notification.body && (
          <p className="notification-inbox-row-text">{notification.body}</p>
        )}
        {label && (
          <button
            type="button"
            className="notification-inbox-row-action"
            onClick={() => onAction(notification)}
          >
            {label}
          </button>
        )}
      </div>
      <BarIconButton title={copy.dismissTooltip} onClick={() => onDismiss(notification.notificationId)}>
        <TrashIcon />
      </BarIconButton>
    </li>
  );
}
