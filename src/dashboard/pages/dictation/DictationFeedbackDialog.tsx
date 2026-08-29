import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Flag, ShieldCheck } from "lucide-react";
import { logError } from "../../../lib/log";
import { sendDictationFeedback } from "../../../lib/dictationFeedback";
import type { DictationHistoryEntry } from "../../../lib/dictationHistory";

/**
 * "This transcription was wrong" dialog, opened by a row's flag button.
 *
 * The transcript goes with the report, because the transcript IS the thing
 * being reported and a message without it is close to useless to whoever reads
 * it. That is stated above the submit button rather than buried, along with the
 * fact that the audio never leaves the machine.
 *
 * Portalled into `.db-app` and not document.body: outside that root it would
 * lose the `--db-*` tokens and the app-wide scrollbar rule and fall back to raw
 * chrome on a transparent background.
 */
export function DictationFeedbackDialog({
  entry,
  onClose,
  onSubmitted,
}: {
  entry: DictationHistoryEntry;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const titleId = useId();
  const host = document.querySelector(".db-app");

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!host) return null;

  const submit = async () => {
    if (message.trim() === "") return;
    setBusy(true);
    setError(null);
    try {
      await sendDictationFeedback({
        message,
        transcript: entry.text,
        dictationId: entry.id,
        recordedAtMs: entry.recordedAtMs,
        durationMs: entry.durationMs,
        wordCount: entry.wordCount,
      });
      onSubmitted();
    } catch (err) {
      logError("DictationFeedbackDialog: submit", err);
      setError("That report could not be sent. Your transcript was not changed.");
      setBusy(false);
    }
  };

  return createPortal(
    // Three parts, not two: `db-local-confirm` is the fixed, grid-centred
    // wrapper, the scrim is its absolutely positioned SIBLING backdrop, and the
    // panel sits on top. Using the scrim as the wrapper leaves the panel pinned
    // to the top left, because an absolute box centres nothing.
    <div className="db-local-confirm" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button
        type="button"
        className="db-local-confirm-scrim"
        aria-label="Cancel this report"
        disabled={busy}
        onClick={onClose}
      />
      <div className="db-local-confirm-panel db-dictation-feedback">
        <h2 id={titleId}>Report a bad transcription</h2>
        <p>What did Aura get wrong? A specific word or phrase helps most.</p>
        <textarea
          ref={textareaRef}
          value={message}
          rows={4}
          placeholder="It heard 'Kubernetes' as 'cooper netties'"
          onChange={(event) => setMessage(event.target.value)}
        />
        <p className="db-trace-privacy">
          <ShieldCheck size={14} />
          The transcript you flagged is sent with your report so we can see what
          went wrong. The audio is never uploaded and stays on this PC.
        </p>
        {error && <p className="db-trace-note">{error}</p>}
        <div className="db-local-confirm-actions">
          <button
            type="button"
            className="db-local-confirm-cancel"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="db-local-confirm-delete"
            onClick={() => void submit()}
            disabled={busy || message.trim() === ""}
          >
            <Flag size={15} />
            {busy ? "Sending..." : "Send report"}
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
