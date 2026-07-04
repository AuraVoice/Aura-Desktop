import { useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";
import { logError } from "../lib/log";
import "./SignOutPanel.css";

// TODO: this only signs out the local Firebase session. The real contract
// (POST /devices/unlink { device_id }) revokes the user's session on every
// device, not just this one — that call isn't wired yet because nothing in
// the given pairing flow issues this desktop client its own device_id (the
// claim response only returns custom_token). Confirm the device_id source
// (custom claim on the ID token? a separate /devices/register call?) before
// presenting this as a real "sign out everywhere" action to users.
function SignOutPanel() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirmSignOut() {
    setBusy(true);
    setError(null);
    try {
      await signOut(auth);
    } catch (err) {
      logError("SignOutPanel: handleConfirmSignOut", err);
      setError("Couldn't sign out. Try again.");
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        className="sign-out-trigger"
        onClick={() => setConfirming(true)}
      >
        Sign out
      </button>
    );
  }

  return (
    <div className="sign-out-confirm">
      <p className="sign-out-warning">Sign out of Aura on this device?</p>
      {error && <p className="sign-out-error">{error}</p>}
      <div className="sign-out-actions">
        <button
          type="button"
          onClick={() => setConfirming(false)}
          disabled={busy}
        >
          Cancel
        </button>
        <button
          type="button"
          className="sign-out-confirm-button"
          onClick={handleConfirmSignOut}
          disabled={busy}
        >
          {busy ? "Signing out..." : "Sign out"}
        </button>
      </div>
    </div>
  );
}

export default SignOutPanel;
