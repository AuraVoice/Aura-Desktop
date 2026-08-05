// The versioned desktop-notification contract, shared by backend-delivered
// events (polled from the outbox) and local events (upload pending, update
// ready). Parsing is the trust boundary: a backend or local producer never
// hands the broker a shape it did not validate here.
//
// Security rule (see DESKTOP_NOTIFICATIONS_AND_MEETING_RECOVERY_PLAN.md): we
// never accept an arbitrary URL or native command name. `action` is an
// allowlisted enum the desktop maps to code it owns; anything else becomes
// null (open the inbox, do nothing else).

export const SCHEMA_VERSION = 1;

// Length bounds. Titles/bodies past these are truncated, not rejected - a long
// but otherwise valid event should still reach the inbox.
export const TITLE_MAX = 120;
export const BODY_MAX = 300;
export const ID_MAX = 160;
export const DEDUP_KEY_MAX = 200;

// NOTE: nothing emits `suggestion`, `announcement`, or `milestone` yet - no
// local producer and no backend outbox event uses them. They exist so the
// Settings > System > Notifications toggles have something concrete to gate,
// and so a backend can start sending them without a client release. Widening
// this list is backward compatible at schemaVersion 1: unknown types were
// already dropped by parseNotification, so accepting three more only lets
// through events that previously fell on the floor.
export const NOTIFICATION_TYPES = [
  "meeting_ready",
  "meeting_needs_attention",
  "meeting_upload_pending",
  "update_ready",
  "auth_required",
  "generic",
  "suggestion",
  "announcement",
  "milestone",
] as const;
export type DesktopNotificationType = (typeof NOTIFICATION_TYPES)[number];

export const SEVERITIES = ["info", "success", "warning", "error"] as const;
export type NotificationSeverity = (typeof SEVERITIES)[number];

// always: toast whenever delivered. when_hidden: only while Aura is not already
// showing the content. inbox_only: never toast. Unknown -> inbox_only (safest).
export const TOAST_POLICIES = ["always", "when_hidden", "inbox_only"] as const;
export type ToastPolicy = (typeof TOAST_POLICIES)[number];

// The ONLY actions the desktop will honor. Each maps to owned code in the
// inbox; the backend cannot introduce a new one without a client release.
export const ACTIONS = ["open_notifications", "view_meeting", "retry_meeting_upload"] as const;
export type NotificationAction = (typeof ACTIONS)[number];

export interface DesktopNotification {
  notificationId: string;
  schemaVersion: number;
  type: DesktopNotificationType;
  severity: NotificationSeverity;
  title: string;
  body: string;
  createdAt: string; // ISO 8601; server time for remote, local time for local
  expiresAt: string | null; // ISO 8601 or null
  dedupKey: string; // stable event identity, e.g. "meeting:{id}:ready:{revision}"
  action: NotificationAction | null;
  resourceId: string | null; // opaque; NEVER shown in copy
  toastPolicy: ToastPolicy;
  sensitive: boolean; // force generic toast copy when true
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : null;
}

/** Read a field by its snake_case (backend) or camelCase (local) name. */
function pick(obj: Record<string, unknown>, snake: string, camel: string): unknown {
  return obj[snake] !== undefined ? obj[snake] : obj[camel];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T[number])
    : fallback;
}

/** Allowlisted action or null - never a passthrough of an arbitrary string. */
function parseAction(value: unknown): NotificationAction | null {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value)
    ? (value as NotificationAction)
    : null;
}

/**
 * Validate one raw event into a DesktopNotification, or null when it is
 * unusable. Returns null (drops the event) only for the two cases where the
 * shape cannot be trusted at all: a future schema version, or a missing
 * identity/type. Everything else is coerced to a safe default rather than
 * dropped, so a slightly-off producer still reaches the inbox.
 */
export function parseNotification(raw: unknown): DesktopNotification | null {
  const obj = asRecord(raw);
  if (!obj) return null;

  // A version from the future means the shape may carry fields/semantics this
  // client cannot honor - reject rather than guess.
  const versionRaw = pick(obj, "schema_version", "schemaVersion");
  const schemaVersion = typeof versionRaw === "number" ? versionRaw : NaN;
  if (!Number.isInteger(schemaVersion) || schemaVersion !== SCHEMA_VERSION) return null;

  const notificationId = asString(pick(obj, "notification_id", "notificationId")).trim();
  const typeRaw = asString(obj.type).trim();
  if (
    !notificationId
    || notificationId.length > ID_MAX
    || !(NOTIFICATION_TYPES as readonly string[]).includes(typeRaw)
  ) return null;
  const type = typeRaw as DesktopNotificationType;

  const dedupKey = asString(pick(obj, "dedup_key", "dedupKey")).trim() || notificationId;
  const resourceIdRaw = asString(pick(obj, "resource_id", "resourceId")).trim();
  const expiresAtRaw = asString(pick(obj, "expires_at", "expiresAt")).trim();
  const createdAt = asString(pick(obj, "created_at", "createdAt")).trim();
  if (
    dedupKey.length > DEDUP_KEY_MAX
    || resourceIdRaw.length > ID_MAX
    || !Number.isFinite(Date.parse(createdAt))
    || (expiresAtRaw && !Number.isFinite(Date.parse(expiresAtRaw)))
  ) return null;

  return {
    notificationId,
    schemaVersion,
    type,
    severity: oneOf(obj.severity, SEVERITIES, "info"),
    title: truncate(asString(obj.title), TITLE_MAX),
    body: truncate(asString(obj.body), BODY_MAX),
    createdAt,
    expiresAt: expiresAtRaw || null,
    dedupKey,
    // Unknown/missing action is null, never a passthrough - the security rule.
    action: parseAction(obj.action),
    resourceId: resourceIdRaw || null,
    // Unknown toast policy defaults to inbox_only so a malformed event can never
    // force a lock-screen toast.
    toastPolicy: oneOf(pick(obj, "toast_policy", "toastPolicy"), TOAST_POLICIES, "inbox_only"),
    sensitive: pick(obj, "sensitive", "sensitive") === true,
  };
}

/** True when the event has passed its expiry and must not be delivered. */
export function isExpired(notification: DesktopNotification, nowMs: number): boolean {
  if (!notification.expiresAt) return false;
  const expiry = Date.parse(notification.expiresAt);
  return Number.isFinite(expiry) && expiry <= nowMs;
}
