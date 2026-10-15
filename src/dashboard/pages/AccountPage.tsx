import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useDashboardUser } from "../useDashboardUser";
import {
  SettingsPageLayout,
  SettingsSection,
} from "../components/SettingsPageLayout";
import { DeleteAccountError, deleteAccount, type DeleteAccountFailure } from "../../lib/accountDeletion";
import { privacyUrl, termsUrl } from "../../lib/copy";
import { logError } from "../../lib/log";
import { signOutSession } from "../../lib/signOutSession";

const DELETE_FAILURE_COPY: Record<DeleteAccountFailure, string> = {
  entitlement_unavailable: "Aura couldn't check your plan just now, so nothing was deleted. Try again in a minute.",
  subscription_cancel_failed:
    "Your plan couldn't be cancelled, so nothing was deleted. Try again, or cancel it from Plans and billing first.",
  deletion_failed: "Deletion didn't finish. Try again to complete it.",
  unreachable:
    "Aura couldn't reach its servers, so your account may not be deleted yet. Check your connection and try again.",
};

type DeletePhase =
  | { kind: "idle" }
  | { kind: "confirming"; typed: string; error: DeleteAccountFailure | null }
  | { kind: "deleting" }
  | { kind: "deleted"; appleSubscriptionActive: boolean; localFailures: string[] };

/** Delete account: a typed confirmation, then the backend deletion (which cancels a
 * web plan first), then this computer's copy, then sign-out. */
function DeleteAccountSection() {
  const [phase, setPhase] = useState<DeletePhase>({ kind: "idle" });
  const deletedRef = useRef(false);

  // A deleted account cannot refresh its session, so leaving the page signs out
  // even if Finish was never pressed.
  useEffect(() => () => {
    if (deletedRef.current) void signOutSession("user").catch((err) => logError("AccountPage: sign out", err));
  }, []);

  const confirmDelete = async () => {
    setPhase({ kind: "deleting" });
    try {
      const result = await deleteAccount();
      deletedRef.current = true;
      setPhase({ kind: "deleted", ...result });
    } catch (err) {
      const reason = err instanceof DeleteAccountError ? err.reason : "deletion_failed";
      setPhase({ kind: "confirming", typed: "", error: reason });
    }
  };

  const finish = () => {
    deletedRef.current = false;
    void signOutSession("user").catch((err) => logError("AccountPage: sign out", err));
  };

  return (
    <SettingsSection title="Delete account" description="Permanently delete your Aura account on every device.">
      <div className="db-panel db-account-delete">
        {phase.kind === "deleted" ? (
          <>
            <p className="db-account-delete-done" role="status">Your account is deleted.</p>
            {phase.appleSubscriptionActive && (
              <p>
                Your App Store plan is still active and Apple keeps billing it. Cancel it on your iPhone in
                Settings, then your name, then Subscriptions.
              </p>
            )}
            {phase.localFailures.length > 0 && (
              <p>
                Some of this account's data on this computer couldn't be removed. It stays encrypted and no
                other account can open it.
              </p>
            )}
            <div className="db-account-delete-actions">
              <button type="button" onClick={finish}>Finish</button>
            </div>
          </>
        ) : (
          <>
            <p>
              This deletes your conversations, memories, meeting notes, recordings and dictations on Aura's servers,
              and this account's data on this computer. A plan you bought on auravoiceapp.com is cancelled. This
              can't be undone.
            </p>
            {phase.kind === "idle" ? (
              <div className="db-account-delete-actions">
                <button
                  type="button"
                  className="is-danger"
                  onClick={() => setPhase({ kind: "confirming", typed: "", error: null })}
                >
                  Delete account
                </button>
              </div>
            ) : (
              <>
                <label className="db-account-delete-confirm">
                  <span>Type delete to confirm</span>
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={phase.kind === "deleting"}
                    value={phase.kind === "confirming" ? phase.typed : "delete"}
                    onChange={(event) =>
                      phase.kind === "confirming" &&
                      setPhase({ ...phase, typed: event.target.value })
                    }
                  />
                </label>
                {phase.kind === "confirming" && phase.error && (
                  <p className="db-settings-inline-error" role="alert">{DELETE_FAILURE_COPY[phase.error]}</p>
                )}
                <div className="db-account-delete-actions">
                  <button
                    type="button"
                    className="is-danger"
                    disabled={
                      phase.kind === "deleting" ||
                      (phase.kind === "confirming" && phase.typed.trim().toLowerCase() !== "delete")
                    }
                    onClick={() => void confirmDelete()}
                  >
                    {phase.kind === "deleting" ? "Deleting your account..." : "Delete my account"}
                  </button>
                  <button
                    type="button"
                    disabled={phase.kind === "deleting"}
                    onClick={() => setPhase({ kind: "idle" })}
                  >
                    Cancel
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
}

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

      <SettingsSection title="Legal" description="The terms you agreed to, and how Aura handles your data.">
        <div className="db-panel db-settings-panel db-legal-links">
          <button
            type="button"
            className="db-secondary-btn"
            onClick={() => void openUrl(privacyUrl).catch((err) => logError("AccountPage: open privacy", err))}
          >
            Privacy Policy
          </button>
          <button
            type="button"
            className="db-secondary-btn"
            onClick={() => void openUrl(termsUrl).catch((err) => logError("AccountPage: open terms", err))}
          >
            Terms of Service
          </button>
        </div>
      </SettingsSection>

      <DeleteAccountSection />
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
