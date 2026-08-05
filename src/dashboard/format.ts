/** Small display formatters for dashboard data. All tolerate null/invalid
 * input by returning a dash so callers never render "NaN"/"Invalid Date". */

const DASH = "—";

export function relativeTime(iso: string | null, compact = false): string {
  if (!iso) return DASH;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return DASH;
  const diffMs = Date.now() - then;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return compact ? `${mins}m ago` : `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return compact ? `${hours}h ago` : `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return compact ? `${days}d ago` : `${days} day${days === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString();
}

export function shortDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return DASH;
  return d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function duration(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds) || seconds < 0) return DASH;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return DASH;
  return String(n);
}

const TITLE_MAX = 80;

/** First meaningful line of a block of text, whitespace-collapsed and capped.
 * Falls back to `fallback` when the text is blank. Used to turn a session
 * summary or a draft body into a card title. */
export function deriveTitle(text: string | null | undefined, fallback: string): string {
  if (!text) return fallback;
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return fallback;
  const collapsed = firstLine.replace(/\s+/g, " ");
  return collapsed.length > TITLE_MAX ? `${collapsed.slice(0, TITLE_MAX - 1).trimEnd()}…` : collapsed;
}

export function deriveSessionTitle(summary: string | null | undefined): string {
  return deriveTitle(summary, "Voice conversation");
}

export function deriveDraftTitle(text: string | null | undefined): string {
  return deriveTitle(text, "Draft");
}

/** The body of a draft after its opening line (the greeting used as the title),
 * whitespace-collapsed to a single flowing preview. Empty when there is only
 * one line. */
export function bodyAfterTitle(text: string | null | undefined): string {
  if (!text) return "";
  const lines = text.split("\n").map((line) => line.trim());
  const firstIndex = lines.findIndex((line) => line.length > 0);
  if (firstIndex === -1) return "";
  return lines
    .slice(firstIndex + 1)
    .filter((line) => line.length > 0)
    .join(" ")
    .replace(/\s+/g, " ");
}
