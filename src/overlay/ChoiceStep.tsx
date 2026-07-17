import { useState } from "react";
import type { StoredAnswer } from "../lib/profile";
import "./ChoiceStep.css";

interface ChoiceOption {
  id: string;
  label: string;
}

interface ChoiceStepProps {
  heading: string;
  body: string;
  options: readonly ChoiceOption[];
  otherPlaceholder: string;
  buttonLabel: string;
  /** Option id that reveals the freetext field. Defaults to "other". */
  otherOptionId?: string;
  /** Pre-selects a prior answer when resuming an interrupted first-run. */
  initial?: StoredAnswer;
  onSubmit: (answer: StoredAnswer) => void;
}

/** A single-choice first-run question: a radio list plus an optional freetext
 * that appears when the "other" option is picked. Shared by the where-heard and
 * role steps, which are identical UI over different copy. */
export function ChoiceStep({
  heading,
  body,
  options,
  otherPlaceholder,
  buttonLabel,
  otherOptionId = "other",
  initial,
  onSubmit,
}: ChoiceStepProps) {
  const [selectedId, setSelectedId] = useState<string | null>(initial?.id ?? null);
  const [otherText, setOtherText] = useState(initial?.other ?? "");

  function submit() {
    if (!selectedId) return;
    const other =
      selectedId === otherOptionId && otherText.trim() ? otherText.trim() : undefined;
    onSubmit({ id: selectedId, other });
  }

  return (
    <div className="onboarding-step">
      <h2 className="onboarding-heading">{heading}</h2>
      <p className="onboarding-body">{body}</p>
      <div className="onboarding-choice-list" role="radiogroup" aria-label={heading}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={selectedId === option.id}
            className={`onboarding-choice${selectedId === option.id ? " onboarding-choice-selected" : ""}`}
            onClick={() => setSelectedId(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
      {selectedId === otherOptionId && (
        <input
          type="text"
          className="onboarding-other-input"
          placeholder={otherPlaceholder}
          value={otherText}
          onChange={(e) => setOtherText(e.target.value)}
        />
      )}
      <button
        type="button"
        className="onboarding-primary-button"
        disabled={!selectedId}
        onClick={submit}
      >
        {buttonLabel}
      </button>
    </div>
  );
}
