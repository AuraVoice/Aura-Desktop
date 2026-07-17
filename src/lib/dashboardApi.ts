import { authFetch } from "./api";

/**
 * Typed client for the desktop dashboard's data, layered on authFetch (Firebase
 * ID token + platform headers, base URL = juno-backend). Every call requires a
 * signed-in user; authFetch throws AuthRequiredError otherwise.
 *
 * ── BACKEND CONTRACTS (juno-backend, separate repo — implement there) ────────
 * All responses are JSON, snake_case; this client maps them to camelCase.
 * All endpoints are authenticated (Bearer Firebase ID token, verified server
 * side) and scoped to the calling user.
 *
 *   GET /desktop/home/stats
 *     -> { last_used_at: string|null (ISO 8601),
 *          last_session_seconds: number|null,
 *          sessions_this_week: number }
 *
 *   GET /desktop/activity?limit=<n>
 *     -> { items: [ { id: string,
 *                     kind: "voice"|"draft"|"saved",
 *                     title: string,
 *                     subtitle?: string,
 *                     timestamp: string (ISO 8601) } ] }
 *
 *   GET /desktop/conversations?limit=<n>&cursor=<opaque?>
 *     -> { items: [ { id: string, title: string, preview?: string,
 *                     started_at: string (ISO), duration_seconds?: number } ],
 *          next_cursor?: string }
 *
 *   GET /desktop/saved?limit=<n>
 *     -> { items: [ { id: string, label: string, value?: string,
 *                     saved_at: string (ISO) } ] }
 *
 *   GET /desktop/usage
 *     -> { voice_minutes_used: number, voice_minutes_limit: number|null,
 *          drafts_used: number, drafts_limit: number|null,
 *          period_start: string (ISO), period_end: string (ISO) }
 *
 * Until these ship, calls reject and pages render their error/empty states.
 */

async function authGetJson<T>(path: string): Promise<T> {
  const response = await authFetch(path);
  if (!response.ok) {
    throw new Error(`GET ${path} -> HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

// ── Home stats ───────────────────────────────────────────────────────────
export interface HomeStats {
  lastUsedAt: string | null;
  lastSessionSeconds: number | null;
  sessionsThisWeek: number;
}

interface RawHomeStats {
  last_used_at: string | null;
  last_session_seconds: number | null;
  sessions_this_week: number;
}

export async function getHomeStats(): Promise<HomeStats> {
  const raw = await authGetJson<RawHomeStats>("/desktop/home/stats");
  return {
    lastUsedAt: raw.last_used_at,
    lastSessionSeconds: raw.last_session_seconds,
    sessionsThisWeek: raw.sessions_this_week ?? 0,
  };
}

// ── Recent activity ──────────────────────────────────────────────────────
export type ActivityKind = "voice" | "draft" | "saved";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  title: string;
  subtitle?: string;
  timestamp: string;
}

interface RawActivity {
  items: Array<{
    id: string;
    kind: ActivityKind;
    title: string;
    subtitle?: string;
    timestamp: string;
  }>;
}

export async function getRecentActivity(limit = 8): Promise<ActivityItem[]> {
  const raw = await authGetJson<RawActivity>(`/desktop/activity?limit=${limit}`);
  return raw.items ?? [];
}

// ── Conversations ────────────────────────────────────────────────────────
export interface ConversationSummary {
  id: string;
  title: string;
  preview?: string;
  startedAt: string;
  durationSeconds?: number;
}

interface RawConversations {
  items: Array<{
    id: string;
    title: string;
    preview?: string;
    started_at: string;
    duration_seconds?: number;
  }>;
  next_cursor?: string;
}

export async function getConversations(limit = 30): Promise<ConversationSummary[]> {
  const raw = await authGetJson<RawConversations>(`/desktop/conversations?limit=${limit}`);
  return (raw.items ?? []).map((item) => ({
    id: item.id,
    title: item.title,
    preview: item.preview,
    startedAt: item.started_at,
    durationSeconds: item.duration_seconds,
  }));
}

// ── Saved items ──────────────────────────────────────────────────────────
export interface SavedItem {
  id: string;
  label: string;
  value?: string;
  savedAt: string;
}

interface RawSaved {
  items: Array<{ id: string; label: string; value?: string; saved_at: string }>;
}

export async function getSavedItems(limit = 50): Promise<SavedItem[]> {
  const raw = await authGetJson<RawSaved>(`/desktop/saved?limit=${limit}`);
  return (raw.items ?? []).map((item) => ({
    id: item.id,
    label: item.label,
    value: item.value,
    savedAt: item.saved_at,
  }));
}

// ── Usage ────────────────────────────────────────────────────────────────
export interface Usage {
  voiceMinutesUsed: number;
  voiceMinutesLimit: number | null;
  draftsUsed: number;
  draftsLimit: number | null;
  periodStart: string;
  periodEnd: string;
}

interface RawUsage {
  voice_minutes_used: number;
  voice_minutes_limit: number | null;
  drafts_used: number;
  drafts_limit: number | null;
  period_start: string;
  period_end: string;
}

export async function getUsage(): Promise<Usage> {
  const raw = await authGetJson<RawUsage>("/desktop/usage");
  return {
    voiceMinutesUsed: raw.voice_minutes_used ?? 0,
    voiceMinutesLimit: raw.voice_minutes_limit,
    draftsUsed: raw.drafts_used ?? 0,
    draftsLimit: raw.drafts_limit,
    periodStart: raw.period_start,
    periodEnd: raw.period_end,
  };
}
