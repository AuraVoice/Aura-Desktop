import { authGetJson as authGetJsonBase } from "./api";
import type { DraftChannel, DraftLength } from "./draft";
import { parseMeetingDoc, type MeetingDoc, type MeetingKind } from "./meetings";

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

/** One page of meetings, newest first. `kind` keeps one resolved note kind;
 *  `before` is the previous page's last createdAt ("Load more"). */
export async function getMeetings(
  signal?: AbortSignal,
  options: { kind?: MeetingKind | ""; before?: string } = {},
): Promise<MeetingDoc[]> {
  const params = new URLSearchParams({ limit: "20" });
  if (options.kind) params.set("kind", options.kind);
  if (options.before) params.set("before", options.before);
  const raw = await authGetJson<RawMeetingsResponse>(`/meetings/recent?${params}`, signal);
  return Array.isArray(raw.items)
    ? raw.items.map(parseMeetingDoc).filter((meeting): meeting is MeetingDoc => meeting !== null)
    : [];
}

export interface MeetingBrief {
  /** The previous recorded meeting in this event's calendar series. */
  last: {
    meetingId: string;
    title: string;
    date: string;
    summary: string;
    actionItems: string[];
    openQuestions: string[];
  } | null;
  /** Other recorded meetings with the same invitees, newest first. */
  related: { meetingId: string; title: string; date: string }[];
}

/** A brief only changes when a meeting in the series finishes, but Home is the
 *  landing route and asks again on every visit. So the last BRIEF_CACHE_SIZE
 *  answers are kept for BRIEF_TTL_MS in an LRU: a Map iterates in insertion
 *  order, so a hit is re-inserted as newest and eviction drops the first key,
 *  both O(1). Not useDashboardResource: event ids are an open key space, and
 *  its memory and disk tiers never evict. The promise is what is cached, so
 *  concurrent asks share one request; it runs on its own timeout because one
 *  caller unmounting must not abort it for the rest. A failure (null) is
 *  evicted so the next visit retries; an empty brief, the common case, stays. */
const BRIEF_CACHE_SIZE = 32;
const BRIEF_TTL_MS = 5 * 60_000;
const BRIEF_TIMEOUT_MS = 15_000;
const briefCache = new Map<string, { at: number; brief: Promise<MeetingBrief | null> }>();

/** What Aura already knows before an upcoming event, for this account. Null on
 *  any failure: the brief is extra context on Home, never an error to show. */
export function getMeetingBrief(uid: string, eventId: string): Promise<MeetingBrief | null> {
  const key = `${uid}:${eventId}`;
  const now = Date.now();
  let entry = briefCache.get(key);
  briefCache.delete(key);
  if (!entry || now - entry.at > BRIEF_TTL_MS) {
    const brief = fetchMeetingBrief(eventId);
    entry = { at: now, brief };
    void brief.then((result) => {
      if (result === null && briefCache.get(key)?.brief === brief) briefCache.delete(key);
    });
  }
  briefCache.set(key, entry);
  if (briefCache.size > BRIEF_CACHE_SIZE) {
    const oldest = briefCache.keys().next().value;
    if (oldest !== undefined) briefCache.delete(oldest);
  }
  return entry.brief;
}

async function fetchMeetingBrief(eventId: string): Promise<MeetingBrief | null> {
  try {
    const raw = await authGetJson<{ last?: Record<string, unknown> | null; related?: unknown }>(
      `/meetings/brief?event_id=${encodeURIComponent(eventId)}`,
      AbortSignal.timeout(BRIEF_TIMEOUT_MS),
    );
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    const list = (value: unknown) =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
    const last = raw.last && text(raw.last.meeting_id)
      ? {
          meetingId: text(raw.last.meeting_id),
          title: text(raw.last.title),
          date: text(raw.last.date),
          summary: text(raw.last.summary),
          actionItems: list(raw.last.action_items),
          openQuestions: list(raw.last.open_questions),
        }
      : null;
    const related = Array.isArray(raw.related)
      ? raw.related.flatMap((item) => {
          const row = item as Record<string, unknown> | null;
          return row && text(row.meeting_id)
            ? [{ meetingId: text(row.meeting_id), title: text(row.title), date: text(row.date) }]
            : [];
        })
      : [];
    return { last, related };
  } catch {
    return null;
  }
}

export interface MeetingSearchResult {
  meeting: MeetingDoc;
  /** Where the best-matching excerpt starts, and the excerpt itself. */
  matchStartS: number;
  excerpt: string;
}

/** Meetings matching a query by meaning (note and transcript), best first. */
export async function searchMeetings(
  query: string,
  signal?: AbortSignal,
): Promise<MeetingSearchResult[]> {
  const raw = await authGetJson<RawMeetingsResponse>(
    `/meetings/search?q=${encodeURIComponent(query)}`,
    signal,
  );
  if (!Array.isArray(raw.items)) return [];
  return raw.items.flatMap((item) => {
    const meeting = parseMeetingDoc(item);
    if (!meeting) return [];
    const match = (item as { match?: { start_s?: unknown; excerpt?: unknown } }).match ?? {};
    return [{
      meeting,
      matchStartS: typeof match.start_s === "number" ? match.start_s : 0,
      excerpt: typeof match.excerpt === "string" ? match.excerpt : "",
    }];
  });
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

// ── Voice profile (Insights persona card) ─────────────────────────────────
export interface VoiceProfile {
  title: string;
  blurb: string;
  generatedAt: string;
}

interface RawVoiceProfileResponse {
  profile?: { title?: string; blurb?: string; generated_at?: string } | null;
}

/** Null on ANY failure, including a backend that predates the endpoint (404):
 * the persona card simply stays hidden rather than erroring the page. */
export async function getVoiceProfile(signal?: AbortSignal): Promise<VoiceProfile | null> {
  try {
    const raw = await authGetJson<RawVoiceProfileResponse>("/insights/voice-profile", signal);
    if (!raw.profile?.title || !raw.profile.blurb) return null;
    return {
      title: raw.profile.title,
      blurb: raw.profile.blurb,
      generatedAt: raw.profile.generated_at ?? "",
    };
  } catch {
    return null;
  }
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
