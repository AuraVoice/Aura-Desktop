import { GlassSurface } from "./GlassSurface";
import { BarIconButton } from "./BarIconButton";
import { CloseIcon } from "./icons";
import { callbackCard as copyStrings } from "../lib/copy";
import type { CallbackCardState } from "./useCallbackCard";
import "./CallbackCard.css";

/**
 * The daily catch-up card, rendered by OverlayRoot below the bar in the same
 * slot as the drafts card (drafts win the slot when both exist). Collapsed:
 * one specific line about the user's life. Expanded: the receipts - the
 * memory chips it knows, each deletable. Every interactive element is a real
 * <button> per the drag-region rule.
 */
export function CallbackCard({ card }: { card: CallbackCardState }) {
  const { line, chips, expanded, deleteFailedId } = card;

  return (
    <GlassSurface className="callback-card" draggable={false}>
      <div className="callback-card-inner">
        <div className="callback-card-header">
          <span className="callback-card-title">{copyStrings.title}</span>
          <BarIconButton title={copyStrings.dismissTooltip} onClick={card.dismiss}>
            <CloseIcon />
          </BarIconButton>
        </div>

        <p className="callback-card-line">{line}</p>

        {chips.length > 0 && (
          <button type="button" className="callback-card-expander" onClick={card.expand}>
            {copyStrings.remembers(chips.length)} {expanded ? "▾" : "▸"}
          </button>
        )}

        {expanded && (
          <div className="callback-card-chips-area">
            <div className="callback-card-chips">
              {chips.map((chip) => (
                <span key={chip.id} className="callback-card-chip">
                  <span className="callback-card-chip-text">
                    {chip.key}: {chip.value}
                  </span>
                  <button
                    type="button"
                    className="callback-card-chip-delete"
                    title={copyStrings.deleteTooltip(chip.key)}
                    onClick={() => card.deleteChip(chip.id)}
                  >
                    <CloseIcon />
                  </button>
                </span>
              ))}
            </div>
            {deleteFailedId !== null && (
              <p className="callback-card-delete-failed">{copyStrings.deleteFailed}</p>
            )}
            <button type="button" className="callback-card-turn-off" onClick={card.turnOff}>
              {copyStrings.turnOff}
            </button>
          </div>
        )}
      </div>
    </GlassSurface>
  );
}
