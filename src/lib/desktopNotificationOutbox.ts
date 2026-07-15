import { load, type Store } from "@tauri-apps/plugin-store";

import { authFetch, AuthRequiredError } from "./api";
import type { NotificationAction } from "./desktopNotificationContract";
import { logError } from "./log";

const STORE_FILE = "desktop-notification-outbox.json";
const OWNER_KEY = "owner_uid";
const CURSOR_KEY = "cursor";
const PAGE_SIZE = 50;

let storeRef: Store | null = null;

async function getStore(): Promise<Store> {
  return storeRef ?? (storeRef = await load(STORE_FILE));
}

export async function bindOutboxOwner(uid: string): Promise<string> {
  const store = await getStore();
  const owner = await store.get<string>(OWNER_KEY);
  if (owner !== uid) {
    await store.set(OWNER_KEY, uid);
    await store.set(CURSOR_KEY, "");
    await store.save();
    return "";
  }
  return (await store.get<string>(CURSOR_KEY)) ?? "";
}

export async function saveOutboxCursor(uid: string, cursor: string): Promise<void> {
  const store = await getStore();
  if ((await store.get<string>(OWNER_KEY)) !== uid) return;
  await store.set(CURSOR_KEY, cursor);
  await store.save();
}

export async function resetOutboxCursor(uid: string): Promise<void> {
  await saveOutboxCursor(uid, "");
}

export interface DesktopOutboxPage {
  items: unknown[];
  nextCursor: string | null;
}

export async function fetchDesktopOutboxPage(cursor: string): Promise<DesktopOutboxPage> {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor) params.set("cursor", cursor);
  const response = await authFetch(`/desktop/notifications?${params.toString()}`);
  if (!response.ok) {
    const error = new Error(`Desktop notification poll failed (${response.status})`);
    if (response.status === 400) error.name = "InvalidDesktopOutboxCursorError";
    throw error;
  }
  const body = (await response.json()) as {
    items?: unknown;
    next_cursor?: unknown;
  };
  return {
    items: Array.isArray(body.items) ? body.items : [],
    nextCursor: typeof body.next_cursor === "string" ? body.next_cursor : null,
  };
}

export type DesktopAcknowledgementStatus = "received" | "seen" | "acted";

export async function acknowledgeDesktopNotification(
  notificationId: string,
  status: DesktopAcknowledgementStatus,
  action?: NotificationAction | null,
): Promise<void> {
  if (notificationId.startsWith("local:")) return;
  try {
    const response = await authFetch(
      `/desktop/notifications/${encodeURIComponent(notificationId)}/ack`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, action: action ?? undefined }),
      },
    );
    if (!response.ok && response.status !== 404) {
      throw new Error(`Desktop notification acknowledgement failed (${response.status})`);
    }
  } catch (err) {
    if (!(err instanceof AuthRequiredError)) {
      logError("acknowledgeDesktopNotification", err);
    }
  }
}
