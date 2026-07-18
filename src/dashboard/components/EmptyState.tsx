import type { LucideIcon } from "lucide-react";

/** Premium empty state: a soft icon medallion, a heading, and a line of copy.
 * Shown only after a successful fetch returns nothing - never during load or on
 * error. */
export function EmptyState({
  Icon,
  heading,
  copy,
}: {
  Icon: LucideIcon;
  heading: string;
  copy: string;
}) {
  return (
    <div className="db-empty2">
      <div className="db-empty2-icon">
        <Icon size={24} />
      </div>
      <p className="db-empty2-heading">{heading}</p>
      <p className="db-empty2-copy">{copy}</p>
    </div>
  );
}
