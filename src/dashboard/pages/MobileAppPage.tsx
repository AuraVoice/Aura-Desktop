import QRCode from "react-qr-code";
import { getAuraAppUrl } from "../../lib/copy";

export function MobileAppPage() {
  return (
    <div className="db-page">
      <div className="db-panel db-mobile">
        <div className="db-qr"><QRCode value={getAuraAppUrl} size={156} /></div>
        <div>
          <p className="db-mobile-title">Aura for mobile</p>
          <p className="db-muted db-mobile-copy">Scan this code with your phone to get Aura.</p>
        </div>
      </div>
    </div>
  );
}
