import QRCode from "react-qr-code";
import { getAuraAppUrl } from "../../lib/copy";
import {
  SettingsPageLayout,
  SettingsSection,
} from "../components/SettingsPageLayout";

export function MobileAppPage() {
  return (
    <SettingsPageLayout
      title="Aura on mobile"
      description="Take Aura with you and keep the same account on every device."
    >
      <div className="db-panel db-mobile">
        <div className="db-qr"><QRCode value={getAuraAppUrl} size={156} /></div>
        <div className="db-mobile-content">
          <span className="db-eyebrow">Aura for mobile</span>
          <h3>Continue on your phone</h3>
          <p>Scan the QR code with your phone's camera to open the Aura app page.</p>
          <ol className="db-mobile-steps">
            <li>Open your phone's camera.</li>
            <li>Point it at the QR code.</li>
            <li>Sign in with the same Aura account.</li>
          </ol>
        </div>
      </div>

      <SettingsSection
        title="One account, all your devices"
        description="Your subscription and Aura account travel with you."
      >
        <div className="db-panel db-settings-info-row">
          <div>
            <strong>Shared account</strong>
            <p>Use the same sign-in on desktop and mobile.</p>
          </div>
          <div>
            <strong>Shared plan</strong>
            <p>Your Aura subscription applies across both apps.</p>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
}
