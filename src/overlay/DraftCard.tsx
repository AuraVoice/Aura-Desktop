import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CheckIcon, CloseIcon, CopyIcon } from "./icons";
import { draftCard as copyStrings } from "../lib/copy";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { RefineChip } from "../lib/draft";
import type { DraftCardState } from "./useDraftCard";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import "./DraftCard.css";

export const MESSAGE_REFINE_CHIPS: readonly RefineChip[] = [
  "shorter",
  "longer",
  "warmer",
  "regenerate",
];

export const INITIAL_DRAFT_SLOT_HEIGHT = 180;
const MIN_DRAFT_SLOT_HEIGHT = 142;
const MAX_DRAFT_SLOT_HEIGHT = 620;
const NOTCH_GAP = 6;

export function boundedDraftSlotHeight(contentHeight: number, availableHeight: number): number {
  const displayCap = Math.max(MIN_DRAFT_SLOT_HEIGHT, availableHeight - 80);
  const maxHeight = Math.min(MAX_DRAFT_SLOT_HEIGHT, displayCap);
  return Math.round(Math.min(maxHeight, Math.max(MIN_DRAFT_SLOT_HEIGHT, contentHeight + NOTCH_GAP)));
}

// A snippet has no length ladder and no tone; the only chip that makes sense
// is a fresh take. Everything else goes through voice refines.
const SNIPPET_CHIP_ORDER: readonly RefineChip[] = ["regenerate"];

/**
 * The Buddy Drafts card, rendered by OverlayRoot below the bar (its own glass
 * box, matching the bar's visual language). draggable={false}: the card is for
 * reading, selecting, and clicking, never for dragging the window - and every
 * interactive element is a real <button> per the drag-region rule.
 */
export function DraftCard({
  card,
  onHeightChange,
}: {
  card: DraftCardState;
  onHeightChange?: (height: number) => void;
}) {
  const { phase, channel, draft, errorReason, copied, refineFailed } = card;
  const innerRef = useRef<HTMLDivElement>(null);

  const measureHeight = useCallback(() => {
    const inner = innerRef.current;
    if (!inner || !onHeightChange) return;
    const style = window.getComputedStyle(inner);
    const padding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    const gap = Number.parseFloat(style.rowGap || style.gap) || 0;
    const children = Array.from(inner.children) as HTMLElement[];
    const childrenHeight = children.reduce(
      (total, child) => total + Math.max(child.scrollHeight, child.getBoundingClientRect().height),
      0,
    );
    const availableHeight = window.screen?.availHeight ?? MAX_DRAFT_SLOT_HEIGHT + 80;
    onHeightChange(
      boundedDraftSlotHeight(padding + childrenHeight + gap * Math.max(0, children.length - 1), availableHeight),
    );
  }, [onHeightChange]);

  useLayoutEffect(() => {
    measureHeight();
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureHeight);
    observer.observe(inner);
    Array.from(inner.children).forEach((child) => observer.observe(child));
    window.addEventListener("resize", measureHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureHeight);
    };
  }, [measureHeight, phase, draft?.text]);

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
    const errorCopy =
      errorReason === "quota_exceeded"
        ? copyStrings.quotaReached
        : errorReason === "timeout"
          ? copyStrings.failedTimeout
          : errorReason === "model_error"
            ? copyStrings.failedModel
            : errorReason === "invalid_request"
              ? copyStrings.failedInvalid
              : errorReason === "no_frame"
                ? copyStrings.failedNoFrame
                : copyStrings.failed;
    body = (
      <p className="draft-card-error">
        {errorCopy}
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
      : MESSAGE_REFINE_CHIPS;

  return (
    <GlassSurface className="draft-card" draggable={false}>
      <div className="draft-card-inner" ref={innerRef}>
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
