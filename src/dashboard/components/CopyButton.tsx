import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { logError } from "../../lib/log";

/** Copies `text` to the clipboard with a brief "Copied" confirmation.
 * `compact` renders an icon-only button meant to sit in the top-right corner of
 * the content it copies; the default renders a labelled pill. */
export function CopyButton({ text, compact = false }: { text: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      logError("CopyButton: clipboard write", err);
    }
  };

  const Icon = copied ? Check : Copy;

  if (compact) {
    return (
      <button
        type="button"
        className={`db-copy-compact${copied ? " db-copy-compact-done" : ""}`}
        title={copied ? "Copied" : "Copy"}
        aria-label={copied ? "Copied" : "Copy"}
        onClick={onCopy}
      >
        <Icon size={15} />
      </button>
    );
  }

  return (
    <button type="button" className="db-modal-action" onClick={onCopy}>
      <Icon size={15} />
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
