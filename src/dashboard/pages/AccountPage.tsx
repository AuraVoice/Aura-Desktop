import { useDashboardUser } from "../useDashboardUser";
import {
  SettingsPageLayout,
  SettingsSection,
} from "../components/SettingsPageLayout";

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
      <SettingsPageLayout
        title="Your account"
        description="Manage the identity you use across Aura."
      >
        <div className="db-panel db-empty">
          You're signed out. Sign in from the Aura overlay first.
        </div>
      </SettingsPageLayout>
    );
  }

  const providers = formatProviders(user.providerData.map((provider) => provider.providerId));
  const initials = getInitials(user.displayName, user.email);
  const memberSince = formatAccountDate(user.metadata.creationTime);
  const lastSignIn = formatAccountDate(user.metadata.lastSignInTime);

  return (
    <SettingsPageLayout
      title="Your account"
      description="Your Aura identity is shared across desktop and mobile."
    >
      <div className="db-panel db-account-summary">
        <div className="db-account-avatar" aria-hidden>{initials}</div>
        <div>
          <h3>{user.displayName || "Aura account"}</h3>
          <p>{user.email || "No email address"}</p>
        </div>
        <span className={`db-status-pill${user.emailVerified ? " is-positive" : ""}`}>
          {user.emailVerified ? "Verified" : "Not verified"}
        </span>
      </div>

      <SettingsSection
        title="Personal details"
        description="These details come from your sign-in account."
      >
        <div className="db-panel db-account">
          <Row label="Name" value={user.displayName || "Not provided"} />
          <Row label="Email" value={user.email || "Not provided"} />
          {memberSince && <Row label="Member since" value={memberSince} />}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Sign-in and security"
        description="How this account is authenticated."
      >
        <div className="db-panel db-account">
          <Row label="Sign-in method" value={providers} />
          <Row label="Email verified" value={user.emailVerified ? "Yes" : "No"} />
          {lastSignIn && <Row label="Last sign-in" value={lastSignIn} />}
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
}

function formatProviders(providerIds: string[]): string {
  if (providerIds.length === 0) return "Aura mobile pairing";
  return providerIds
    .map((providerId) => {
      if (providerId === "google.com") return "Google";
      if (providerId === "password") return "Email and password";
      if (providerId === "phone") return "Phone";
      return providerId;
    })
    .join(", ");
}

function getInitials(name: string | null, email: string | null): string {
  const source = name?.trim() || email?.split("@")[0] || "A";
  const parts = source.split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "A";
}

function formatAccountDate(value: string | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}
