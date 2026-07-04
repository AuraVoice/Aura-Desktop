import { useState } from "react";
import { signOut } from "firebase/auth";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { auth } from "../lib/firebase";
import { bar as copy, signOut as signOutCopy } from "../lib/copy";
import { logError } from "../lib/log";
import { EndCallIcon, EyeIcon, EyeOffIcon, MicIcon, MinimizeIcon, RefreshIcon, SettingsIcon, SignOutIcon } from "./icons";
import { BarIconButton } from "./BarIconButton";
import type { VoiceBarState } from "./useVoiceBar";
import iconUrl from "../assets/icons/Aura-Icon.png";
import "./VoiceBar.css";

interface VoiceBarProps {
  voice: VoiceBarState;
  screenSight: { armed: boolean; toggleArmed: () => void };
}

const LIVE_STATUSES = new Set(["connecting", "ready", "listening", "processing", "speaking"]);

export function VoiceBar({ voice, screenSight }: VoiceBarProps) {
  const [confirming, setConfirming] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);

  const isLive = LIVE_STATUSES.has(voice.status);
  const isError = voice.status === "error";
  const caption = voice.errorMessage ?? (voice.assistantCaption || "");

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

  const micTooltip = isError ? copy.micTryAgainTooltip : isLive ? copy.micEndCallTooltip : copy.micTalkTooltip;

  async function handleConfirmSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      await signOut(auth);
      // AuthProvider's auth-state listener pushes set_panel_variant("setup").
    } catch (err) {
      logError("VoiceBar: signOut", err);
      setSignOutError(signOutCopy.error);
      setSigningOut(false);
    }
  }

  if (confirming) {
    return (
      <div className="voice-bar voice-bar-confirm">
        <span className="voice-bar-confirm-text">
          {signOutError ?? signOutCopy.warning}
        </span>
        <button type="button" className="voice-bar-confirm-cancel" onClick={() => setConfirming(false)} disabled={signingOut}>
          {signOutCopy.cancel}
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
      <span className={`voice-bar-caption${voice.errorMessage ? " voice-bar-caption-error" : ""}`} title={caption}>{caption}</span>

      {voice.showMicSettingsHint && (
        <BarIconButton title={copy.openMicSettingsTooltip} onClick={() => void openUrl("ms-settings:privacy-microphone")}>
          <SettingsIcon />
        </BarIconButton>
      )}

      <BarIconButton
        title={screenSight.armed ? copy.screenSightOnTooltip : copy.screenSightOffTooltip}
        active={screenSight.armed}
        onClick={screenSight.toggleArmed}
      >
        {screenSight.armed ? <EyeIcon /> : <EyeOffIcon />}
      </BarIconButton>

      {isLive && (
        <BarIconButton title={copy.minimizeTooltip} onClick={handleMinimize}>
          <MinimizeIcon />
        </BarIconButton>
      )}

      <BarIconButton title={micTooltip} onClick={handleMicClick} danger={isLive}>
        {isError ? <RefreshIcon /> : isLive ? <EndCallIcon /> : <MicIcon />}
      </BarIconButton>

      <span className="voice-bar-divider" />

      <BarIconButton title={copy.signOutTooltip} onClick={() => setConfirming(true)}>
        <SignOutIcon />
      </BarIconButton>
    </div>
  );
}
