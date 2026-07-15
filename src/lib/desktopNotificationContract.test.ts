import { describe, expect, it } from "vitest";

import {
  BODY_MAX,
  isExpired,
  parseNotification,
  SCHEMA_VERSION,
  TITLE_MAX,
} from "./desktopNotificationContract";

function validNotification(overrides: Record<string, unknown> = {}) {
  return {
    notification_id: "notification-1",
    schema_version: SCHEMA_VERSION,
    type: "meeting_ready",
    severity: "success",
    title: "Meeting ready",
    body: "Open Aura to view.",
    created_at: "2026-07-14T20:00:00.000Z",
    expires_at: "2026-07-15T20:00:00.000Z",
    dedup_key: "meeting:1:ready:1",
    action: "view_meeting",
    resource_id: "meeting-1",
    toast_policy: "when_hidden",
    sensitive: true,
    ...overrides,
  };
}

describe("parseNotification", () => {
  it("parses the backend contract", () => {
    expect(parseNotification(validNotification())).toMatchObject({
      notificationId: "notification-1",
      type: "meeting_ready",
      action: "view_meeting",
      resourceId: "meeting-1",
    });
  });

  it.each([0, -1, 1.5, SCHEMA_VERSION + 1])(
    "rejects unsupported schema version %s",
    (schemaVersion) => {
      expect(parseNotification(validNotification({ schema_version: schemaVersion }))).toBeNull();
    },
  );

  it("rejects unknown types and malformed dates", () => {
    expect(parseNotification(validNotification({ type: "run_native_command" }))).toBeNull();
    expect(parseNotification(validNotification({ created_at: "yesterday" }))).toBeNull();
    expect(parseNotification(validNotification({ expires_at: "later" }))).toBeNull();
  });

  it("drops untrusted actions and defaults an unknown toast policy safely", () => {
    expect(parseNotification(validNotification({
      action: "shell_exec",
      toast_policy: "force",
    }))).toMatchObject({
      action: null,
      toastPolicy: "inbox_only",
    });
  });

  it("bounds user-visible copy", () => {
    const parsed = parseNotification(validNotification({
      title: "t".repeat(TITLE_MAX + 20),
      body: "b".repeat(BODY_MAX + 20),
    }));

    expect(parsed?.title).toHaveLength(TITLE_MAX);
    expect(parsed?.body).toHaveLength(BODY_MAX);
  });
});

describe("isExpired", () => {
  it("expires at the boundary", () => {
    const parsed = parseNotification(validNotification());
    expect(parsed).not.toBeNull();
    expect(isExpired(parsed!, Date.parse("2026-07-15T20:00:00.000Z"))).toBe(true);
  });
});
