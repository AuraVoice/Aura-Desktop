import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { GlassSurface } from "../GlassSurface";
import { BarIconButton } from "../BarIconButton";
import { CloseIcon } from "../icons";
import type { InterviewMaterialState } from "./useInterviewMaterial";
import "./InterviewPasteCard.css";

export const INITIAL_INTERVIEW_SLOT_HEIGHT = 260;
const MIN_INTERVIEW_SLOT_HEIGHT = 220;
const MAX_INTERVIEW_SLOT_HEIGHT = 420;
const NOTCH_GAP = 6;

export function boundedInterviewSlotHeight(
  contentHeight: number,
  availableHeight: number,
): number {
  const displayCap = Math.max(MIN_INTERVIEW_SLOT_HEIGHT, availableHeight - 80);
  const maxHeight = Math.min(MAX_INTERVIEW_SLOT_HEIGHT, displayCap);
  return Math.round(
    Math.min(maxHeight, Math.max(MIN_INTERVIEW_SLOT_HEIGHT, contentHeight + NOTCH_GAP)),
  );
}

/**
 * The Interview Mode paste box, rendered by OverlayRoot below the bar.
 *
 * One job: take a job description the user pastes and hand it to the hook. It
 * does not parse, preview, format, or store it, and it never shows it back after
 * sending, because the text belongs to the voice session and nowhere else.
 *
 * `confirmDisplayed` fires from a layout effect, after this has actually rendered
 * and only while the card is visible. That is the difference between telling the
 * worker "the box is on their screen" and telling it "a packet arrived", and the
 * worker speaks a line to the user off the back of it.
 */
export function InterviewPasteCard({
  card,
  onHeightChange,
  visible = false,
}: {
  card: InterviewMaterialState;
  onHeightChange?: (height: number) => void;
  visible?: boolean;
}) {
  const { phase, errorReason, maxBytes, submit, dismiss } = card;
  const confirmDisplayed = card.confirmDisplayed;
  const innerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");

  const byteLength = new TextEncoder().encode(text).length;
  const overLimit = byteLength > maxBytes;
  const canSend = phase === "open" && text.trim().length > 0 && !overLimit;

  const measureHeight = useCallback(() => {
    const inner = innerRef.current;
    if (!inner || !onHeightChange) return;
    onHeightChange(inner.getBoundingClientRect().height);
  }, [onHeightChange]);

  useLayoutEffect(() => {
    measureHeight();
    if (visible && phase === "open") confirmDisplayed();
  }, [measureHeight, phase, visible, confirmDisplayed]);

  // A box the user has to click into first is a box they will paste past. The
  // worker has just told them out loud that it is there.
  useEffect(() => {
    if (phase === "open") textareaRef.current?.focus();
  }, [phase]);

  // The text is the voice session's, not this component's: drop it the moment it
  // is no longer being typed.
  useEffect(() => {
    if (phase === "idle" || phase === "sent") setText("");
  }, [phase]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter alone inserts a newline: a pasted posting is multi-line, and
      // stealing Enter would send it half-typed.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSend) {
        event.preventDefault();
        submit(text);
      }
    },
    [canSend, submit, text],
  );

  return (
    <GlassSurface className="interview-paste-card" draggable={false}>
      <div className="interview-paste-inner" ref={innerRef}>
        <div className="interview-paste-header">
          <span className="interview-paste-title">Paste the job description</span>
          <BarIconButton
            title="Close"
            onClick={dismiss}
            disabled={phase === "sending"}
          >
            <CloseIcon />
          </BarIconButton>
        </div>

        <textarea
          ref={textareaRef}
          className="interview-paste-input"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Paste it here. I'll read it, you don't have to."
          spellCheck={false}
          disabled={phase !== "open"}
        />

        <div className="interview-paste-footer">
          <span
            className={`interview-paste-hint${
              overLimit || errorReason ? " interview-paste-hint-error" : ""
            }`}
          >
            {errorReason
              ? "That didn't send. Try again, or just tell me about the role."
              : overLimit
                ? "That's longer than I can take. Paste the main part."
                : phase === "sending"
                  ? "Sending..."
                  : "Nothing is saved. It stays in this call."}
          </span>
          <button
            type="button"
            className="interview-paste-send"
            onClick={() => submit(text)}
            disabled={!canSend}
          >
            {phase === "sending" ? "Sending" : "Send"}
          </button>
        </div>
      </div>
    </GlassSurface>
  );
}
