import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

import type { StoredNotification } from "../lib/desktopNotifications";
import type { DesktopNotificationsState } from "../state/useDesktopNotifications";
import { NotificationInboxCard } from "./NotificationInboxCard";

const row: StoredNotification = {
  notificationId: "n1",
  schemaVersion: 1,
  type: "meeting_ready",
  severity: "success",
  title: "Your meeting insights are ready",
  body: "Open Aura to view them.",
  createdAt: "2026-07-14T20:00:00Z",
  expiresAt: null,
  dedupKey: "meeting:m1:ready:1",
  action: "view_meeting",
  resourceId: "m1",
  toastPolicy: "when_hidden",
  sensitive: true,
  receivedAt: Date.now(),
  seen: false,
};

it("renders unread state, permission explainer, and the allowlisted action", () => {
  const notifications: DesktopNotificationsState = {
    inbox: [row],
    unreadCount: 1,
    refresh: vi.fn(),
    markSeen: vi.fn(),
    markAllSeen: vi.fn(),
    dismiss: vi.fn(),
    acknowledgeAction: vi.fn(),
    permissionPromptVisible: true,
    enablePermission: vi.fn(),
    notificationsEnabled: true,
    setNotificationsEnabled: vi.fn(),
    dismissPermissionPrompt: vi.fn(),
    reset: vi.fn(),
  };

  const html = renderToStaticMarkup(
    <NotificationInboxCard notifications={notifications} onClose={vi.fn()} onAction={vi.fn()} />,
  );

  expect(html).toContain("Mark all read");
  expect(html).toContain("Turn on alerts");
  expect(html).toContain("View insights");
  expect(html).toContain("notification-inbox-row-unread");
});
