import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  permissionGranted: false,
  sent: [] as Array<{ title: string; body?: string }>,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => fake.values.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      fake.values.set(key, structuredClone(value));
    },
    save: async () => undefined,
  })),
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: vi.fn(async () => fake.permissionGranted),
  requestPermission: vi.fn(async () => (fake.permissionGranted ? "granted" : "denied")),
  sendNotification: vi.fn((options: { title: string; body?: string }) => {
    fake.sent.push(options);
  }),
}));

vi.mock("./analytics", () => ({ trackEvent: vi.fn() }));
vi.mock("./log", () => ({ logError: vi.fn() }));

import { bindOwner, ingest, loadInbox } from "./desktopNotifications";

function notification(id: string) {
  return {
    notification_id: id,
    schema_version: 1,
    type: "meeting_ready",
    severity: "success",
    title: "Meeting ready",
    body: "Open Aura to view.",
    created_at: "2026-07-14T20:00:00.000Z",
    expires_at: "2099-07-15T20:00:00.000Z",
    dedup_key: `meeting:${id}:ready:1`,
    action: "view_meeting",
    resource_id: id,
    toast_policy: "when_hidden",
    sensitive: true,
  };
}

beforeEach(() => {
  fake.values.clear();
  fake.sent.length = 0;
  fake.permissionGranted = false;
});

describe("desktop notification broker", () => {
  it("serializes concurrent ingestion without losing rows", async () => {
    await bindOwner("user-1");

    await Promise.all([
      ingest(notification("meeting-1"), { appHidden: true, ownerUid: "user-1" }),
      ingest(notification("meeting-2"), { appHidden: true, ownerUid: "user-1" }),
    ]);

    expect(await loadInbox()).toHaveLength(2);
  });

  it("persists the inbox when toast permission is denied", async () => {
    await bindOwner("user-1");

    const result = await ingest(
      notification("meeting-1"),
      { appHidden: true, ownerUid: "user-1" },
    );

    expect(result.isNew).toBe(true);
    expect(await loadInbox()).toHaveLength(1);
    expect(fake.sent).toHaveLength(0);
  });

  it("rejects ingestion for an account that is not bound", async () => {
    await bindOwner("user-1");

    const result = await ingest(
      notification("meeting-1"),
      { appHidden: true, ownerUid: "user-2" },
    );

    expect(result.notification).toBeNull();
    expect(await loadInbox()).toHaveLength(0);
  });

  it("clears account-scoped state on an owner switch", async () => {
    await bindOwner("user-1");
    await ingest(notification("meeting-1"), { appHidden: true, ownerUid: "user-1" });

    await bindOwner("user-2");

    expect(await loadInbox()).toHaveLength(0);
  });

  it("attempts a permitted toast at most once", async () => {
    fake.permissionGranted = true;
    await bindOwner("user-1");

    await ingest(notification("meeting-1"), { appHidden: true, ownerUid: "user-1" });
    await ingest(notification("meeting-1"), { appHidden: true, ownerUid: "user-1" });

    expect(fake.sent).toHaveLength(1);
  });

  it("bounds the dedup and delivered maps to the retention window", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-15T00:00:00.000Z"));
      fake.permissionGranted = true;
      await bindOwner("user-1");

      await ingest(notification("meeting-old"), { appHidden: true, ownerUid: "user-1" });
      expect(fake.values.get("dedup")).toHaveProperty("meeting:meeting-old:ready:1");
      expect(fake.values.get("delivered_toasts")).toHaveProperty("meeting-old");

      // Past the 30-day inbox retention window: the next ingest prunes the old
      // row out of the inbox and drops its dedup + delivered entries with it.
      vi.setSystemTime(new Date("2026-08-15T00:00:00.000Z"));
      await ingest(notification("meeting-new"), { appHidden: true, ownerUid: "user-1" });

      expect(await loadInbox()).toHaveLength(1);
      expect(fake.values.get("dedup")).not.toHaveProperty("meeting:meeting-old:ready:1");
      expect(fake.values.get("delivered_toasts")).not.toHaveProperty("meeting-old");
      expect(fake.values.get("delivered_toasts")).toHaveProperty("meeting-new");
    } finally {
      vi.useRealTimers();
    }
  });
});
