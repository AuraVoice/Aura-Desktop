import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  permissionGranted: false,
  sent: [] as Array<{ title: string; body?: string }>,
  invoked: [] as Array<{ command: string; args: Record<string, unknown> }>,
  invokeShouldFail: false,
  keyListeners: new Map<string, Array<(value: unknown) => void>>(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: async <T>(key: string) => fake.values.get(key) as T | undefined,
    set: async (key: string, value: unknown) => {
      fake.values.set(key, structuredClone(value));
    },
    save: async () => undefined,
    onKeyChange: async (key: string, cb: (value: unknown) => void) => {
      const listeners = fake.keyListeners.get(key) ?? [];
      listeners.push(cb);
      fake.keyListeners.set(key, listeners);
      return () => {
        const current = fake.keyListeners.get(key) ?? [];
        fake.keyListeners.set(key, current.filter((fn) => fn !== cb));
      };
    },
  })),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown>) => {
    if (fake.invokeShouldFail) throw new Error("native toast unavailable");
    fake.invoked.push({ command, args });
  }),
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

import {
  bindOwner,
  currentOwner,
  ingest,
  loadInbox,
  subscribeInbox,
} from "./desktopNotifications";

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
  fake.invoked.length = 0;
  fake.invokeShouldFail = false;
  fake.keyListeners.clear();
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

  it("attempts a permitted toast at most once, through the actionable native path", async () => {
    fake.permissionGranted = true;
    await bindOwner("user-1");

    await ingest(notification("meeting-1"), { appHidden: true, ownerUid: "user-1" });
    await ingest(notification("meeting-1"), { appHidden: true, ownerUid: "user-1" });

    expect(fake.invoked).toHaveLength(1);
    expect(fake.invoked[0].command).toBe("show_actionable_toast");
    expect(fake.invoked[0].args).toMatchObject({
      notificationId: "meeting-1",
      action: "view_meeting",
    });
    // The privacy rule holds: the toast body is exactly the generic
    // TYPE-derived copy, never the row's real title/body.
    expect(fake.invoked[0].args.body).toBe(
      "Your meeting insights are ready. Open Aura to view.",
    );
    expect(fake.invoked[0].args.body).not.toContain("Meeting ready");
    expect(fake.sent).toHaveLength(0);
  });

  it("falls back to the plugin toast when the native command fails", async () => {
    fake.permissionGranted = true;
    fake.invokeShouldFail = true;
    await bindOwner("user-1");

    await ingest(notification("meeting-1"), { appHidden: true, ownerUid: "user-1" });

    expect(fake.sent).toHaveLength(1);
  });

  it("exposes the bound owner read-only", async () => {
    expect(await currentOwner()).toBeNull();
    await bindOwner("user-1");
    expect(await currentOwner()).toBe("user-1");
  });

  it("delivers cross-window inbox changes to subscribers, sorted and unlistenable", async () => {
    const seen: Array<Array<{ notificationId: string }>> = [];
    const unlisten = await subscribeInbox((rows) => {
      seen.push(rows.map((row) => ({ notificationId: row.notificationId })));
    });

    const older = {
      notificationId: "old",
      schemaVersion: 1,
      type: "meeting_ready",
      severity: "success",
      title: "t",
      body: "b",
      createdAt: "2026-07-14T20:00:00.000Z",
      expiresAt: null,
      dedupKey: "d-old",
      action: null,
      resourceId: null,
      toastPolicy: "inbox_only",
      sensitive: false,
      receivedAt: Date.now() - 1000,
      seen: false,
    };
    const newer = { ...older, notificationId: "new", dedupKey: "d-new", receivedAt: Date.now() };

    const listeners = fake.keyListeners.get("inbox") ?? [];
    expect(listeners).toHaveLength(1);
    listeners[0]({ old: older, new: newer });

    expect(seen).toHaveLength(1);
    expect(seen[0].map((row) => row.notificationId)).toEqual(["new", "old"]);

    unlisten();
    expect(fake.keyListeners.get("inbox")).toHaveLength(0);
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
