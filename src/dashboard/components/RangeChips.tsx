/** Time-range filter for Conversations, mirroring the web dashboard's chips.
 * The selected range maps to the `?since=` query on GET /history/sessions
 * ("all" omits it). */

export type RangeKey = "today" | "3d" | "7d" | "30d" | "all";

const RANGE_DAYS: Record<RangeKey, number | null> = {
  today: 1,
  "3d": 3,
  "7d": 7,
  "30d": 30,
  all: null,
};

const RANGE_LABEL: Record<RangeKey, string> = {
  today: "Today",
  "3d": "3 days",
  "7d": "7 days",
  "30d": "30 days",
  all: "All",
};

export const RANGE_ORDER: RangeKey[] = ["today", "3d", "7d", "30d", "all"];

/** ISO `since` for a range, or undefined for "all". */
export function sinceFromRange(range: RangeKey): string | undefined {
  const days = RANGE_DAYS[range];
  if (days == null) return undefined;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function RangeChips({
  value,
  onChange,
}: {
  value: RangeKey;
  onChange: (range: RangeKey) => void;
}) {
  return (
    <div className="db-chips" role="tablist" aria-label="Time range">
      {RANGE_ORDER.map((range) => (
        <button
          key={range}
          type="button"
          role="tab"
          aria-selected={range === value}
          className={`db-chip${range === value ? " db-chip-active" : ""}`}
          onClick={() => onChange(range)}
        >
          {RANGE_LABEL[range]}
        </button>
      ))}
    </div>
  );
}
