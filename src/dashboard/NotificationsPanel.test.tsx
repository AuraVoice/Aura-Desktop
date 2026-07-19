import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { expect, it, vi } from "vitest";

import type { StoredNotification } from "../lib/desktopNotifications";
import { notifications as copy } from "../lib/notificationCopy";
import { NotificationsPanel } from "./NotificationsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeRow(overrides: Partial<StoredNotification> = {}): StoredNotification {
  return {
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
    ...overrides,
  };
}

it("renders an unread card with dot, severity accent, title, body, and timestamp", () => {
  const row = makeRow();
  const html = renderToStaticMarkup(
    <NotificationsPanel
      rows={[row]}
      onSelect={vi.fn()}
      onDismiss={vi.fn()}
      onMarkAllRead={vi.fn()}
      hasUnread
    />,
  );

  expect(html).toContain("db-notif-row-unread");
  expect(html).toContain("db-notif-sev-success");
  expect(html).toContain("db-notif-dot");
  expect(html).toContain(row.title);
  expect(html).toContain(row.body);
  expect(html).toContain(copy.stampTime(row.receivedAt));
  expect(html).toContain(copy.markAllRead);
});

it("renders a read card without the unread affordances and hides mark-all when nothing is unread", () => {
  const html = renderToStaticMarkup(
    <NotificationsPanel
      rows={[makeRow({ seen: true, severity: "error" })]}
      onSelect={vi.fn()}
      onDismiss={vi.fn()}
      onMarkAllRead={vi.fn()}
      hasUnread={false}
    />,
  );

  expect(html).not.toContain("db-notif-row-unread");
  expect(html).not.toContain("db-notif-dot");
  expect(html).toContain("db-notif-sev-error");
  expect(html).not.toContain(copy.markAllRead);
});

it("renders the empty state when there are no rows", () => {
  const html = renderToStaticMarkup(
    <NotificationsPanel
      rows={[]}
      onSelect={vi.fn()}
      onDismiss={vi.fn()}
      onMarkAllRead={vi.fn()}
      hasUnread={false}
    />,
  );

  // renderToStaticMarkup escapes the apostrophe in copy.empty, so match on
  // the un-escaped tail of the phrase.
  expect(html).toContain("caught up.");
  expect(html).not.toContain("db-notif-row");
});

it("wires row selection, dismissal, and mark-all to their exact callbacks", () => {
  const row = makeRow();
  const onSelect = vi.fn();
  const onDismiss = vi.fn();
  const onMarkAllRead = vi.fn();
  let renderer: ReturnType<typeof create>;

  act(() => {
    renderer = create(
      <NotificationsPanel
        rows={[row]}
        onSelect={onSelect}
        onDismiss={onDismiss}
        onMarkAllRead={onMarkAllRead}
        hasUnread
      />,
    );
  });
  const buttons = renderer!.root.findAllByType("button");
  act(() => buttons[0].props.onClick());
  act(() => buttons[1].props.onClick());
  act(() => buttons[2].props.onClick());

  expect(onMarkAllRead).toHaveBeenCalledOnce();
  expect(onSelect).toHaveBeenCalledWith(row);
  expect(onDismiss).toHaveBeenCalledWith(row.notificationId);
  act(() => renderer!.unmount());
});
