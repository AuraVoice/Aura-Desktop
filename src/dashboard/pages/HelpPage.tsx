import { useState } from "react";
import { sendFeedback } from "../../lib/feedback";
import { logError } from "../../lib/log";

export function HelpPage() {
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  async function openFeedback() {
    setSending(true);
    try {
      await sendFeedback("dashboard");
      setSent(true);
    } catch (err) {
      logError("HelpPage: send feedback", err);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="db-page">
      <div className="db-panel db-help">
        <p className="db-help-title">Need help with Aura?</p>
        <p className="db-muted db-help-copy">Send feedback with desktop diagnostics attached.</p>
        <button type="button" className="db-primary-btn" onClick={() => void openFeedback()} disabled={sending}>
          {sending ? "Opening email..." : sent ? "Email opened" : "Send feedback"}
        </button>
      </div>
    </div>
  );
}
