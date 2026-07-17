import { useDashboardUser } from "../useDashboardUser";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="db-account-row">
      <span className="db-account-label">{label}</span>
      <span className="db-account-value">{value}</span>
    </div>
  );
}

/** Account details straight from the signed-in Firebase user - no backend call
 * needed. Provider ids tell the user how they signed in (password, google,
 * custom for phone-pairing). */
export function AccountPage() {
  const user = useDashboardUser();

  if (!user) {
    return (
      <div className="db-page">
        <div className="db-empty">You're signed out. Sign in from the Aura overlay first.</div>
      </div>
    );
  }

  const providers = user.providerData.map((p) => p.providerId).join(", ") || "custom";

  return (
    <div className="db-page">
      <div className="db-panel db-account">
        <Row label="Name" value={user.displayName || "—"} />
        <Row label="Email" value={user.email || "—"} />
        <Row label="Email verified" value={user.emailVerified ? "Yes" : "No"} />
        <Row label="Sign-in method" value={providers} />
        <Row label="User ID" value={user.uid} />
      </div>
    </div>
  );
}
