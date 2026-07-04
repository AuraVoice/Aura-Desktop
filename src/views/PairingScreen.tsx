import { useEffect, useState, type FormEvent } from "react";
import { hostname } from "@tauri-apps/plugin-os";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "../lib/firebase";
import { claimPairingCode, PairingError } from "../lib/api";
import { logError } from "../lib/log";
import "./PairingScreen.css";

function PairingScreen() {
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    hostname()
      .then((name) => {
        if (name) setDeviceName(name);
      })
      .catch((err) => logError("PairingScreen: hostname", err));
  }, []);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const customToken = await claimPairingCode(
        code.trim(),
        deviceName.trim(),
      );
      await signInWithCustomToken(auth, customToken);
      // AuthProvider's auth-state listener switches the window to avatar mode.
    } catch (err) {
      if (!(err instanceof PairingError)) {
        logError("PairingScreen: handleSubmit", err);
      }
      setError(
        err instanceof PairingError ? err.message : "Something went wrong. Try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="pairing-screen" onSubmit={handleSubmit}>
      <h2 className="pairing-title">Pair with your phone</h2>
      <p className="pairing-hint">
        Open Aura on your phone and enter the code it shows you.
      </p>
      <input
        className="pairing-code-input"
        value={code}
        onChange={(event) => setCode(event.target.value.toUpperCase())}
        placeholder="XXXX-XXXX"
        autoFocus
        maxLength={9}
      />
      <label className="pairing-device-label">
        Device name
        <input
          className="pairing-device-input"
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
        />
      </label>
      {error && <p className="pairing-error">{error}</p>}
      <button type="submit" disabled={submitting || !code.trim()}>
        {submitting ? "Pairing..." : "Pair"}
      </button>
    </form>
  );
}

export default PairingScreen;
