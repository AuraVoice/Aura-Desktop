import { authFetch, AuthRequiredError } from "./api";
import { logError } from "./log";

/** One remembered fact, mirroring a users/{uid}/memories Firestore row. */
export interface MemoryChip {
  id: string;
  key: string;
  value: string;
  /** Where the fact came from; older rows may predate the field. */
  source: "conversation" | "screen" | null;
}

export interface CallbackCardPayload {
  line: string;
  chips: MemoryChip[];
}

/** The user's local calendar date, the one authority for "today" in the
 * catch-up card contract (the server keys stored lines by this string). */
export function localDateString(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseChip(raw: unknown): MemoryChip | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  const id = typeof row.id === "string" ? row.id : "";
  const key = typeof row.key === "string" ? row.key : "";
  const value = typeof row.value === "string" ? row.value : "";
  if (!id || !key || !value) return null;
  const source =
    row.source === "conversation" || row.source === "screen" ? row.source : null;
  return { id, key, value, source };
}

/**
 * Fetches today's catch-up card. Returns null for every non-card outcome:
 * no stored line yet, gate failed, kill switch, timeout, network error, or an
 * expired session. This is an ambient nicety - it must never surface an
 * error, and unlike drafts it never routes to sign-in on auth failure.
 */
export async function fetchCallbackCard(timeoutMs: number): Promise<CallbackCardPayload | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await authFetch(`/memories/callback?date=${localDateString()}`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { line?: unknown; chips?: unknown };
    if (typeof data.line !== "string" || !data.line.trim()) return null;
    const chips = Array.isArray(data.chips)
      ? data.chips.map(parseChip).filter((c): c is MemoryChip => c !== null)
      : [];
    return { line: data.line, chips };
  } catch (err) {
    if (!(err instanceof AuthRequiredError) && !(err instanceof DOMException && err.name === "AbortError")) {
      logError("fetchCallbackCard", err);
    }
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Deletes one memory row (the chip's X). The date rides along so the backend
 * can invalidate today's stored callback line, which may reference the row.
 * Returns false on any failure so the caller can restore the chip.
 */
export async function deleteMemory(id: string): Promise<boolean> {
  try {
    const response = await authFetch(
      `/memories/${encodeURIComponent(id)}?date=${localDateString()}`,
      { method: "DELETE" },
    );
    return response.ok;
  } catch (err) {
    logError("deleteMemory", err);
    return false;
  }
}
