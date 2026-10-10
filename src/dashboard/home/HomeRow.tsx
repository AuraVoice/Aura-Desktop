import type { ReactNode } from "react";

export type HomeRowTone = "teal" | "violet" | "cyan" | "ember";

interface HomeRowProps {
  icon: ReactNode;
  tone: HomeRowTone;
  title: string;
  detail?: string;
  time?: string;
  onClick?: () => void;
  /** Buttons that sit after the time (Join, Approve). A row with trailing
   * buttons renders as a div, so buttons never nest inside a button. */
  trailing?: ReactNode;
}

/** The one row every Home list uses: icon, title, a grey detail line, and the
 * time on the right. Keeping a single shape is what lets the page be scanned. */
export function HomeRow({ icon, tone, title, detail, time, onClick, trailing }: HomeRowProps) {
  const body = (
    <>
      <span className={`db-home-row-tag is-${tone}`} aria-hidden>
        {icon}
      </span>
      <span className="db-home-row-text">
        <span className="db-home-row-title">{title}</span>
        {detail && <span className="db-home-row-sub">{detail}</span>}
      </span>
      {time && <span className="db-home-row-meta">{time}</span>}
      {trailing && <span className="db-home-row-actions">{trailing}</span>}
    </>
  );
  return onClick && !trailing ? (
    <button type="button" className="db-home-row" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="db-home-row">{body}</div>
  );
}
