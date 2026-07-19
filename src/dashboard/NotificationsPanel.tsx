import { BellOff, X } from "lucide-react";
import type { StoredNotification } from "../lib/desktopNotifications";
import { notifications as copy } from "../lib/notificationCopy";

/**
 * The dashboard's pop-down notification center, anchored to the TopBar's
 * right edge. Purely presentational: rows and callbacks come in as props, so
 * it can be unit-tested without any store or plugin mocks. Opening the panel does NOT
 * mark anything read; selecting a card marks only that card, and "Mark all
 * read" is the explicit bulk action.
 */
export interface NotificationsPanelProps {
  rows: StoredNotification[];
  onSelect: (row: StoredNotification) => void;
  onDismiss: (id: string) => void;
  onMarkAllRead: () => void;
  hasUnread: boolean;
}

export function NotificationsPanel({
  rows,
  onSelect,
  onDismiss,
  onMarkAllRead,
  hasUnread,
}: NotificationsPanelProps) {
  return (
    <div className="db-notif-panel" role="region" aria-label={copy.inboxTitle}>
      <div className="db-notif-head">
        <span className="db-notif-title">{copy.inboxTitle}</span>
        {hasUnread && (
          <button type="button" className="db-notif-mark-all" onClick={onMarkAllRead}>
            {copy.markAllRead}
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="db-notif-empty">
          <BellOff size={22} aria-hidden />
          <span>{copy.empty}</span>
        </div>
      ) : (
        <div className="db-notif-list" role="list">
          {rows.map((row) => (
            <NotificationCard key={row.notificationId} row={row} onSelect={onSelect} onDismiss={onDismiss} />
          ))}
        </div>
      )}
    </div>
  );
}

/** One stacked card. The row itself is a div: the full-area select target and
 *  the dismiss control are SIBLING buttons, never nested (invalid HTML). */
function NotificationCard({
  row,
  onSelect,
  onDismiss,
}: {
  row: StoredNotification;
  onSelect: (row: StoredNotification) => void;
  onDismiss: (id: string) => void;
}) {
  return (
    <div
      className={`db-notif-row db-notif-sev-${row.severity}${row.seen ? "" : " db-notif-row-unread"}`}
      role="listitem"
    >
      <span className="db-notif-accent" aria-hidden />
      <button
        type="button"
        className="db-notif-row-main"
        onClick={() => onSelect(row)}
        aria-label={row.seen ? row.title : `Unread: ${row.title}`}
      >
        <span className="db-notif-row-line">
          {!row.seen && <span className="db-notif-dot" aria-hidden />}
          <span className="db-notif-row-title">{row.title}</span>
        </span>
        {row.body && <span className="db-notif-row-body">{row.body}</span>}
        <span className="db-notif-row-time">{copy.stampTime(row.receivedAt)}</span>
      </button>
      <button
        type="button"
        className="db-notif-dismiss"
        title={copy.dismissTooltip}
        aria-label={copy.dismissTooltip}
        onClick={() => onDismiss(row.notificationId)}
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
