import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CheckIcon, CloseIcon, CopyIcon } from "./icons";
import { draftCard as copyStrings } from "../lib/copy";
import type { RefineChip } from "../lib/draft";
import type { DraftCardState } from "./useDraftCard";
import "./DraftCard.css";

const CHIP_ORDER: readonly RefineChip[] = [
  "shorter",
  "longer",
  "more_formal",
  "warmer",
  "regenerate",
];

/**
 * The Buddy Drafts card, rendered by OverlayRoot below the bar (its own glass
 * box, matching the bar's visual language). draggable={false}: the card is for
 * reading, selecting, and clicking, never for dragging the window - and every
 * interactive element is a real <button> per the drag-region rule.
 */
export function DraftCard({ card }: { card: DraftCardState }) {
  const { phase, channel, draft, errorReason, copied, refineFailed } = card;

  const title = refineFailed
    ? copyStrings.refineFailed
    : copyStrings.title(channel ?? "email_reply");

  const chipDisabled = (chip: RefineChip): boolean => {
    if (phase !== "shown" || !draft) return true;
    if (chip === "shorter") return draft.length === "short";
    if (chip === "longer") return draft.length === "detailed";
    return false;
  };

  let body;
  if (phase === "generating") {
    body = (
      <div className="draft-card-shimmer" role="status" aria-label={copyStrings.generating}>
        <span />
        <span />
        <span />
      </div>
    );
  } else if (phase === "error") {
    body = (
      <p className="draft-card-error">
        {errorReason === "quota_exceeded" ? copyStrings.quotaReached : copyStrings.failed}
      </p>
    );
  } else if (draft) {
    body = (
      <div className="draft-card-body-wrap">
        <p className={`draft-card-text${phase === "refining" ? " draft-card-text-refining" : ""}`}>
          {draft.text}
        </p>
        {phase === "refining" && <span className="draft-card-spinner" aria-hidden="true" />}
      </div>
    );
  } else {
    body = null;
  }

  return (
    <GlassSurface className="draft-card" draggable={false}>
      <div className="draft-card-inner">
        <div className={`draft-card-header${refineFailed ? " draft-card-header-error" : ""}`}>
          <span className="draft-card-title">{title}</span>
          <BarIconButton
            title={copied ? copyStrings.copiedTooltip : copyStrings.copyTooltip}
            onClick={card.copy}
            disabled={!draft}
            className={copied ? "draft-card-copied" : undefined}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </BarIconButton>
          <BarIconButton title={copyStrings.dismissTooltip} onClick={card.dismiss}>
            <CloseIcon />
          </BarIconButton>
        </div>

        {body}

        <div className="draft-card-chips">
          {CHIP_ORDER.map((chip) => (
            <button
              key={chip}
              type="button"
              className="draft-card-chip"
              onClick={() => card.refine(chip)}
              disabled={chipDisabled(chip)}
            >
              {copyStrings.chips[chip]}
            </button>
          ))}
        </div>
      </div>
    </GlassSurface>
  );
}
