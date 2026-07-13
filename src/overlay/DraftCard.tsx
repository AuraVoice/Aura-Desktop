import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CheckIcon, CloseIcon, CopyIcon } from "./icons";
import { draftCard as copyStrings } from "../lib/copy";
import type { RefineChip } from "../lib/draft";
import type { DraftCardState } from "./useDraftCard";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./DraftCard.css";

const CHIP_ORDER: readonly RefineChip[] = [
  "shorter",
  "longer",
  "more_formal",
  "warmer",
  "regenerate",
];

// A snippet has no length ladder and no tone; the only chip that makes sense
// is a fresh take. Everything else goes through voice refines.
const SNIPPET_CHIP_ORDER: readonly RefineChip[] = ["regenerate"];

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
    : draft?.artifactKind
      ? draft.title || copyStrings.artifactTitle(draft.artifactKind)
      : copyStrings.title(channel ?? "email_reply");

  const chipDisabled = (chip: RefineChip): boolean => {
    if (phase !== "shown" || !draft) return true;
    if (chip === "shorter") return draft.length === "short";
    if (chip === "longer") return draft.length === "detailed";
    return false;
  };

  let body;
  if (phase === "generating" || phase === "refining") {
    // A pill refine gets the same skeleton as a first-time generate: three
    // pulsing lines where the text lands, never a spinner over dimmed text.
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
    if (draft.contentFormat === "markdown") {
      body = (
        <div className="draft-card-markdown">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            disallowedElements={["a", "img"]}
            unwrapDisallowed
          >
            {draft.text}
          </Markdown>
        </div>
      );
    } else if (draft.contentFormat === "code") {
      body = (
        <pre className="draft-card-snippet" data-language={draft.language || undefined}>
          {draft.text}
        </pre>
      );
    } else {
      body = <p className="draft-card-text">{draft.text}</p>;
    }
  } else {
    body = null;
  }

  // New ephemeral artifacts are regenerated through voice so the complete
  // intent remains in the live turn. Legacy snippets keep their REST button.
  const chips = draft?.artifactKind
    ? []
    : channel === "snippet"
      ? SNIPPET_CHIP_ORDER
      : CHIP_ORDER;

  return (
    <GlassSurface className="draft-card" draggable={false}>
      <div className="draft-card-inner">
        <div className={`draft-card-header${refineFailed ? " draft-card-header-error" : ""}`}>
          <span className="draft-card-title">{title}</span>
          <BarIconButton
            title={
              copied
                ? copyStrings.copiedTooltip
                : draft?.artifactKind
                  ? copyStrings.copyArtifactTooltip
                  : copyStrings.copyTooltip
            }
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

        {chips.length > 0 && (
          <div className="draft-card-chips">
            {chips.map((chip) => (
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
        )}
      </div>
    </GlassSurface>
  );
}
