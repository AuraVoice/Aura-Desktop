import { useState } from "react";
import { sendFeedback } from "../../lib/feedback";
import { logError } from "../../lib/log";
import { osName } from "../../lib/platformKeys";
import {
  SettingsPageLayout,
  SettingsSection,
} from "../components/SettingsPageLayout";

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
    <SettingsPageLayout
      title="How can we help?"
      description="Get support and send useful feedback to the Aura team."
    >
      <div className="db-panel db-help">
        <div>
          <span className="db-eyebrow">Contact support</span>
          <h3>Tell us what happened</h3>
          <p>Open a prefilled email with the technical details needed to investigate.</p>
        </div>
        <button type="button" className="db-primary-btn" onClick={() => void openFeedback()} disabled={sending}>
          {sending ? "Opening email..." : sent ? "Email opened" : "Send feedback"}
        </button>
      </div>

      <SettingsSection
        title="What gets attached"
        description="You can review and edit everything before sending."
      >
        <div className="db-panel db-settings-info-list">
          <div>
            <strong>Device details</strong>
            <p>Aura version and your {osName()} version.</p>
          </div>
          <div>
            <strong>Recent diagnostics</strong>
            <p>The last 40 desktop log lines, with detected tokens and credentials removed.</p>
          </div>
          <div>
            <strong>Your description</strong>
            <p>A space in the email for what you expected and what happened instead.</p>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
}
