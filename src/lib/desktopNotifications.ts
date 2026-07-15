// The desktop notification broker: the ONE API every producer calls, local or
// backend. It owns the durable inbox, dedup, toast policy, permission state,
// and analytics, so no producer re-implements any of that.
//
// Invariants (DESKTOP_NOTIFICATIONS_AND_MEETING_RECOVERY_PLAN.md, Phase 3):
//   - A valid event is ALWAYS persisted to the inbox, even when notification
//     permission is denied or the OS toast fails.
//   - A toast fires at most once per notification, ever - delivered ids are
//     persisted so an app restart cannot replay a toast.
//   - Toast copy is generic and privacy-safe by construction: it is derived
//     from the notification TYPE, never its title/body, so a meeting title or
//     insight can never reach a lock screen.

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { load, type Store } from "@tauri-apps/plugin-store";

import { trackEvent } from "./analytics";
import {
  type DesktopNotification,
  isExpired,
  parseNotification,
  SCHEMA_VERSION,
  type ToastPolicy,
} from "./desktopNotificationContract";
import { logError } from "./log";
import { notifications as copy } from "./notificationCopy";

const STORE_FILE = "desktop-notifications.json";
const INBOX_KEY = "inbox"; // Record<notificationId, StoredNotification>
const DELIVERED_KEY = "delivered_toasts"; // Record<notificationId, ISODate> (restart-safe)
const DEDUP_KEY = "dedup"; // Record<dedupKey, notificationId>
const DISABLED_KEY = "disabled"; // boolean; whole-feature off switch
const PERMISSION_ASKED_KEY = "permission_asked"; // boolean; we asked once, in-app
const OWNER_KEY = "owner_uid"; // whose inbox this store currently holds

// Keep the inbox bounded. Rows older than this are pruned on load, matching the
// bounded-retention posture used elsewhere (meeting notes' seen map).
const INBOX_MAX_AGE_DAYS = 30;
const INBOX_MAX_ROWS = 100;

export interface StoredNotification extends DesktopNotification {
  receivedAt: number; // ms epoch, local
  seen: boolean;
}

export interface ToastContext {
  /** True when Aura is not currently presenting the relevant content (window
   *  hidden / minimized to pill). Drives the `when_hidden` toast policy. */
  appHidden: boolean;
  /** Authenticated owner expected to be bound to the durable store. */
  ownerUid: string;
}

let storeRef: Store | null = null;
let mutationTail: Promise<void> = Promise.resolve();

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationTail.then(operation, operation);
  mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function getStore(): Promise<Store> {
  return storeRef ?? (storeRef = await load(STORE_FILE));
}

async function readInbox(store: Store): Promise<Record<string, StoredNotification>> {
  return (await store.get<Record<string, StoredNotification>>(INBOX_KEY)) ?? {};
}

function prune(inbox: Record<string, StoredNotification>, nowMs: number): Record<string, StoredNotification> {
  const cutoff = nowMs - INBOX_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const kept = Object.values(inbox)
    .filter((n) => n.receivedAt >= cutoff && !isExpired(n, nowMs))
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, INBOX_MAX_ROWS);
  const result: Record<string, StoredNotification> = {};
  for (const n of kept) result[n.notificationId] = n;
  return result;
}

/** Bind the store to a user. On an account switch (owner differs) the inbox,
 *  dedup, and delivered-toast records are cleared, so one account can never see
 *  another's notifications. Call on sign-in before loading the inbox. */
export async function bindOwner(uid: string): Promise<void> {
  if (!uid.trim()) throw new Error("Notification owner uid is required");
  return serializeMutation(async () => {
    const store = await getStore();
    const previous = await store.get<string>(OWNER_KEY);
    if (previous === uid) return;
    await store.set(INBOX_KEY, {});
    await store.set(DEDUP_KEY, {});
    await store.set(DELIVERED_KEY, {});
    await store.set(OWNER_KEY, uid);
    await store.save();
  });
}

/** Non-expired inbox rows, newest first. Fails closed to an empty list. */
export async function loadInbox(): Promise<StoredNotification[]> {
  try {
    const store = await getStore();
    const inbox = prune(await readInbox(store), Date.now());
    return Object.values(inbox).sort((a, b) => b.receivedAt - a.receivedAt);
  } catch (err) {
    logError("desktopNotifications: loadInbox", err);
    return [];
  }
}

export async function isDisabled(): Promise<boolean> {
  try {
    return (await (await getStore()).get<boolean>(DISABLED_KEY)) === true;
  } catch (err) {
    logError("desktopNotifications: isDisabled", err);
    return false;
  }
}

export async function setDisabled(disabled: boolean): Promise<void> {
  try {
    const store = await getStore();
    await store.set(DISABLED_KEY, disabled);
    await store.save();
  } catch (err) {
    logError("desktopNotifications: setDisabled", err);
  }
}

export async function permissionAlreadyAsked(): Promise<boolean> {
  try {
    return (await (await getStore()).get<boolean>(PERMISSION_ASKED_KEY)) === true;
  } catch (err) {
    logError("desktopNotifications: permissionAlreadyAsked", err);
    return false;
  }
}

export async function permissionGranted(): Promise<boolean> {
  try {
    return await isPermissionGranted();
  } catch (err) {
    logError("desktopNotifications: permissionGranted", err);
    return false;
  }
}

/** Request OS permission (call only AFTER the in-app explainer). Records that
 *  we asked so we never nag. Returns whether permission is now granted. */
export async function ensurePermission(): Promise<boolean> {
  try {
    const store = await getStore();
    await store.set(PERMISSION_ASKED_KEY, true);
    await store.save();
    if (await isPermissionGranted()) return true;
    return (await requestPermission()) === "granted";
  } catch (err) {
    logError("desktopNotifications: ensurePermission", err);
    return false;
  }
}

function toastBodyFor(notification: DesktopNotification): string {
  // Always generic, derived from TYPE - the real title/body stay in the inbox.
  switch (notification.type) {
    case "meeting_ready":
      return copy.toastMeetingReady;
    case "meeting_needs_attention":
      return copy.toastMeetingNeedsAttention;
    default:
      return copy.toastGeneric;
  }
}

function shouldToast(
  notification: DesktopNotification,
  ctx: ToastContext,
  alreadyDelivered: boolean,
): boolean {
  if (alreadyDelivered) return false;
  const policy: ToastPolicy = notification.toastPolicy;
  if (policy === "inbox_only") return false;
  if (policy === "when_hidden" && !ctx.appHidden) return false;
  return true; // "always", or "when_hidden" while hidden
}

async function maybeToast(
  store: Store,
  notification: DesktopNotification,
  ctx: ToastContext,
): Promise<void> {
  const delivered = (await store.get<Record<string, string>>(DELIVERED_KEY)) ?? {};
  if (!shouldToast(notification, ctx, delivered[notification.notificationId] !== undefined)) {
    return;
  }
  try {
    if (!(await isPermissionGranted())) {
      // Persisted already; the inbox carries it. We just cannot toast.
      trackEvent("desktop_notification_toast_denied", { type: notification.type });
      return;
    }
    // Claim the one allowed attempt before invoking the fire-and-forget native
    // API. If the process dies immediately afterward, the durable inbox remains
    // the fallback and restart cannot duplicate the lock-screen effect.
    delivered[notification.notificationId] = new Date().toISOString();
    await store.set(DELIVERED_KEY, delivered);
    await store.save();
    sendNotification({ title: "Aura", body: toastBodyFor(notification) });
    trackEvent("desktop_notification_toast_shown", {
      type: notification.type,
      policy: notification.toastPolicy,
    });
  } catch (err) {
    // A failed toast must never lose the inbox row (already persisted).
    logError("desktopNotifications: toast", err);
  }
}

/**
 * Validate + persist + dedup one raw event, then toast per policy. The single
 * entry point for every producer. Returns the stored row (or null if the event
 * was rejected/expired) and whether it was new (vs a dedup hit).
 */
export async function ingest(
  raw: unknown,
  ctx: ToastContext,
): Promise<{ notification: StoredNotification | null; isNew: boolean }> {
  const parsed = parseNotification(raw);
  if (!parsed) return { notification: null, isNew: false };

  const nowMs = Date.now();
  if (isExpired(parsed, nowMs)) return { notification: null, isNew: false };

  return serializeMutation(async () => {
    try {
    const store = await getStore();
    const owner = await store.get<string>(OWNER_KEY);
    if (owner !== ctx.ownerUid) {
      logError("desktopNotifications: ingest owner mismatch", new Error("Owner is not bound"));
      return { notification: null, isNew: false };
    }
    if ((await store.get<boolean>(DISABLED_KEY)) === true) {
      return { notification: null, isNew: false };
    }

    const inbox = await readInbox(store);
    const dedup = (await store.get<Record<string, string>>(DEDUP_KEY)) ?? {};

    // Dedup by stable event identity: a re-emitted "meeting X ready rev N" maps
    // to the same row instead of stacking. A different revision is a new row.
    const existingId = dedup[parsed.dedupKey] ?? (inbox[parsed.notificationId] ? parsed.notificationId : undefined);
    if (existingId && inbox[existingId]) {
      return { notification: inbox[existingId], isNew: false };
    }

    const stored: StoredNotification = { ...parsed, receivedAt: nowMs, seen: false };
    inbox[stored.notificationId] = stored;
    dedup[stored.dedupKey] = stored.notificationId;

    const pruned = prune(inbox, nowMs);
    // Bound the sidecar maps too. The inbox prune caps rows at 30 days / 100
    // entries; without this, dedup and delivered_toasts would grow forever (one
    // entry per dedupKey / toast ever seen). Dedup is scoped to surviving rows -
    // a dedupKey whose row is already gone behaves as "new" on re-ingest today,
    // so dropping it changes nothing. Delivered is kept by age, not row
    // identity, so the toast-once guarantee still holds for anything in the
    // retention window even after its inbox row is dismissed.
    const survivingIds = new Set(Object.keys(pruned));
    const prunedDedup: Record<string, string> = {};
    for (const [key, id] of Object.entries(dedup)) {
      if (survivingIds.has(id)) prunedDedup[key] = id;
    }
    const deliveredCutoffMs = nowMs - INBOX_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const delivered = (await store.get<Record<string, string>>(DELIVERED_KEY)) ?? {};
    const prunedDelivered: Record<string, string> = {};
    for (const [id, at] of Object.entries(delivered)) {
      const deliveredAtMs = Date.parse(at);
      if (Number.isFinite(deliveredAtMs) && deliveredAtMs >= deliveredCutoffMs) {
        prunedDelivered[id] = at;
      }
    }
    await store.set(INBOX_KEY, pruned);
    await store.set(DEDUP_KEY, prunedDedup);
    await store.set(DELIVERED_KEY, prunedDelivered);
    await store.save();

    trackEvent("desktop_notification_queued", {
      type: stored.type,
      severity: stored.severity,
    });

    await maybeToast(store, stored, ctx);
    return { notification: stored, isNew: true };
  } catch (err) {
    logError("desktopNotifications: ingest", err);
    return { notification: null, isNew: false };
    }
  });
}

/** Build a contract notification from a LOCAL event and ingest it. Local
 *  producers (upload pending, update ready) call this instead of hand-rolling
 *  the shape - the broker fills id, schema version, and timestamp. */
export async function notifyLocal(
  input: {
    type: DesktopNotification["type"];
    severity?: DesktopNotification["severity"];
    title: string;
    body: string;
    dedupKey: string;
    action?: DesktopNotification["action"];
    resourceId?: string | null;
    toastPolicy?: ToastPolicy;
    sensitive?: boolean;
    expiresAt?: string | null;
  },
  ctx: ToastContext,
): Promise<{ notification: StoredNotification | null; isNew: boolean }> {
  return ingest(
    {
      notification_id: `local:${input.dedupKey}`,
      schema_version: SCHEMA_VERSION,
      type: input.type,
      severity: input.severity ?? "info",
      title: input.title,
      body: input.body,
      created_at: new Date().toISOString(),
      expires_at: input.expiresAt ?? null,
      dedup_key: input.dedupKey,
      action: input.action ?? null,
      resource_id: input.resourceId ?? null,
      toast_policy: input.toastPolicy ?? "when_hidden",
      sensitive: input.sensitive ?? false,
    },
    ctx,
  );
}

async function mutateRow(id: string, mutate: (n: StoredNotification) => StoredNotification | null): Promise<void> {
  return serializeMutation(async () => {
    try {
    const store = await getStore();
    const inbox = await readInbox(store);
    const row = inbox[id];
    if (!row) return;
    const next = mutate(row);
    if (next === null) {
      delete inbox[id];
    } else {
      inbox[id] = next;
    }
    await store.set(INBOX_KEY, inbox);
    await store.save();
  } catch (err) {
    logError("desktopNotifications: mutateRow", err);
    }
  });
}

export async function markSeen(id: string): Promise<void> {
  await mutateRow(id, (n) => ({ ...n, seen: true }));
}

export async function markAllSeen(): Promise<void> {
  return serializeMutation(async () => {
    try {
    const store = await getStore();
    const inbox = await readInbox(store);
    let changed = false;
    for (const id of Object.keys(inbox)) {
      if (!inbox[id].seen) {
        inbox[id] = { ...inbox[id], seen: true };
        changed = true;
      }
    }
    if (changed) {
      await store.set(INBOX_KEY, inbox);
      await store.save();
    }
  } catch (err) {
    logError("desktopNotifications: markAllSeen", err);
    }
  });
}

export async function dismiss(id: string): Promise<void> {
  await mutateRow(id, () => null);
  trackEvent("desktop_notification_dismissed", {});
}

export function unreadCount(inbox: StoredNotification[]): number {
  return inbox.reduce((count, n) => (n.seen ? count : count + 1), 0);
}
