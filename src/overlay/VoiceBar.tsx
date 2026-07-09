import { useCallback, useEffect, useRef, useState } from "react";
import { signOut } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { auth } from "../lib/firebase";
import { bar as copy, signOut as signOutCopy, update as updateCopy, hotkeyHints } from "../lib/copy";
import { logError, logInfo } from "../lib/log";
import { sendFeedback } from "../lib/feedback";
import { openDashboard } from "../lib/dashboardLink";
import { AvatarIcon, DashboardIcon, FeedbackIcon, IncognitoOffIcon, IncognitoOnIcon, RefreshIcon, SettingsIcon, SignOutIcon, UpdateIcon, WaveformIcon } from "./icons";
import { BarIconButton } from "./BarIconButton";
import type { VoiceBarState } from "./useVoiceBar";
import { useUpdateReady } from "./useUpdateReady";
import iconUrl from "../assets/icons/Aura-Icon.png";
import "./VoiceBar.css";

interface VoiceBarProps {
  voice: VoiceBarState;
  screenSight: { armed: boolean; toggleArmed: () => void; savedConfirmation: string | null };
}

const LIVE_STATUSES = new Set(["connecting", "ready", "listening", "processing", "speaking"]);

// Covers both endSession() (the only genuinely network-touching step here,
// via LiveKit's room.disconnect()) and signOut(auth) (local-only, should
// resolve near-instantly) under one bound - a stale focus-forcing thread on
// the Rust side could otherwise leave this screen stuck with no way out.
const SIGN_OUT_STUCK_TIMEOUT_MS = 8_000;

export function VoiceBar({ voice, screenSight }: VoiceBarProps) {
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signOutStuck, setSignOutStuck] = useState(false);
  const signOutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [feedbackSending, setFeedbackSending] = useState(false);
  const [feedbackJustSent, setFeedbackJustSent] = useState(false);
  const feedbackSentTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [updatePrompt, setUpdatePrompt] = useState<"hidden" | "confirm" | "restarting" | "deferred" | "failed">("hidden");
  const update = useUpdateReady();

  const isLive = LIVE_STATUSES.has(voice.status);
  const isError = voice.status === "error";
  const updatedNotice = update.updatedNotice ? updateCopy.updatedNotice(update.updatedNotice) : null;
  const isSavedConfirmation = !voice.errorMessage && (!!screenSight.savedConfirmation || !!updatedNotice);
  const caption = voice.errorMessage ?? screenSight.savedConfirmation ?? updatedNotice ?? (voice.assistantCaption || "");

  const clearSignOutTimeout = useCallback(() => {
    if (signOutTimeoutRef.current) {
      clearTimeout(signOutTimeoutRef.current);
      signOutTimeoutRef.current = null;
    }
  }, []);

  // Safety net only - every normal exit path (success/failure/dismiss) below
  // already clears this itself. Covers VoiceBar unmounting (sign-out actually
  // succeeded) with the timer still pending.
  useEffect(() => clearSignOutTimeout, [clearSignOutTimeout]);

  useEffect(
    () => () => {
      if (feedbackSentTimeoutRef.current) clearTimeout(feedbackSentTimeoutRef.current);
    },
    [],
  );

  function handleSendFeedback() {
    if (feedbackSending) return;
    setFeedbackSending(true);
    sendFeedback(voice.status)
      .then(() => {
        setFeedbackJustSent(true);
        if (feedbackSentTimeoutRef.current) clearTimeout(feedbackSentTimeoutRef.current);
        feedbackSentTimeoutRef.current = setTimeout(() => setFeedbackJustSent(false), 2500);
      })
      .catch((err) => logError("VoiceBar: sendFeedback", err))
      .finally(() => setFeedbackSending(false));
  }

  function handleMicClick() {
    if (isLive) {
      void voice.endSession();
    } else {
      void voice.startSession();
    }
  }

  function handleMinimize() {
    invoke("minimize_to_pill").catch((err) => logError("VoiceBar: minimize_to_pill", err));
  }

  function handleInstallUpdate() {
    // "Restarting..." goes up BEFORE the invoke: on Windows install() never
    // returns (the process exits into the installer, which relaunches the
    // app itself), so this promise only ever resolves on a deferral, an
    // error, or a non-Windows install.
    setUpdatePrompt("restarting");
    invoke<boolean>("install_update")
      .then((installed) => {
        if (!installed) setUpdatePrompt("deferred");
        // true: Rust is restarting the app - keep "Restarting..." on screen.
      })
      .catch((err) => {
        logError("VoiceBar: install_update", err);
        setUpdatePrompt("failed");
      });
  }

  const micTooltip = isError ? copy.micTryAgainTooltip : isLive ? copy.micEndCallTooltip : copy.micTalkTooltip;

  async function handleConfirmSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    setSignOutStuck(false);
    clearSignOutTimeout();
    signOutTimeoutRef.current = setTimeout(() => {
      signOutTimeoutRef.current = null;
      setSignOutStuck(true);
    }, SIGN_OUT_STUCK_TIMEOUT_MS);

    const startedAt = Date.now();
    try {
      // Ends any live call (and its telemetry) explicitly, before Firebase
      // sign-out, instead of leaving it to the unmount-cleanup fire-and-forget
      // path. Safe to call unconditionally - a no-op when no call is active.
      // endSession() never itself rejects (its own disconnect() failure is
      // caught+logged internally), so this can't short-circuit the try block
      // before signOut(auth) runs.
      await voice.endSession();
      logInfo("VoiceBar: signOut", `endSession resolved in ${Date.now() - startedAt}ms`);
      await signOut(auth);
      logInfo("VoiceBar: signOut", `signOut(auth) resolved, total ${Date.now() - startedAt}ms`);
      // AuthProvider's auth-state listener pushes set_panel_variant("setup"),
      // which swaps this component out - nothing else to do here on success.
      clearSignOutTimeout();
    } catch (err) {
      clearSignOutTimeout();
      logError("VoiceBar: signOut", err);
      setSignOutError(signOutCopy.error);
      setSigningOut(false);
      setSignOutStuck(false);
    }
  }

  function handleOpenConfirm() {
    setSignOutError(null);
    setConfirming(true);
  }

  function handleCancelSignOut() {
    clearSignOutTimeout();
    setConfirming(false);
    setSigningOut(false);
    setSignOutStuck(false);
    setSignOutError(null);
  }

  if (updatePrompt !== "hidden") {
    const busy = updatePrompt === "restarting";
    const outcome = updatePrompt === "deferred" ? updateCopy.deferred : updatePrompt === "failed" ? updateCopy.failed : null;
    return (
      <div className="voice-bar voice-bar-confirm">
        <span className="voice-bar-confirm-text">
          {busy ? updateCopy.restarting : (outcome ?? updateCopy.confirm(update.version ?? ""))}
        </span>
        <button type="button" className="voice-bar-confirm-cancel" onClick={() => setUpdatePrompt("hidden")} disabled={busy}>
          {outcome ? updateCopy.dismiss : updateCopy.later}
        </button>
        {!outcome && (
          <button type="button" className="voice-bar-confirm-update" onClick={handleInstallUpdate} disabled={busy}>
            {busy ? updateCopy.restartBusy : updateCopy.restartIdle}
          </button>
        )}
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="voice-bar voice-bar-confirm">
        <span className="voice-bar-confirm-text">
          {signOutStuck ? signOutCopy.stuck : (signOutError ?? signOutCopy.warning)}
        </span>
        <button
          type="button"
          className="voice-bar-confirm-cancel"
          onClick={handleCancelSignOut}
          disabled={signingOut && !signOutStuck}
        >
          {signOutStuck ? signOutCopy.dismiss : signOutCopy.cancel}
        </button>
        <button type="button" className="voice-bar-confirm-signout" onClick={() => void handleConfirmSignOut()} disabled={signingOut}>
          {signingOut ? signOutCopy.confirmBusy : signOutCopy.confirmIdle}
        </button>
      </div>
    );
  }

  return (
    <div className="voice-bar">
      <img src={iconUrl} alt="" className="voice-bar-icon" />
      <span
        className={`voice-bar-caption${voice.errorMessage ? " voice-bar-caption-error" : ""}${isSavedConfirmation ? " voice-bar-caption-saved" : ""}`}
        title={caption}
      >
        {caption}
      </span>

      {voice.showMicSettingsHint && (
        <BarIconButton title={copy.openMicSettingsTooltip} onClick={() => void openUrl("ms-settings:privacy-microphone")}>
          <SettingsIcon />
        </BarIconButton>
      )}

      <BarIconButton
        className="voice-bar-eye"
        title={screenSight.armed ? copy.screenSightOnTooltip : copy.screenSightOffTooltip}
        shortcut={hotkeyHints.screenSight.keys}
        active={screenSight.armed}
        onClick={screenSight.toggleArmed}
      >
        {screenSight.armed ? <IncognitoOnIcon /> : <IncognitoOffIcon />}
        <span className="bar-icon-button-dot" aria-hidden="true" />
      </BarIconButton>

      {isLive && (
        <BarIconButton title={copy.minimizeTooltip} onClick={handleMinimize}>
          <AvatarIcon />
        </BarIconButton>
      )}

      <BarIconButton className="voice-bar-mic" title={micTooltip} onClick={handleMicClick} active={isLive}>
        {isError ? <RefreshIcon /> : <WaveformIcon />}
      </BarIconButton>

      <span className="voice-bar-divider" />

      {update.version && !isLive && (
        <BarIconButton
          className="voice-bar-update"
          title={updateCopy.chipTooltip(update.version)}
          onClick={() => setUpdatePrompt("confirm")}
        >
          <UpdateIcon />
          <span className="bar-icon-button-dot" aria-hidden="true" />
        </BarIconButton>
      )}

      <BarIconButton title={copy.openDashboardTooltip} onClick={() => void openDashboard()}>
        <DashboardIcon />
      </BarIconButton>

      <BarIconButton
        title={feedbackJustSent ? copy.feedbackSentTooltip : copy.sendFeedbackTooltip}
        onClick={handleSendFeedback}
        disabled={feedbackSending}
      >
        <FeedbackIcon />
      </BarIconButton>

      <BarIconButton title={copy.signOutTooltip} onClick={handleOpenConfirm} danger>
        <SignOutIcon />
      </BarIconButton>
    </div>
  );
}
