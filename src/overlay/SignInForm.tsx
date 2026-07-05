import { useState, type ChangeEvent, type FormEvent } from "react";
import { signInWithCustomToken, signInWithEmailAndPassword } from "firebase/auth";
import { openUrl } from "@tauri-apps/plugin-opener";
import { auth } from "../lib/firebase";
import { claimPairingCode, PairingError } from "../lib/api";
import { signIn as copy, privacyUrl, termsUrl } from "../lib/copy";
import { webAuthCopy } from "../lib/webAuthCopy";
import { formatPairingCodeForDisplay, rawPairingCode } from "../lib/pairingCodeFormat";
import { pairingCodeLength, pairingErrorCopy } from "../lib/pairingCopy";
import { logError } from "../lib/log";
import { useWebAuthSignIn } from "./useWebAuthSignIn";
import "./SignInForm.css";

export type Mode = "pairing" | "email" | "google";

export function SignInForm({ initialMode = "pairing" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [code, setCode] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const webAuth = useWebAuthSignIn();

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  async function submitPairing(candidate: string) {
    setSubmitting(true);
    setError(null);
    let customToken: string;
    try {
      customToken = await claimPairingCode(candidate);
    } catch (err) {
      if (err instanceof PairingError) {
        setError(err.message);
      } else {
        logError("SignInForm: submitPairing", err);
        setError(pairingErrorCopy.otherFailure);
      }
      setSubmitting(false);
      return;
    }

    try {
      // AuthProvider's auth-state listener takes it from here (pushes
      // set_panel_variant("bar") once Firebase resolves the new user).
      await signInWithCustomToken(auth, customToken);
    } catch (err) {
      logError("SignInForm: signInWithCustomToken", err);
      setError(pairingErrorCopy.signInFailed);
    } finally {
      setSubmitting(false);
    }
  }

  function handleCodeChange(event: ChangeEvent<HTMLInputElement>) {
    const formatted = formatPairingCodeForDisplay(event.target.value);
    setCode(formatted);
    if (!submitting && rawPairingCode(formatted).length === pairingCodeLength) {
      void submitPairing(formatted);
    }
  }

  function handlePairingSubmit(event: FormEvent) {
    event.preventDefault();
    void submitPairing(code);
  }

  async function handleEmailSubmit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      logError("SignInForm: signInWithEmailAndPassword", err);
      setError("Couldn't sign in. Check your email and password.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sign-in-form">
      {mode === "pairing" && (
        <form className="sign-in-fields" onSubmit={handlePairingSubmit}>
          <p className="sign-in-prompt">{copy.pairingPrompt}</p>
          <input
            className="sign-in-code-input"
            value={code}
            onChange={handleCodeChange}
            placeholder={copy.pairingCodeHint}
            maxLength={9}
            autoFocus
            disabled={submitting}
          />
          {error && <p className="sign-in-error">{error}</p>}
          <div className="sign-in-actions">
            <button
              type="submit"
              className="sign-in-submit"
              disabled={submitting || rawPairingCode(code).length !== pairingCodeLength}
            >
              {submitting ? copy.submitPairingBusy : copy.submitPairingIdle}
            </button>
            <button type="button" className="sign-in-mode-toggle" onClick={() => switchMode("email")}>
              {copy.switchToEmail}
            </button>
            <button type="button" className="sign-in-mode-toggle" onClick={() => switchMode("google")}>
              {copy.switchToGoogle}
            </button>
          </div>
        </form>
      )}
      {mode === "email" && (
        <form className="sign-in-fields" onSubmit={handleEmailSubmit}>
          <p className="sign-in-prompt">{copy.emailPrompt}</p>
          <input
            type="email"
            className="sign-in-email-input"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder={copy.emailHint}
            autoFocus
            disabled={submitting}
          />
          <input
            type="password"
            className="sign-in-password-input"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={copy.passwordHint}
            disabled={submitting}
          />
          {error && <p className="sign-in-error">{error}</p>}
          <div className="sign-in-actions">
            <button
              type="submit"
              className="sign-in-submit"
              disabled={submitting || !email.trim() || !password}
            >
              {submitting ? copy.submitEmailBusy : copy.submitEmailIdle}
            </button>
            <button type="button" className="sign-in-mode-toggle" onClick={() => switchMode("pairing")}>
              {copy.switchToPairing}
            </button>
            <button type="button" className="sign-in-mode-toggle" onClick={() => switchMode("google")}>
              {copy.switchToGoogle}
            </button>
          </div>
        </form>
      )}
      {mode === "google" && (
        <div className="sign-in-fields">
          {webAuth.state.phase === "idle" && (
            <>
              <p className="sign-in-prompt">{copy.googlePrompt}</p>
              <div className="sign-in-actions">
                <button type="button" className="sign-in-submit" onClick={() => void webAuth.start()}>
                  {copy.submitGoogleSignInIdle}
                </button>
                <button type="button" className="sign-in-mode-toggle" onClick={() => void webAuth.start()}>
                  {copy.submitGoogleIdle}
                </button>
                <button
                  type="button"
                  className="sign-in-mode-toggle"
                  onClick={() => switchMode("pairing")}
                >
                  {copy.switchFromGoogleToPairing}
                </button>
              </div>
            </>
          )}
          {(webAuth.state.phase === "opening" ||
            webAuth.state.phase === "waiting" ||
            webAuth.state.phase === "signing_in") && (
            <>
              <p className="sign-in-prompt">
                {webAuth.state.phase === "opening" ? webAuthCopy.opening : webAuthCopy.waiting}
              </p>
              <div className="sign-in-actions">
                <button type="button" className="sign-in-mode-toggle" onClick={webAuth.cancel}>
                  {webAuthCopy.cancel}
                </button>
              </div>
            </>
          )}
          {webAuth.state.phase === "expired" && (
            <>
              <p className="sign-in-error">{webAuthCopy.expired}</p>
              <div className="sign-in-actions">
                <button type="button" className="sign-in-submit" onClick={() => void webAuth.start()}>
                  {webAuthCopy.tryAgain}
                </button>
              </div>
            </>
          )}
          {webAuth.state.phase === "failed" && (
            <>
              <p className="sign-in-error">
                {webAuth.state.reason === "account_exists_different_credential"
                  ? webAuthCopy.accountExistsDifferentCredential
                  : webAuth.state.reason === "cancelled"
                    ? webAuthCopy.cancelled
                    : webAuth.state.reason === "popup_blocked"
                      ? webAuthCopy.popupBlocked
                      : webAuthCopy.otherFailure}
              </p>
              <div className="sign-in-actions">
                <button type="button" className="sign-in-submit" onClick={() => void webAuth.start()}>
                  {webAuthCopy.tryAgain}
                </button>
              </div>
            </>
          )}
          {webAuth.state.phase === "error" && (
            <>
              <p className="sign-in-error">{webAuthCopy.otherFailure}</p>
              <div className="sign-in-actions">
                <button type="button" className="sign-in-submit" onClick={() => void webAuth.start()}>
                  {webAuthCopy.tryAgain}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div className="sign-in-legal">
        <button type="button" className="sign-in-legal-link" onClick={() => void openUrl(privacyUrl)}>
          {copy.privacyLabel}
        </button>
        <span className="sign-in-legal-separator"> · </span>
        <button type="button" className="sign-in-legal-link" onClick={() => void openUrl(termsUrl)}>
          {copy.termsLabel}
        </button>
      </div>
    </div>
  );
}
