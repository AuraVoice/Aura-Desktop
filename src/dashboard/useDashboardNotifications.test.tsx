import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StoredNotification } from "../lib/desktopNotifications";
import {
  type DashboardNotificationsState,
  useDashboardNotifications,
} from "./useDashboardNotifications";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const broker = vi.hoisted(() => ({
  currentOwner: vi.fn(async () => "user-a" as string | null),
  loadInbox: vi.fn<() => Promise<StoredNotification[]>>(),
  subscribeInbox: vi.fn(async () => () => undefined),
}));

vi.mock("../lib/desktopNotifications", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/desktopNotifications")>();
  return {
    ...actual,
    currentOwner: broker.currentOwner,
    loadInbox: broker.loadInbox,
    subscribeInbox: broker.subscribeInbox,
    markSeen: vi.fn(async () => undefined),
    markAllSeen: vi.fn(async () => undefined),
    dismiss: vi.fn(async () => undefined),
  };
});
vi.mock("../lib/desktopNotificationOutbox", () => ({
  acknowledgeDesktopNotification: vi.fn(async () => undefined),
}));
vi.mock("../lib/log", () => ({ logError: vi.fn() }));

let renderer: ReactTestRenderer | null = null;

function Probe({
  uid,
  onState,
}: {
  uid: string | null;
  onState: (state: DashboardNotificationsState) => void;
}) {
  onState(useDashboardNotifications(uid));
  return null;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

describe("useDashboardNotifications", () => {
  it("does not publish an in-flight inbox refresh after sign-out", async () => {
    let resolveLoad: (rows: StoredNotification[]) => void = () => undefined;
    broker.loadInbox.mockImplementationOnce(
      () => new Promise((resolve) => { resolveLoad = resolve; }),
    );
    let state: DashboardNotificationsState | null = null;

    await act(async () => {
      renderer = create(
        createElement(Probe, { uid: "user-a", onState: (next) => { state = next; } }),
      );
    });
    await flush();

    await act(async () => {
      renderer?.update(
        createElement(Probe, { uid: null, onState: (next) => { state = next; } }),
      );
    });
    await act(async () => {
      resolveLoad([{ notificationId: "private-row" } as StoredNotification]);
    });
    await flush();

    expect(state!.inbox).toEqual([]);
  });
});
