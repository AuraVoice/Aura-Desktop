import { authGetJson as authGetJsonBase } from "./api";
import type { DraftChannel, DraftLength } from "./draft";
import { parseMeetingDoc, type MeetingDoc } from "./meetings";

/**
 * Typed client for the desktop dashboard's data, layered on authFetch (Firebase
 * ID token + platform headers, base URL = juno-backend). Every call requires a
 * signed-in user; authFetch throws AuthRequiredError otherwise.
 *
 * ── BACKEND CONTRACTS (juno-backend, already live and consumed by Aura-Web) ──
 * These are the SAME endpoints the production web dashboard uses, so the desktop
 * dashboard shows the user's real cross-surface data (not the desktop-only
 * `/desktop/*` projections, which filter to `surface == "desktop"` and a
 * different memory collection and therefore render empty for most accounts).
 * All responses are JSON, snake_case; this client maps them to camelCase.
 *
 *   GET /desktop/home/stats            -> home summary (Home page)
 *   GET /desktop/activity?limit=<n>    -> merged recent activity (Home page)
 *   GET /desktop/usage                 -> plan usage (Usage page)
 *
 *   GET /history/sessions?since=<ISO?>
 *     -> { sessions: RawHistorySession[], archive: HistoryArchive|null }
 *   GET /history/sessions/{id}
 *     -> RawSessionDetail (summary fields + raw_turns + messages)
 *   GET /drafts       -> { items: RawDraft[] }
 *   GET /screen-saves -> { items: RawScreenSave[] }
 *   GET /meetings/recent?limit=20 -> { items: MeetingDoc[] }
 *   GET /meetings/{id}            -> MeetingDoc
 *
 * The three list endpoints are un-paginated (backend returns the full capped
 * set, ~30 each; drafts auto-expire server-side after 7 days). Range scoping is
 * only via `?since=` on /history/sessions.
 *
 * Each function accepts an optional AbortSignal so callers (the SWR hook) can
 * cancel or time out without changing authFetch's signature.
 */

// Positional adapter over the shared helper (api.ts): every non-2xx throws.
function authGetJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  return authGetJsonBase<T>(path, signal ? { signal } : undefined);
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

export async function getHomeStats(signal?: AbortSignal): Promise<HomeStats> {
  const raw = await authGetJson<RawHomeStats>("/desktop/home/stats", signal);
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

export async function getRecentActivity(
  limit = 8,
  signal?: AbortSignal,
): Promise<ActivityItem[]> {
  const raw = await authGetJson<RawActivity>(`/desktop/activity?limit=${limit}`, signal);
  return raw.items ?? [];
}

// ── Conversations (voice history) ─────────────────────────────────────────
// Shapes mirror Aura-Web src/lib/activity.ts verbatim; this is the wire
// contract the production dashboard reads. Kept snake_case (raw) at the client
// boundary; pages map the fields they render.
export interface RawHistorySession {
  session_id: string;
  started_at: string;
  ended_at: string;
  total_duration: string;
  num_of_turns: number;
  num_of_tool_calls: number;
  summary: string;
  screen_sight_frame_count: number;
}

export interface HistoryArchive {
  archive_summary: string;
  sessions_archived_count: number;
  oldest_archived_session_at: string;
  newest_archived_session_at: string;
}

export interface HistorySessions {
  sessions: RawHistorySession[];
  archive: HistoryArchive | null;
}

interface RawHistorySessionsResponse {
  sessions?: RawHistorySession[];
  archive?: HistoryArchive | null;
}

export async function getHistorySessions(
  sinceIso?: string,
  signal?: AbortSignal,
): Promise<HistorySessions> {
  const query = sinceIso ? `?since=${encodeURIComponent(sinceIso)}` : "";
  const raw = await authGetJson<RawHistorySessionsResponse>(
    `/history/sessions${query}`,
    signal,
  );
  return {
    sessions: raw.sessions ?? [],
    archive: raw.archive ?? null,
  };
}

export interface RawSessionTurn {
  role: string;
  text: string;
  timestamp?: string;
  message_id?: string;
  voice_run_id?: string;
}

export interface RawSessionDetail extends RawHistorySession {
  raw_turns?: RawSessionTurn[];
  messages?: unknown[];
}

export async function getSessionDetail(
  sessionId: string,
  signal?: AbortSignal,
): Promise<RawSessionDetail> {
  return authGetJson<RawSessionDetail>(
    `/history/sessions/${encodeURIComponent(sessionId)}`,
    signal,
  );
}

// ── Drafts ────────────────────────────────────────────────────────────────
export interface RawDraft {
  draft_id: string;
  skill_id: "general" | "linkedin_post" | "tweet" | "email";
  channel: DraftChannel;
  length: DraftLength;
  text: string;
  context_summary: string;
  recipient_hint: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface RawDraftsResponse {
  items?: RawDraft[];
}

export async function getDrafts(signal?: AbortSignal): Promise<RawDraft[]> {
  const raw = await authGetJson<RawDraftsResponse>("/drafts", signal);
  return raw.items ?? [];
}

// ── Saved (screen saves / visual bookmarks) ────────────────────────────────
// `image_url` is a short-lived signed GCS URL minted per response. Never
// persist it: the cache layer strips it and the UI renders it only from a live
// fetch.
export interface RawScreenSave {
  item_id: string;
  title: string;
  description: string;
  collection_name: string;
  note: string;
  source_url: string | null;
  image_url: string | null;
  created_at: string;
}

interface RawScreenSavesResponse {
  items?: RawScreenSave[];
}

export async function getScreenSaves(signal?: AbortSignal): Promise<RawScreenSave[]> {
  const raw = await authGetJson<RawScreenSavesResponse>("/screen-saves", signal);
  return raw.items ?? [];
}

interface RawMeetingsResponse {
  items?: unknown;
}

export async function getMeetings(signal?: AbortSignal): Promise<MeetingDoc[]> {
  const raw = await authGetJson<RawMeetingsResponse>("/meetings/recent?limit=20", signal);
  return Array.isArray(raw.items)
    ? raw.items.map(parseMeetingDoc).filter((meeting): meeting is MeetingDoc => meeting !== null)
    : [];
}

export async function getMeeting(
  meetingId: string,
  signal?: AbortSignal,
): Promise<MeetingDoc | null> {
  const raw = await authGetJson<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}`,
    signal,
  );
  return parseMeetingDoc(raw);
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
