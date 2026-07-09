import { useCallback, useEffect, useRef, useState } from "react";
import { signOut } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { auth } from "../lib/firebase";
import { bar as copy, kebabMenu as kebabCopy, signOut as signOutCopy, update as updateCopy, hotkeyHints } from "../lib/copy";
import { logError, logInfo } from "../lib/log";
import { AvatarIcon, IncognitoOffIcon, IncognitoOnIcon, KebabIcon, RefreshIcon, SettingsIcon, UpdateIcon, WaveformIcon } from "./icons";
import { BarIconButton } from "./BarIconButton";
import { MeetingTicker } from "./MeetingTicker";
import type { SoonestMeeting } from "./useMeetings";
import type { VoiceBarState } from "./useVoiceBar";
import { useUpdateReady } from "./useUpdateReady";
import iconUrl from "../assets/icons/Aura-Icon.png";
import "./VoiceBar.css";

interface VoiceBarProps {
  voice: VoiceBarState;
  screenSight: { armed: boolean; toggleArmed: () => void; savedConfirmation: string | null };
  /** The imminent meeting, if any, for the caption-region ticker (null hides it). */
  soonestMeeting: SoonestMeeting | null;
  onDismissMeeting: (eventId: string) => void;
  /** Kebab overflow menu state, owned by OverlayRoot (the menu renders below
   * the bar, outside this subtree). */
  menuOpen: boolean;
  onToggleMenu: () => void;
  /** Set true by the kebab menu's Sign out; flips this bar into its confirm
   * takeover, then calls onSignOutConsumed to clear the request. */
  signOutRequested: boolean;
  onSignOutConsumed: () => void;
}

const LIVE_STATUSES = new Set(["connecting", "ready", "listening", "processing", "speaking"]);

// Covers both endSession() (the only genuinely network-touching step here,
// via LiveKit's room.disconnect()) and signOut(auth) (local-only, should
// resolve near-instantly) under one bound - a stale focus-forcing thread on
// the Rust side could otherwise leave this screen stuck with no way out.
const SIGN_OUT_STUCK_TIMEOUT_MS = 8_000;

export function VoiceBar({
  voice,
  screenSight,
  soonestMeeting,
  onDismissMeeting,
  menuOpen,
  onToggleMenu,
  signOutRequested,
  onSignOutConsumed,
}: VoiceBarProps) {
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [signOutStuck, setSignOutStuck] = useState(false);
  const signOutTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  // The kebab menu's Sign out lives outside this subtree; when it fires,
  // OverlayRoot raises signOutRequested and this bar takes over with its own
  // confirm UI, then clears the request.
  useEffect(() => {
    if (!signOutRequested) return;
    setSignOutError(null);
    setConfirming(true);
    onSignOutConsumed();
  }, [signOutRequested, onSignOutConsumed]);

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
      {/* Caption precedence: an error or a transient saved/update notice wins
          the region; otherwise an imminent meeting takes it as the ticker; a
          live call keeps it for Buddy's speech (isLive blocks the ticker). */}
      {!isLive && soonestMeeting && !voice.errorMessage && !isSavedConfirmation ? (
        <MeetingTicker soonest={soonestMeeting} onDismiss={onDismissMeeting} />
      ) : (
        <span
          className={`voice-bar-caption${voice.errorMessage ? " voice-bar-caption-error" : ""}${isSavedConfirmation ? " voice-bar-caption-saved" : ""}`}
          title={caption}
        >
          {caption}
        </span>
      )}

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

      {/* Always inline per the bar layout; only actionable during a live call
          (minimize_to_pill no-ops otherwise), so it's disabled when idle. */}
      <BarIconButton title={copy.minimizeTooltip} onClick={handleMinimize} disabled={!isLive}>
        <AvatarIcon />
      </BarIconButton>

      <BarIconButton className="voice-bar-mic" title={micTooltip} onClick={handleMicClick} active={isLive}>
        {isError ? <RefreshIcon /> : <WaveformIcon />}
      </BarIconButton>

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

      <span className="voice-bar-divider" />

      <BarIconButton title={kebabCopy.openTooltip} onClick={onToggleMenu} active={menuOpen}>
        <KebabIcon />
      </BarIconButton>
    </div>
  );
}
