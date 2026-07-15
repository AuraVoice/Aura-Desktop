import { beforeEach, describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => new Map<string, unknown>());
const store = vi.hoisted(() => ({
  get: vi.fn(async (key: string) => values.get(key)),
  set: vi.fn(async (key: string, value: unknown) => values.set(key, value)),
  save: vi.fn(async () => undefined),
}));
const authFetch = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-store", () => ({ load: vi.fn(async () => store) }));
vi.mock("./api", () => ({
  authFetch,
  AuthRequiredError: class AuthRequiredError extends Error {},
}));
vi.mock("./log", () => ({ logError: vi.fn() }));

import {
  acknowledgeDesktopNotification,
  bindOutboxOwner,
  fetchDesktopOutboxPage,
  saveOutboxCursor,
} from "./desktopNotificationOutbox";

describe("desktop outbox client", () => {
  beforeEach(() => {
    values.clear();
    vi.clearAllMocks();
  });

  it("persists a cursor only for the bound owner and clears on account switch", async () => {
    expect(await bindOutboxOwner("user-1")).toBe("");
    await saveOutboxCursor("user-1", "cursor-1");
    expect(await bindOutboxOwner("user-1")).toBe("cursor-1");
    expect(await bindOutboxOwner("user-2")).toBe("");
  });

  it("parses a bounded backend page", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({
      items: [{ notification_id: "n1" }],
      next_cursor: "cursor-1",
    }), { status: 200 }));

    await expect(fetchDesktopOutboxPage("")).resolves.toEqual({
      items: [{ notification_id: "n1" }],
      nextCursor: "cursor-1",
    });
  });

  it("does not acknowledge local notifications and allowlists remote action data", async () => {
    await acknowledgeDesktopNotification("local:m1", "seen");
    expect(authFetch).not.toHaveBeenCalled();

    authFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    await acknowledgeDesktopNotification("remote-1", "acted", "view_meeting");
    const [, init] = authFetch.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ status: "acted", action: "view_meeting" });
  });
});
