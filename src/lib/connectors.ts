import { authFetch } from "./api";

export interface GoogleCalendarConnectorStatus {
  enabled: boolean;
  canReconnect: boolean;
  watchActive: boolean;
  calendarName: string;
  calendarTimeZone: string | null;
  connectedAt: string | null;
  lastSyncedAt: string | null;
  lastSyncStatus: string | null;
  pendingSync: boolean;
  lastError: string | null;
}

export interface GmailConnectorStatus {
  enabled: boolean;
  canReconnect: boolean;
  emailAddress: string | null;
  connectedAt: string | null;
  lastError: string | null;
}

export interface NotionConnectorStatus {
  enabled: boolean;
  canReconnect: boolean;
  workspaceName: string | null;
  connectedAt: string | null;
  lastError: string | null;
}

export interface ConnectorsCatalog {
  googleCalendar: GoogleCalendarConnectorStatus;
  gmail: GmailConnectorStatus;
  notion: NotionConnectorStatus;
}

export class ConnectorReauthorizationRequiredError extends Error {}
export type ConnectorName = "google_calendar" | "gmail" | "notion";

// Per-connector OAuth host allowlist. Never widen to "any https": that turns
// a backend compromise into an open redirect on the user's machine.
const TRUSTED_AUTH_HOSTS: Record<ConnectorName, string> = {
  google_calendar: "accounts.google.com",
  gmail: "accounts.google.com",
  notion: "api.notion.com",
};

export interface ConnectorOAuthAuthorization {
  attemptId: string;
  authorizationUrl: string;
  expiresInSeconds: number;
}

type RawCalendarStatus = Partial<{
  enabled: unknown;
  can_reconnect: unknown;
  watch_active: unknown;
  calendar_name: unknown;
  calendar_time_zone: unknown;
  connected_at: unknown;
  last_synced_at: unknown;
  last_sync_status: unknown;
  pending_sync: unknown;
  last_error: unknown;
}>;

type RawGmailStatus = Partial<{
  enabled: unknown;
  can_reconnect: unknown;
  email_address: unknown;
  connected_at: unknown;
  last_error: unknown;
}>;

type RawNotionStatus = Partial<{
  enabled: unknown;
  can_reconnect: unknown;
  workspace_name: unknown;
  connected_at: unknown;
  last_error: unknown;
}>;

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function parseCalendarStatus(raw: RawCalendarStatus): GoogleCalendarConnectorStatus {
  return {
    enabled: raw.enabled === true,
    canReconnect: raw.can_reconnect === true,
    watchActive: raw.watch_active === true,
    calendarName: optionalString(raw.calendar_name) ?? "Primary",
    calendarTimeZone: optionalString(raw.calendar_time_zone),
    connectedAt: optionalString(raw.connected_at),
    lastSyncedAt: optionalString(raw.last_synced_at),
    lastSyncStatus: optionalString(raw.last_sync_status),
    pendingSync: raw.pending_sync === true,
    lastError: optionalString(raw.last_error),
  };
}

function parseGmailStatus(raw: RawGmailStatus): GmailConnectorStatus {
  return {
    enabled: raw.enabled === true,
    canReconnect: raw.can_reconnect === true,
    emailAddress: optionalString(raw.email_address),
    connectedAt: optionalString(raw.connected_at),
    lastError: optionalString(raw.last_error),
  };
}

function parseNotionStatus(raw: RawNotionStatus): NotionConnectorStatus {
  return {
    enabled: raw.enabled === true,
    canReconnect: raw.can_reconnect === true,
    workspaceName: optionalString(raw.workspace_name),
    connectedAt: optionalString(raw.connected_at),
    lastError: optionalString(raw.last_error),
  };
}

export function parseConnectorsCatalog(raw: unknown): ConnectorsCatalog {
  const data = typeof raw === "object" && raw !== null
    ? raw as Record<string, unknown>
    : {};
  const calendar = typeof data.google_calendar === "object" && data.google_calendar !== null
    ? data.google_calendar as RawCalendarStatus
    : {};
  const gmail = typeof data.gmail === "object" && data.gmail !== null
    ? data.gmail as RawGmailStatus
    : {};
  const notion = typeof data.notion === "object" && data.notion !== null
    ? data.notion as RawNotionStatus
    : {};
  return {
    googleCalendar: parseCalendarStatus(calendar),
    gmail: parseGmailStatus(gmail),
    notion: parseNotionStatus(notion),
  };
}

async function readCalendarStatus(
  response: Response,
  action: string,
): Promise<GoogleCalendarConnectorStatus> {
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status})`);
  }
  return parseCalendarStatus((await response.json()) as RawCalendarStatus);
}

async function readGmailStatus(
  response: Response,
  action: string,
): Promise<GmailConnectorStatus> {
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "reauthorization_required") {
      throw new ConnectorReauthorizationRequiredError("reauthorization_required");
    }
  }
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status})`);
  }
  return parseGmailStatus((await response.json()) as RawGmailStatus);
}

export async function fetchConnectors(): Promise<ConnectorsCatalog> {
  const response = await authFetch("/connectors");
  if (!response.ok) {
    throw new Error(`Connector status failed (${response.status})`);
  }
  return parseConnectorsCatalog(await response.json());
}

export async function startConnectorOAuth(
  connector: ConnectorName,
): Promise<ConnectorOAuthAuthorization> {
  const response = await authFetch("/connectors/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ connector }),
  });
  if (!response.ok) {
    throw new Error(`Connector authorization failed (${response.status})`);
  }
  const data = (await response.json()) as Partial<{
    attempt_id: unknown;
    authorization_url: unknown;
    expires_in_seconds: unknown;
  }>;
  if (
    typeof data.attempt_id !== "string"
    || typeof data.authorization_url !== "string"
    || typeof data.expires_in_seconds !== "number"
  ) {
    throw new Error("Connector authorization response is malformed");
  }
  const url = new URL(data.authorization_url);
  if (url.protocol !== "https:" || url.hostname !== TRUSTED_AUTH_HOSTS[connector]) {
    throw new Error("Connector authorization URL is not trusted");
  }
  return {
    attemptId: data.attempt_id,
    authorizationUrl: data.authorization_url,
    expiresInSeconds: data.expires_in_seconds,
  };
}

export async function enableGoogleCalendar(): Promise<GoogleCalendarConnectorStatus> {
  const response = await authFetch("/connectors/google-calendar/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "reauthorization_required") {
      throw new ConnectorReauthorizationRequiredError("reauthorization_required");
    }
  }
  return readCalendarStatus(response, "Calendar enable");
}

export async function disableGoogleCalendar(): Promise<GoogleCalendarConnectorStatus> {
  const response = await authFetch("/connectors/google-calendar/disable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return readCalendarStatus(response, "Calendar disable");
}

export async function syncGoogleCalendar(): Promise<GoogleCalendarConnectorStatus> {
  const response = await authFetch("/connectors/google-calendar/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return readCalendarStatus(response, "Calendar sync");
}

export async function enableGmail(): Promise<GmailConnectorStatus> {
  const response = await authFetch("/connectors/gmail/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return readGmailStatus(response, "Gmail enable");
}

export async function disableGmail(): Promise<GmailConnectorStatus> {
  const response = await authFetch("/connectors/gmail/disable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return readGmailStatus(response, "Gmail disable");
}

async function readNotionStatus(
  response: Response,
  action: string,
): Promise<NotionConnectorStatus> {
  if (response.status === 409) {
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "reauthorization_required") {
      throw new ConnectorReauthorizationRequiredError("reauthorization_required");
    }
  }
  if (!response.ok) {
    throw new Error(`${action} failed (${response.status})`);
  }
  return parseNotionStatus((await response.json()) as RawNotionStatus);
}

export async function enableNotion(): Promise<NotionConnectorStatus> {
  const response = await authFetch("/connectors/notion/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return readNotionStatus(response, "Notion enable");
}

export async function disableNotion(): Promise<NotionConnectorStatus> {
  const response = await authFetch("/connectors/notion/disable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return readNotionStatus(response, "Notion disable");
}
